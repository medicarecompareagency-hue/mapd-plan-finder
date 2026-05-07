// scripts/enrich-dsnp-fulldual-residual-nulls.js
//
// Final pass after enrich-dsnp-fulldual-coins-as-zero.js (2026-05-05).
// That script filled NULLs only where PBP filed coinsurance-only cost-sharing.
// This script handles the residual case: FULL_DUAL DSNP plans where CMS
// filed NEITHER a copay NOR coinsurance for a service (pure data gap).
//
// Industry rule: FULL_DUAL beneficiaries (QMB+, FBDE) have $0 cost-share
// for Part A and Part B services regardless of what the carrier filed,
// because Medicaid covers the gap. So filling 0 on residual NULLs is
// correct for these plans.
//
// PARTIAL_DUAL plans (SLMB+, SLMB, QI-1) are NOT touched — those members
// pay actual cost-shares.
//
// Numeric fields only. String day-structure fields (hospitalStayCopay,
// skilledNursingCopay) need a separate pass and aren't in scope here.
//
// Idempotent: COALESCE semantics — only writes to currently-NULL columns.
//
// Usage (from repo root):
//   node scripts/enrich-dsnp-fulldual-residual-nulls.js              # DRY RUN
//   node scripts/enrich-dsnp-fulldual-residual-nulls.js --apply      # APPLY
//   node scripts/enrich-dsnp-fulldual-residual-nulls.js --apply --year 2026

const { makePrisma } = require("./prisma-client");

const prisma = makePrisma();

const APPLY = process.argv.includes("--apply");
const yearArgIdx = process.argv.indexOf("--year");
const PLAN_YEAR = yearArgIdx >= 0 ? parseInt(process.argv[yearArgIdx + 1], 10) : 2026;

const C = { g: "\x1b[32m", c: "\x1b[36m", y: "\x1b[33m", r: "\x1b[31m", z: "\x1b[0m" };
function log(msg, color) {
  const pfx = color ? C[color] || "" : "";
  console.log(`${pfx}${msg}${C.z}`);
}
function line(n = 64) { return "=".repeat(n); }

// Numeric copay fields where $0 is the correct FULL_DUAL value.
// MOOP and deductibles deliberately excluded — they're plan-design fields,
// not cost-share fields, and a NULL there means something different.
const FIELDS = [
  "pcpCopay",
  "specialistCopay",
  "emergencyRoomCopay",
  "ambulanceCopay",
  "outpatientHospitalCopay",
  "mriCopay",
  "catScanCopay",
];

async function main() {
  log(line(), "c");
  log(`DSNP FULL_DUAL residual-NULL fill — planYear=${PLAN_YEAR} ${APPLY ? "(APPLY)" : "(DRY RUN)"}`, "c");
  log(line(), "c");

  // Pre-state: how many NULLs per field on FULL_DUAL DSNP.
  log("\nPre-state DSNP FULL_DUAL null-rates:", "c");
  const preStats = {};
  for (const f of FIELDS) {
    const r = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS total,
              SUM(CASE WHEN "${f}" IS NULL THEN 1 ELSE 0 END)::int AS nulls
       FROM "Plan"
       WHERE "planYear" = $1
         AND "planCategory" = 'DSNP'
         AND "dsnpTargetGroup" = 'FULL_DUAL'`,
      PLAN_YEAR,
    );
    const total = Number(r[0]?.total || 0);
    const nulls = Number(r[0]?.nulls || 0);
    const pct = total > 0 ? ((nulls / total) * 100).toFixed(1) : "0.0";
    preStats[f] = { total, nulls };
    log(`  ${f.padEnd(28)} ${String(nulls).padStart(6)}/${String(total).padStart(6)} null (${pct.padStart(4)}%)`);
  }

  // Distinct planIds with at least one residual NULL.
  const nullClause = FIELDS.map((f) => `"${f}" IS NULL`).join(" OR ");
  const planRows = await prisma.$queryRawUnsafe(
    `SELECT DISTINCT "planId"
     FROM "Plan"
     WHERE "planYear" = $1
       AND "planCategory" = 'DSNP'
       AND "dsnpTargetGroup" = 'FULL_DUAL'
       AND (${nullClause})`,
    PLAN_YEAR,
  );
  log(`\n${planRows.length.toLocaleString()} distinct FULL_DUAL DSNP planIds have at least one residual NULL`, "g");

  if (!APPLY) {
    log(`\nDRY RUN. Re-run with --apply to fill these to 0.`, "c");
    await prisma.$disconnect();
    return;
  }

  if (planRows.length === 0) {
    log(`\nNothing to fill.`, "g");
    await prisma.$disconnect();
    return;
  }

  // Single bulk UPDATE — COALESCE on every field, scoped to FULL_DUAL DSNP.
  // Faster than per-planId loop since this is straight $0 fill.
  log(`\nFilling residual NULLs to 0 across all FULL_DUAL DSNP rows...`, "c");
  const setParts = FIELDS.map((f) => `"${f}" = COALESCE("${f}", 0)`);
  const sql =
    `UPDATE "Plan" SET ${setParts.join(", ")}
     WHERE "planYear" = $1
       AND "planCategory" = 'DSNP'
       AND "dsnpTargetGroup" = 'FULL_DUAL'`;
  const startTime = Date.now();
  const rowsAffected = await prisma.$executeRawUnsafe(sql, PLAN_YEAR);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  log(`\nDone in ${elapsed}s`, "g");
  log(`  rows touched: ${Number(rowsAffected).toLocaleString()}`, "g");

  // Post-state verification.
  log("\nPost-state DSNP FULL_DUAL null-rates:", "c");
  let totalCellsFilled = 0;
  for (const f of FIELDS) {
    const r = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS total,
              SUM(CASE WHEN "${f}" IS NULL THEN 1 ELSE 0 END)::int AS nulls
       FROM "Plan"
       WHERE "planYear" = $1
         AND "planCategory" = 'DSNP'
         AND "dsnpTargetGroup" = 'FULL_DUAL'`,
      PLAN_YEAR,
    );
    const total = Number(r[0]?.total || 0);
    const nulls = Number(r[0]?.nulls || 0);
    const pct = total > 0 ? ((nulls / total) * 100).toFixed(1) : "0.0";
    const filled = preStats[f].nulls - nulls;
    totalCellsFilled += filled;
    log(`  ${f.padEnd(28)} ${String(nulls).padStart(6)}/${String(total).padStart(6)} null (${pct.padStart(4)}%)  filled: +${filled.toLocaleString()}`);
  }
  log(`\nTotal cells filled to 0: ${totalCellsFilled.toLocaleString()}`, "g");

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
