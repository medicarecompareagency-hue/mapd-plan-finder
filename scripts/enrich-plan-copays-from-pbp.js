// scripts/enrich-plan-copays-from-pbp.js
//
// One-shot enrichment: fill in missing copay fields on existing Plan rows
// by reading the raw CMS PBP benefit files and UPDATE-ing only where the
// DB currently has NULL.
//
// Why we need this:
//   backfill-missing-plans.ts creates Plan rows from Section A + PlanArea
//   without populating service-level copays. That leaves 100% of HMO,
//   HMOPOS, MMP, PACE, 1876 Cost rows with null pcpCopay/specialistCopay/
//   MRI/CAT/drug tiers. This script closes that gap without a full
//   re-import.
//
// Non-destructive: uses COALESCE semantics, so if a field already has a
// value in the DB we leave it alone. Only null cells get filled.
//
// Prereqs:
//   1. PBP files must already be extracted to .cms-import-tmp/pbp-2026/
//      (run `npx tsx scripts/prepare-pbp.ts 2026` if not).
//
// Usage (from repo root):
//   node scripts/enrich-plan-copays-from-pbp.js                # dry run
//   node scripts/enrich-plan-copays-from-pbp.js --apply        # write to DB
//   node scripts/enrich-plan-copays-from-pbp.js --apply --year 2026
//
// Safe to re-run: idempotent. Only touches NULL fields.

const fs = require("fs");
const path = require("path");
const { makePrisma } = require("./prisma-client");

const prisma = makePrisma();

// ---------- args ----------
const APPLY = process.argv.includes("--apply");
const yearArgIdx = process.argv.indexOf("--year");
const PLAN_YEAR =
  yearArgIdx >= 0 ? parseInt(process.argv[yearArgIdx + 1], 10) : 2026;

const EXTRACT_DIR = path.join(
  process.cwd(),
  ".cms-import-tmp",
  `pbp-${PLAN_YEAR}`,
);

// ---------- logging ----------
const C = { g: "\x1b[32m", c: "\x1b[36m", y: "\x1b[33m", r: "\x1b[31m", z: "\x1b[0m" };
function log(msg, color) {
  const pfx = color ? C[color] || "" : "";
  console.log(`${pfx}${msg}${C.z}`);
}
function line(n = 64) { return "=".repeat(n); }

// ---------- tiny TSV parser ----------
// PBP files are plain tab-delimited with a header row. No quoting.
function parseTSV(filePath) {
  if (!fs.existsSync(filePath)) {
    log(`  (skip) missing ${path.basename(filePath)}`, "y");
    return [];
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  // Normalize Windows line endings, then split.
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

function num(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === "") return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// DB planId format: "${hnumber}-${parseInt(plan_identifier, 10)}"
// (no zero-padding on the plan portion — see import-cms-data.ts L879 and
// backfill-missing-plans.ts L388).
function dbPlanKey(row) {
  const h = row.pbp_a_hnumber;
  const p = row.pbp_a_plan_identifier;
  if (!h || !p) return null;
  const pNum = parseInt(String(p).trim(), 10);
  if (isNaN(pNum)) return null;
  return `${String(h).trim()}-${pNum}`;
}

// ---------- per-day copay string (for hospital + SNF) ----------
function buildDayStructure(row, prefix, tier) {
  const parts = [];
  for (let i = 1; i <= 3; i++) {
    const amt = num(row[`${prefix}_amt_int${i}${tier}`]);
    const bgn = row[`${prefix}_bgnd_int${i}${tier}`];
    const end = row[`${prefix}_endd_int${i}${tier}`];
    if (amt !== null && bgn && end) {
      parts.push(`$${amt}/day days ${bgn}-${end}`);
    }
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

// ---------- build benefit map keyed on DB-style planId ----------
// Segments are merged: later non-null values don't overwrite earlier ones,
// so the first segment encountered wins for each field. This matches the
// original importer's effective behavior (segment "0" is parsed first).
function buildBenefitMap() {
  const map = new Map();

  function getOrCreate(key) {
    if (!map.has(key)) {
      map.set(key, {
        pcpCopay: null,
        specialistCopay: null,
        emergencyRoomCopay: null,
        ambulanceCopay: null,
        outpatientHospitalCopay: null,
        hospitalStayCopay: null,
        skilledNursingCopay: null,
        mriCopay: null,
        catScanCopay: null,
        drugDeductible: null,
        drugTier1Copay: null,
        drugTier2Copay: null,
        drugTier3Copay: null,
        drugTier4Copay: null,
        drugTier5Copay: null,
        drugTier6Copay: null,
        // Set of tier numbers (1-6) whose value came from a coinsurance
        // column rather than a flat copay column. We flatten this into
        // the string mask (e.g. "45") before writing to the DB.
        _coinsuranceTiers: new Set(),
      });
    }
    return map.get(key);
  }

  // Only overwrite if current value is null — so the first segment wins.
  function mergeIfNull(b, field, val) {
    if (val === null || val === undefined) return;
    if (b[field] === null || b[field] === undefined) {
      b[field] = val;
    }
  }

  log("\nParsing PBP files from " + EXTRACT_DIR, "c");
  log(line(), "c");

  // b7: PCP (b7a) and Specialist (b7b)
  //
  // CMS _copay_yn convention:
  //   "1" = plan DOES charge a copay (amount is in _copay_amt_*)
  //   "2" = plan does NOT charge a copay → member cost is $0 for that
  //         service (unless _coins_yn='1' separately, which means the
  //         plan uses coinsurance % instead of a flat copay).
  //
  // Previously we only handled "1" and left "2" as null → UI showed N/A
  // even though the plan actually charges $0. Now we also honor "2" as 0,
  // but ONLY when the plan isn't using coinsurance for that service.
  // Coinsurance-only plans still need service-level coinsurance handling
  // (tracked separately — not in scope for this pass).
  log("  pbp_b7_health_prof.txt ...");
  for (const row of parseTSV(path.join(EXTRACT_DIR, "pbp_b7_health_prof.txt"))) {
    const k = dbPlanKey(row);
    if (!k) continue;
    const b = getOrCreate(k);
    // PCP
    if (row.pbp_b7a_copay_yn === "1") {
      mergeIfNull(b, "pcpCopay", num(row.pbp_b7a_copay_amt_mc_min));
    } else if (row.pbp_b7a_copay_yn === "2" && row.pbp_b7a_coins_yn !== "1") {
      mergeIfNull(b, "pcpCopay", 0);
    }
    // Specialist
    if (row.pbp_b7b_copay_yn === "1") {
      mergeIfNull(b, "specialistCopay", num(row.pbp_b7b_copay_mc_amt_min));
    } else if (row.pbp_b7b_copay_yn === "2" && row.pbp_b7b_coins_yn !== "1") {
      mergeIfNull(b, "specialistCopay", 0);
    }
  }

  // b4: Emergency
  log("  pbp_b4_emerg_urgent.txt ...");
  for (const row of parseTSV(path.join(EXTRACT_DIR, "pbp_b4_emerg_urgent.txt"))) {
    const k = dbPlanKey(row);
    if (!k) continue;
    const b = getOrCreate(k);
    if (row.pbp_b4a_copay_yn === "1") {
      mergeIfNull(b, "emergencyRoomCopay", num(row.pbp_b4a_copay_amt_mc_min));
    } else if (row.pbp_b4a_copay_yn === "2" && row.pbp_b4a_coins_yn !== "1") {
      mergeIfNull(b, "emergencyRoomCopay", 0);
    }
  }

  // b10: Ambulance (b10a)
  log("  pbp_b10_amb_trans.txt ...");
  for (const row of parseTSV(path.join(EXTRACT_DIR, "pbp_b10_amb_trans.txt"))) {
    const k = dbPlanKey(row);
    if (!k) continue;
    const b = getOrCreate(k);
    if (row.pbp_b10a_copay_yn === "1") {
      mergeIfNull(b, "ambulanceCopay", num(row.pbp_b10a_copay_gas_amt_min));
    } else if (row.pbp_b10a_copay_yn === "2" && row.pbp_b10a_coins_yn !== "1") {
      mergeIfNull(b, "ambulanceCopay", 0);
    }
  }

  // b9: Outpatient hospital
  log("  pbp_b9_outpat_hosp.txt ...");
  for (const row of parseTSV(path.join(EXTRACT_DIR, "pbp_b9_outpat_hosp.txt"))) {
    const k = dbPlanKey(row);
    if (!k) continue;
    const b = getOrCreate(k);
    if (row.pbp_b9a_copay_yn === "1") {
      const v = num(row.pbp_b9a_copay_ohs_amt_max) ?? num(row.pbp_b9a_copay_ohs_amt_min);
      mergeIfNull(b, "outpatientHospitalCopay", v);
    } else if (row.pbp_b9a_copay_yn === "2" && row.pbp_b9a_coins_yn !== "1") {
      mergeIfNull(b, "outpatientHospitalCopay", 0);
    }
  }

  // b1a: Inpatient hospital — per-day structure string
  log("  pbp_b1a_inpat_hosp.txt ...");
  for (const row of parseTSV(path.join(EXTRACT_DIR, "pbp_b1a_inpat_hosp.txt"))) {
    const k = dbPlanKey(row);
    if (!k) continue;
    const b = getOrCreate(k);
    if (row.pbp_b1a_copay_yn === "1") {
      mergeIfNull(b, "hospitalStayCopay", buildDayStructure(row, "pbp_b1a_copay_mcs", "_t1"));
    }
  }

  // b2: SNF — per-day structure string
  log("  pbp_b2_snf.txt ...");
  for (const row of parseTSV(path.join(EXTRACT_DIR, "pbp_b2_snf.txt"))) {
    const k = dbPlanKey(row);
    if (!k) continue;
    const b = getOrCreate(k);
    if (row.pbp_b2_copay_yn === "1") {
      mergeIfNull(b, "skilledNursingCopay", buildDayStructure(row, "pbp_b2_copay_mcs", "_t1"));
    }
  }

  // b8: MRI / CAT (diagnostic radiology — b8a is the "right" bucket; b8b
  // is diagnostic radiology services at physician's office, used as
  // fallback when b8a is empty).
  log("  pbp_b8_clin_diag_ther.txt ...");
  for (const row of parseTSV(path.join(EXTRACT_DIR, "pbp_b8_clin_diag_ther.txt"))) {
    const k = dbPlanKey(row);
    if (!k) continue;
    const b = getOrCreate(k);
    if (row.pbp_b8a_copay_yn === "1") {
      const v = num(row.pbp_b8a_copay_max_dmc_amt) ?? num(row.pbp_b8a_copay_min_dmc_amt);
      mergeIfNull(b, "mriCopay", v);
      mergeIfNull(b, "catScanCopay", v);
    } else if (row.pbp_b8a_copay_yn === "2" && row.pbp_b8a_coins_yn !== "1") {
      mergeIfNull(b, "mriCopay", 0);
      mergeIfNull(b, "catScanCopay", 0);
    }
    if (row.pbp_b8b_copay_yn === "1") {
      const drs = num(row.pbp_b8b_copay_amt_drs);
      if (drs !== null) {
        mergeIfNull(b, "mriCopay", drs);
        mergeIfNull(b, "catScanCopay", drs);
      }
    } else if (row.pbp_b8b_copay_yn === "2" && row.pbp_b8b_coins_yn !== "1") {
      mergeIfNull(b, "mriCopay", 0);
      mergeIfNull(b, "catScanCopay", 0);
    }
  }

  // mrx: Drug deductible
  log("  pbp_mrx.txt ...");
  for (const row of parseTSV(path.join(EXTRACT_DIR, "pbp_mrx.txt"))) {
    const k = dbPlanKey(row);
    if (!k) continue;
    const b = getOrCreate(k);
    if (row.mrx_alt_ded_charge === "2") {
      mergeIfNull(b, "drugDeductible", num(row.mrx_alt_ded_amount) ?? 0);
    } else {
      mergeIfNull(b, "drugDeductible", 0);
    }
  }

  // mrx_tier: Drug tier 1-6 copays
  // CMS column naming: "rsstd" = Retail Standard, "rspfd" = Retail Preferred
  // (NOT "rstd" — that typo in the legacy import-cms-data.ts is why every
  // drug-tier field was null for the last year).
  //
  // Precedence (matches what medicare.gov surfaces as the primary price):
  //   1. Retail preferred flat copay (most plans market the preferred rate)
  //   2. Retail standard flat copay (fallback for standard-only plans)
  //   3. Retail preferred coinsurance % (for non-preferred/specialty tiers)
  //   4. Retail standard coinsurance %
  // For coinsurance-only tiers the value is a percent (e.g. 50 = 50%).
  // The UI renders it as "$50" today, which is a known display issue to
  // address separately — but it beats showing N/A.
  log("  pbp_mrx_tier.txt ...");
  for (const row of parseTSV(path.join(EXTRACT_DIR, "pbp_mrx_tier.txt"))) {
    const k = dbPlanKey(row);
    if (!k) continue;
    const b = getOrCreate(k);
    const tierId = row.mrx_tier_id;

    // Try flat copay first (preferred retail, then standard retail).
    let copay = num(row.mrx_tier_rspfd_copay_1m);
    if (copay === null) copay = num(row.mrx_tier_rsstd_copay_1m);

    // If no flat copay, fall back to coinsurance % (preferred, then standard).
    // Flag the tier as coinsurance so the UI renders it with "%" instead of "$".
    let isCoinsurance = false;
    if (copay === null) {
      copay = num(row.mrx_tier_rspfd_coins_1m);
      if (copay === null) copay = num(row.mrx_tier_rsstd_coins_1m);
      if (copay !== null) isCoinsurance = true;
    }
    if (copay === null) continue;

    const tierNum = parseInt(tierId, 10);
    if (isNaN(tierNum) || tierNum < 1 || tierNum > 6) continue;

    const fieldName = `drugTier${tierNum}Copay`;
    // Only track the coinsurance flag if THIS write is the one that sets
    // the value. If a previous segment already populated a flat copay,
    // we should NOT flag the tier as coinsurance.
    const willWrite = b[fieldName] === null || b[fieldName] === undefined;
    mergeIfNull(b, fieldName, copay);
    if (willWrite && isCoinsurance) {
      b._coinsuranceTiers.add(tierNum);
    }
  }

  return map;
}

// ---------- field metadata ----------
// Numeric copay fields (Float columns). drugDeductible excluded because
// the DB default is 0, and 0 is a legitimate value — we shouldn't overwrite
// it either way, and the columns is rarely missing to begin with.
const NUM_FIELDS = [
  "pcpCopay",
  "specialistCopay",
  "emergencyRoomCopay",
  "ambulanceCopay",
  "outpatientHospitalCopay",
  "mriCopay",
  "catScanCopay",
  "drugTier1Copay",
  "drugTier2Copay",
  "drugTier3Copay",
  "drugTier4Copay",
  "drugTier5Copay",
  "drugTier6Copay",
];
const STR_FIELDS = ["hospitalStayCopay", "skilledNursingCopay"];
// drugTierCoinsuranceMask is derived from the _coinsuranceTiers Set rather
// than being read as a column from PBP. It's a String? like "45" meaning
// tiers 4 and 5 are coinsurance percentages rather than flat copays.
const MASK_FIELD = "drugTierCoinsuranceMask";
const ALL_FIELDS = [...NUM_FIELDS, ...STR_FIELDS];

// ---------- main ----------
async function main() {
  log(line(), "c");
  log(`PBP COPAY ENRICHMENT — planYear=${PLAN_YEAR} ${APPLY ? "(APPLY)" : "(DRY RUN)"}`, "c");
  log(line(), "c");

  if (!fs.existsSync(EXTRACT_DIR)) {
    log(`\nERROR: PBP extract dir not found at ${EXTRACT_DIR}`, "r");
    log(`Run this first to download + unzip the PBP files:`, "y");
    log(`    npx tsx scripts/prepare-pbp.ts ${PLAN_YEAR}`, "y");
    process.exit(1);
  }

  const benefitMap = buildBenefitMap();
  log(`\nBuilt benefit map: ${benefitMap.size.toLocaleString()} unique contract-plan keys`, "g");

  // Load distinct plan IDs from DB that need enrichment (at least one copay is null).
  log("\nScanning Plan table for rows with missing copays...", "c");

  // Build the OR clause for "at least one of these is null".
  const nullClause = ALL_FIELDS.map((f) => `"${f}" IS NULL`).join(" OR ");
  const distinctRows = await prisma.$queryRawUnsafe(
    `SELECT DISTINCT "planId"
     FROM "Plan"
     WHERE "planYear" = $1
       AND (${nullClause})`,
    PLAN_YEAR,
  );
  const distinctPlanIds = distinctRows.map((r) => r.planId);
  log(`  ${distinctPlanIds.length.toLocaleString()} distinct planIds need enrichment`, "g");

  // Figure out which are matchable from PBP data.
  let matchable = 0;
  let unmatchable = 0;
  const plans = [];
  for (const pid of distinctPlanIds) {
    const b = benefitMap.get(pid);
    if (!b) { unmatchable++; continue; }
    // Does this benefit record actually have anything non-null to contribute?
    const hasAny = ALL_FIELDS.some((f) => b[f] !== null && b[f] !== undefined);
    if (!hasAny) { unmatchable++; continue; }
    matchable++;
    plans.push({ planId: pid, benefits: b });
  }
  log(`  ${matchable.toLocaleString()} matched to PBP benefit records`, "g");
  log(`  ${unmatchable.toLocaleString()} had no PBP match or no benefit data`, "y");

  // Preview: estimate how many cells we'll fill.
  log("\nPreview: cells-to-fill per field (across all rows with this planId)...", "c");
  const perFieldCounts = {};
  for (const f of ALL_FIELDS) perFieldCounts[f] = 0;
  perFieldCounts[MASK_FIELD] = 0;

  // Count affected rows per planId once.
  const rowCountRows = await prisma.$queryRawUnsafe(
    `SELECT "planId", COUNT(*)::int AS n
     FROM "Plan"
     WHERE "planYear" = $1
     GROUP BY "planId"`,
    PLAN_YEAR,
  );
  const rowCountByPlanId = new Map();
  for (const r of rowCountRows) rowCountByPlanId.set(r.planId, Number(r.n));

  // For perfectly accurate counts we'd need per-plan per-field null counts.
  // Close-enough estimate: for each matched planId, multiply row count by
  // the number of fields we have non-null benefits for. This over-estimates
  // slightly (some fields may already be filled in the DB) but is directional.
  for (const { planId, benefits } of plans) {
    const rowsForPlan = rowCountByPlanId.get(planId) || 0;
    for (const f of ALL_FIELDS) {
      if (benefits[f] !== null && benefits[f] !== undefined) {
        perFieldCounts[f] += rowsForPlan;
      }
    }
    if (benefits._coinsuranceTiers && benefits._coinsuranceTiers.size > 0) {
      perFieldCounts[MASK_FIELD] += rowsForPlan;
    }
  }
  for (const f of ALL_FIELDS) {
    log(`  ${f.padEnd(28)} up to ${perFieldCounts[f].toLocaleString().padStart(8)} cells could be filled`);
  }
  log(`  ${MASK_FIELD.padEnd(28)} up to ${perFieldCounts[MASK_FIELD].toLocaleString().padStart(8)} cells could be filled`);

  if (!APPLY) {
    log(`\nDRY RUN. Re-run with --apply to actually UPDATE.`, "c");
    return;
  }

  if (plans.length === 0) {
    log(`\nNothing to enrich — no matched plans with benefit data.`, "g");
    return;
  }

  // ---------- APPLY ----------
  log(`\nEnriching ${plans.length.toLocaleString()} plans...`, "c");
  const startTime = Date.now();
  let done = 0;
  let totalCellsUpdated = 0;
  let totalRowsTouched = 0;
  let errors = 0;

  // One UPDATE per planId. Each UPDATE sets every field with COALESCE
  // semantics — i.e. only overwrites if the column is currently NULL.
  // For string columns, also treat empty string as null-equivalent.
  for (const { planId, benefits } of plans) {
    // Build SET clause dynamically from fields where we have a value.
    const setParts = [];
    const params = [];
    let p = 1;

    for (const f of NUM_FIELDS) {
      const v = benefits[f];
      if (v === null || v === undefined) continue;
      setParts.push(`"${f}" = COALESCE("${f}", $${p})`);
      params.push(v);
      p++;
    }
    for (const f of STR_FIELDS) {
      const v = benefits[f];
      if (v === null || v === undefined) continue;
      setParts.push(`"${f}" = COALESCE(NULLIF("${f}", ''), $${p})`);
      params.push(v);
      p++;
    }
    // Coinsurance mask: derived from the Set of tiers we enriched as
    // percentages. Sorted ascending so the mask is stable ("45", not "54").
    if (benefits._coinsuranceTiers && benefits._coinsuranceTiers.size > 0) {
      const mask = [...benefits._coinsuranceTiers].sort((a, b) => a - b).join("");
      setParts.push(`"${MASK_FIELD}" = COALESCE(NULLIF("${MASK_FIELD}", ''), $${p})`);
      params.push(mask);
      p++;
    }

    if (setParts.length === 0) { done++; continue; }

    params.push(planId);
    const planIdParam = `$${p}`;
    p++;
    params.push(PLAN_YEAR);
    const yearParam = `$${p}`;

    const sql =
      `UPDATE "Plan" SET ${setParts.join(", ")}
       WHERE "planId" = ${planIdParam}
         AND "planYear" = ${yearParam}`;

    try {
      const rowsAffected = await prisma.$executeRawUnsafe(sql, ...params);
      const touched = Number(rowsAffected);
      totalRowsTouched += touched;
      totalCellsUpdated += touched * setParts.length;
    } catch (e) {
      errors++;
      if (errors <= 5) {
        log(`  error on planId=${planId}: ${e.message}`, "r");
      }
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
  log(`  cells updated (upper):   ${totalCellsUpdated.toLocaleString()}`, "g");
  if (errors > 0) log(`  errors: ${errors}`, "r");

  // Quick verification: how many plans still have nulls?
  log("\nPost-enrichment null-rate (pcpCopay canary):", "c");
  const verify = await prisma.$queryRawUnsafe(
    `SELECT "planType",
            COUNT(*)::int AS total,
            SUM(CASE WHEN "pcpCopay" IS NULL THEN 1 ELSE 0 END)::int AS pcp_null
     FROM "Plan"
     WHERE "planYear" = $1
     GROUP BY "planType"
     ORDER BY "planType"`,
    PLAN_YEAR,
  );
  for (const r of verify) {
    const pct = r.total > 0 ? ((r.pcp_null / r.total) * 100).toFixed(0) : "0";
    log(
      `  ${String(r.planType).padEnd(20)} ` +
      `${String(r.pcp_null).padStart(6)}/${String(r.total).padStart(6)} null (${pct.padStart(3)}%)`,
    );
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
