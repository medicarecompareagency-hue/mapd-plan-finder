// scripts/enrich-dsnp-fulldual-strings-as-zero.js
//
// Companion to enrich-dsnp-fulldual-coins-as-zero.js. That script handles
// numeric copay fields. This one handles the string day-structure fields:
//   hospitalStayCopay      (b1a — Medicare Part A inpatient, 90 days)
//   skilledNursingCopay    (b2  — Medicare Part A SNF, 100 days)
//
// The main enrich-plan-copays-from-pbp.js only fills these when
// pbp_b1a_copay_yn === "1" (flat copay filed). Most DSNP plans don't —
// they either file as coinsurance or don't file a flat copay at all.
//
// For DSNP FULL_DUAL plans (QMB+/FBDE), Medicaid covers Medicare Part A
// cost-sharing — both the daily inpatient coinsurance ($800/day in 2026
// after day 60) AND the SNF coinsurance ($209.50/day after day 20). So
// member out-of-pocket is $0 across the full benefit period.
//
// Format matches the existing day-structure pattern so the ranking regex
// can parse the day-1 per-day rate:
//   hospitalStayCopay   -> "$0/day days 1-90"
//   skilledNursingCopay -> "$0/day days 1-100"
//
// PARTIAL_DUAL plans NOT touched (those members may pay coinsurance).
//
// Idempotent: only writes where the column is currently NULL or empty.
// Only writes for plans that have a row in the relevant PBP file (so we
// don't fabricate a benefit for plans that don't actually cover it —
// shouldn't happen for DSNP, but belt-and-suspenders).
//
// Usage (from repo root):
//   node scripts/enrich-dsnp-fulldual-strings-as-zero.js              # DRY RUN
//   node scripts/enrich-dsnp-fulldual-strings-as-zero.js --apply      # APPLY

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

// Files to scan. We just need to know which planIds have a row in each —
// no per-field analysis needed because Medicaid covers Part A regardless
// of how the plan files cost-sharing.
const FILES = [
  { dbField: "hospitalStayCopay",   file: "pbp_b1a_inpat_hosp.txt", value: "$0/day days 1-90" },
  { dbField: "skilledNursingCopay", file: "pbp_b2_snf.txt",         value: "$0/day days 1-100" },
];

// Build map: planId -> Set of dbField names where the plan has a PBP row
// (i.e. plan offers the benefit, even if cost-share isn't a flat copay).
function buildPlansWithBenefitMap() {
  const map = new Map();
  function add(planId, dbField) {
    let s = map.get(planId);
    if (!s) { s = new Set(); map.set(planId, s); }
    s.add(dbField);
  }
  for (const { dbField, file } of FILES) {
    log(`  ${file} ...`);
    for (const row of parseTSV(path.join(EXTRACT_DIR, file))) {
      const planId = dbPlanKey(row);
      if (!planId) continue;
      add(planId, dbField);
    }
  }
  return map;
}

const UNIQUE_FIELDS = FILES.map((f) => f.dbField);
const VALUE_BY_FIELD = Object.fromEntries(FILES.map((f) => [f.dbField, f.value]));

async function main() {
  log(line(), "c");
  log(`DSNP FULL_DUAL string-fields-as-$0 enrichment — planYear=${PLAN_YEAR} ${APPLY ? "(APPLY)" : "(DRY RUN)"}`, "c");
  log(line(), "c");

  if (!fs.existsSync(EXTRACT_DIR)) {
    log(`\nERROR: PBP extract dir not found at ${EXTRACT_DIR}`, "r");
    log(`Run this first: npx tsx scripts/prepare-pbp.ts ${PLAN_YEAR}`, "y");
    process.exit(1);
  }

  log("\nParsing PBP files for plan presence:", "c");
  const benefitMap = buildPlansWithBenefitMap();
  log(`\n${benefitMap.size.toLocaleString()} planIds have a row in at least one file`, "g");

  // Pull DSNP FULL_DUAL plans with at least one of the target string fields
  // null or empty.
  log("\nLoading DSNP FULL_DUAL plans needing enrichment...", "c");
  const nullClause = UNIQUE_FIELDS
    .map((f) => `"${f}" IS NULL OR "${f}" = ''`)
    .join(" OR ");
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
  log(`  ${planIds.length.toLocaleString()} distinct FULL_DUAL DSNP planIds with at least one null/empty string field`, "g");

  // Match against benefit-presence map.
  const plans = [];
  let unmatchable = 0;
  for (const pid of planIds) {
    const fields = benefitMap.get(pid);
    if (!fields || fields.size === 0) { unmatchable++; continue; }
    plans.push({ planId: pid, fields: [...fields] });
  }
  log(`  ${plans.length.toLocaleString()} matched to PBP rows for at least one field`, "g");
  log(`  ${unmatchable.toLocaleString()} had no PBP row in either file (left untouched)`, "y");

  // Per-field preview.
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

  log(`\nWriting $0 day-structure strings for ${plans.length.toLocaleString()} plans...`, "c");
  const startTime = Date.now();
  let done = 0;
  let totalCellsUpdated = 0;
  let totalRowsTouched = 0;
  let errors = 0;

  for (const { planId, fields } of plans) {
    // Use COALESCE(NULLIF(field, ''), $val) so we treat empty string the
    // same as null — matches the pattern in enrich-plan-copays-from-pbp.js.
    const params = [];
    let p = 1;
    const setParts = [];
    for (const f of fields) {
      setParts.push(`"${f}" = COALESCE(NULLIF("${f}", ''), $${p})`);
      params.push(VALUE_BY_FIELD[f]);
      p++;
    }
    params.push(planId);
    const planIdParam = `$${p}`;
    p++;
    params.push(PLAN_YEAR);
    const yearParam = `$${p}`;

    const sql =
      `UPDATE "Plan" SET ${setParts.join(", ")}
       WHERE "planId" = ${planIdParam}
         AND "planYear" = ${yearParam}
         AND "planCategory" = 'DSNP'
         AND "dsnpTargetGroup" = 'FULL_DUAL'`;

    try {
      const rowsAffected = await prisma.$executeRawUnsafe(sql, ...params);
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

  log("\nPost-enrichment DSNP FULL_DUAL string-field null-rates:", "c");
  for (const f of UNIQUE_FIELDS) {
    const r = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS total,
              SUM(CASE WHEN "${f}" IS NULL OR "${f}" = '' THEN 1 ELSE 0 END)::int AS nulls
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
