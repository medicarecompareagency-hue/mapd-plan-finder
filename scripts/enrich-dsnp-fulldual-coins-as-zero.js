// scripts/enrich-dsnp-fulldual-coins-as-zero.js
//
// Targeted follow-up to enrich-plan-copays-from-pbp.js.
//
// The main enrichment skips coinsurance-only PBP rows (copay_yn="2" AND
// coins_yn="1"). That's correct for non-DSNP plans — those members pay
// the coinsurance percentage, not a flat copay.
//
// For DSNP FULL_DUAL plans (QMB+, FBDE), the member's actual out-of-pocket
// for those services is $0 because Medicaid covers Part A and Part B
// cost-sharing. So for those plans only, this script writes 0 to the
// numeric copay columns when the PBP row is coinsurance-only.
//
// PARTIAL_DUAL plans (SLMB+, SLMB, QI-1) are NOT touched — those members
// often pay the coinsurance themselves.
//
// Numeric fields handled:
//   pcpCopay, specialistCopay, emergencyRoomCopay, ambulanceCopay,
//   outpatientHospitalCopay, mriCopay, catScanCopay
//
// String day-structure fields (hospitalStayCopay, skilledNursingCopay)
// are NOT handled here — they need their own pass to write something
// like "$0/day days 1-90". Tracked as a follow-up.
//
// Idempotent: only fills currently-NULL columns (COALESCE semantics).
//
// Usage (from repo root):
//   node scripts/enrich-dsnp-fulldual-coins-as-zero.js              # DRY RUN
//   node scripts/enrich-dsnp-fulldual-coins-as-zero.js --apply      # APPLY
//   node scripts/enrich-dsnp-fulldual-coins-as-zero.js --apply --year 2026

const fs = require("fs");
const path = require("path");
const { makePrisma } = require("./prisma-client");

const prisma = makePrisma();

const APPLY = process.argv.includes("--apply");
const yearArgIdx = process.argv.indexOf("--year");
const PLAN_YEAR = yearArgIdx >= 0 ? parseInt(process.argv[yearArgIdx + 1], 10) : 2026;

const EXTRACT_DIR = path.join(process.cwd(), ".cms-import-tmp", `pbp-${PLAN_YEAR}`);

const C = { g: "\x1b[32m", c: "\x1b[36m", y: "\x1b[33m", r: "\x1b[31m", z: "\x1b[0m" };
function log(msg, color) {
  const pfx = color ? C[color] || "" : "";
  console.log(`${pfx}${msg}${C.z}`);
}
function line(n = 64) { return "=".repeat(n); }

// Same parser as enrich-plan-copays-from-pbp.js — keep in sync.
function parseTSV(filePath) {
  if (!fs.existsSync(filePath)) {
    log(`  (skip) missing ${path.basename(filePath)}`, "y");
    return [];
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  if (lines.length === 0) return [];
  const headers = lines[0].split("\t").map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln) continue;
    const cells = ln.split("\t");
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = cells[j] !== undefined ? cells[j] : "";
    }
    rows.push(row);
  }
  return rows;
}

function dbPlanKey(row) {
  const h = row.pbp_a_hnumber;
  const p = row.pbp_a_plan_identifier;
  if (!h || !p) return null;
  const pNum = parseInt(String(p).trim(), 10);
  if (isNaN(pNum)) return null;
  return `${String(h).trim()}-${pNum}`;
}

// Service-to-PBP mapping. For each numeric copay field we want to fill,
// which file + yn fields tell us "coinsurance applies but no flat copay".
const SERVICES = [
  { dbField: "pcpCopay",                file: "pbp_b7_health_prof.txt",    copayYn: "pbp_b7a_copay_yn",  coinsYn: "pbp_b7a_coins_yn" },
  { dbField: "specialistCopay",         file: "pbp_b7_health_prof.txt",    copayYn: "pbp_b7b_copay_yn",  coinsYn: "pbp_b7b_coins_yn" },
  { dbField: "emergencyRoomCopay",      file: "pbp_b4_emerg_urgent.txt",   copayYn: "pbp_b4a_copay_yn",  coinsYn: "pbp_b4a_coins_yn" },
  { dbField: "ambulanceCopay",          file: "pbp_b10_amb_trans.txt",     copayYn: "pbp_b10a_copay_yn", coinsYn: "pbp_b10a_coins_yn" },
  { dbField: "outpatientHospitalCopay", file: "pbp_b9_outpat_hosp.txt",    copayYn: "pbp_b9a_copay_yn",  coinsYn: "pbp_b9a_coins_yn" },
  // MRI and CAT both share b8a (b8b fallback handled by the main enrichment;
  // we only care about the b8a coinsurance-only case here).
  { dbField: "mriCopay",                file: "pbp_b8_clin_diag_ther.txt", copayYn: "pbp_b8a_copay_yn",  coinsYn: "pbp_b8a_coins_yn" },
  { dbField: "catScanCopay",            file: "pbp_b8_clin_diag_ther.txt", copayYn: "pbp_b8a_copay_yn",  coinsYn: "pbp_b8a_coins_yn" },
];
const UNIQUE_FIELDS = [...new Set(SERVICES.map((s) => s.dbField))];

// Build map: planId -> Set of dbField names where the plan files
// "coinsurance-only" cost-sharing in PBP.
function buildCoinsuranceMap() {
  const map = new Map();
  function add(planId, dbField) {
    let s = map.get(planId);
    if (!s) { s = new Set(); map.set(planId, s); }
    s.add(dbField);
  }
  // Group by file so we read each file just once.
  const byFile = new Map();
  for (const svc of SERVICES) {
    if (!byFile.has(svc.file)) byFile.set(svc.file, []);
    byFile.get(svc.file).push(svc);
  }
  for (const [file, services] of byFile) {
    log(`  ${file} ...`);
    for (const row of parseTSV(path.join(EXTRACT_DIR, file))) {
      const planId = dbPlanKey(row);
      if (!planId) continue;
      for (const svc of services) {
        if (row[svc.copayYn] === "2" && row[svc.coinsYn] === "1") {
          add(planId, svc.dbField);
        }
      }
    }
  }
  return map;
}

async function main() {
  log(line(), "c");
  log(`DSNP FULL_DUAL coinsurance-as-$0 enrichment — planYear=${PLAN_YEAR} ${APPLY ? "(APPLY)" : "(DRY RUN)"}`, "c");
  log(line(), "c");

  if (!fs.existsSync(EXTRACT_DIR)) {
    log(`\nERROR: PBP extract dir not found at ${EXTRACT_DIR}`, "r");
    log(`Run this first: npx tsx scripts/prepare-pbp.ts ${PLAN_YEAR}`, "y");
    process.exit(1);
  }

  log("\nParsing PBP files for coinsurance-only services:", "c");
  const coinsMap = buildCoinsuranceMap();
  log(`\n${coinsMap.size.toLocaleString()} planIds have at least one coinsurance-only service`, "g");

  // Pull DSNP FULL_DUAL plans with at least one of the target fields null.
  log("\nLoading DSNP FULL_DUAL plans needing enrichment...", "c");
  const nullClause = UNIQUE_FIELDS.map((f) => `"${f}" IS NULL`).join(" OR ");
  const planRows = await prisma.$queryRawUnsafe(
    `SELECT DISTINCT "planId"
     FROM "Plan"
     WHERE "planYear" = $1
       AND "planCategory" = 'DSNP'
       AND "dsnpTargetGroup" = 'FULL_DUAL'
       AND (${nullClause})`,
    PLAN_YEAR,
  );
  const planIds = planRows.map((r) => r.planId);
  log(`  ${planIds.length.toLocaleString()} distinct FULL_DUAL DSNP planIds with at least one null`, "g");

  // Match against coinsurance map.
  const plans = [];
  let unmatchable = 0;
  for (const pid of planIds) {
    const fields = coinsMap.get(pid);
    if (!fields || fields.size === 0) { unmatchable++; continue; }
    plans.push({ planId: pid, fields: [...fields] });
  }
  log(`  ${plans.length.toLocaleString()} matched to coinsurance-only PBP rows`, "g");
  log(`  ${unmatchable.toLocaleString()} had no coinsurance-only services in PBP (left untouched)`, "y");

  // Per-field preview: how many plans we'll write each field for.
  log("\nPreview: plans-affected per field...", "c");
  for (const f of UNIQUE_FIELDS) {
    const count = plans.filter((p) => p.fields.includes(f)).length;
    log(`  ${f.padEnd(28)} ${count.toLocaleString().padStart(6)} plans`);
  }

  if (!APPLY) {
    log(`\nDRY RUN. Re-run with --apply to actually UPDATE.`, "c");
    await prisma.$disconnect();
    return;
  }

  if (plans.length === 0) {
    log(`\nNothing to enrich.`, "g");
    await prisma.$disconnect();
    return;
  }

  // Apply.
  log(`\nWriting 0 to coinsurance-only fields for ${plans.length.toLocaleString()} plans...`, "c");
  const startTime = Date.now();
  let done = 0;
  let totalCellsUpdated = 0;
  let totalRowsTouched = 0;
  let errors = 0;

  for (const { planId, fields } of plans) {
    const setParts = fields.map((f) => `"${f}" = COALESCE("${f}", 0)`);
    const sql =
      `UPDATE "Plan" SET ${setParts.join(", ")}
       WHERE "planId" = $1
         AND "planYear" = $2
         AND "planCategory" = 'DSNP'
         AND "dsnpTargetGroup" = 'FULL_DUAL'`;
    try {
      const rowsAffected = await prisma.$executeRawUnsafe(sql, planId, PLAN_YEAR);
      const touched = Number(rowsAffected);
      totalRowsTouched += touched;
      totalCellsUpdated += touched * setParts.length;
    } catch (e) {
      errors++;
      if (errors <= 5) log(`  error on planId=${planId}: ${e.message}`, "r");
    }
    done++;
    if (done % 250 === 0 || done === plans.length) {
      const pct = ((done / plans.length) * 100).toFixed(1);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      log(`  ${done.toLocaleString()} / ${plans.length.toLocaleString()} planIds (${pct}%) — ${elapsed}s`, "c");
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  log(`\nDone in ${elapsed}s`, "g");
  log(`  plans processed:         ${plans.length.toLocaleString()}`, "g");
  log(`  plan-rows touched:       ${totalRowsTouched.toLocaleString()}`, "g");
  log(`  cells updated:           ${totalCellsUpdated.toLocaleString()}`, "g");
  if (errors > 0) log(`  errors: ${errors}`, "r");

  // Verification: post-enrichment null-rates for FULL_DUAL DSNP.
  log("\nPost-enrichment DSNP FULL_DUAL null-rates:", "c");
  for (const f of UNIQUE_FIELDS) {
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
    const pct = total > 0 ? ((nulls / total) * 100).toFixed(0) : "0";
    log(`  ${f.padEnd(28)} ${String(nulls).padStart(6)}/${String(total).padStart(6)} null (${pct.padStart(3)}%)`);
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
