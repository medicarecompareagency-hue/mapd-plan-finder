// scripts/inspect-plan-pbp.js
// Dump every PBP field for a single plan so we can see exactly what
// CMS publishes (and what we are currently ignoring).
//
// Usage (from repo root):
//   node scripts/inspect-plan-pbp.js H4513-46
//   node scripts/inspect-plan-pbp.js H4513-46 mrx_tier      # one file only
//
// Shows raw values side-by-side for PCP/Specialist/MRI/CAT/Drug tiers
// so we can tell whether our importer missed a column or whether the
// data is genuinely absent from CMS.

const fs = require("fs");
const path = require("path");

const [, , planArg, fileFilter] = process.argv;
if (!planArg) {
  console.error("Usage: node scripts/inspect-plan-pbp.js <planId> [fileFilter]");
  console.error("Example: node scripts/inspect-plan-pbp.js H4513-46");
  console.error("Example: node scripts/inspect-plan-pbp.js H4513-46 mrx_tier");
  process.exit(1);
}

const [HNUMBER, PLAN_NUM_RAW] = planArg.split("-");
if (!HNUMBER || !PLAN_NUM_RAW) {
  console.error(`Invalid planId format: "${planArg}". Expected "Hxxxx-NN".`);
  process.exit(1);
}
const PLAN_NUM = parseInt(PLAN_NUM_RAW, 10);

const EXTRACT_DIR = path.join(process.cwd(), ".cms-import-tmp", "pbp-2026");

function parseTSV(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf-8");
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  if (lines.length === 0) return { headers: [], rows: [] };
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
  return { headers, rows };
}

function matchesPlan(row) {
  if (!row.pbp_a_hnumber || !row.pbp_a_plan_identifier) return false;
  if (row.pbp_a_hnumber.trim() !== HNUMBER) return false;
  const p = parseInt(row.pbp_a_plan_identifier.trim(), 10);
  return p === PLAN_NUM;
}

const FILES = [
  "pbp_Section_A.txt",
  "pbp_Section_D.txt",
  "pbp_b7_health_prof.txt",
  "pbp_b4_emerg_urgent.txt",
  "pbp_b10_amb_trans.txt",
  "pbp_b9_outpat_hosp.txt",
  "pbp_b1a_inpat_hosp.txt",
  "pbp_b2_snf.txt",
  "pbp_b8_clin_diag_ther.txt",
  "pbp_mrx.txt",
  "pbp_mrx_tier.txt",
];

console.log("=".repeat(80));
console.log(`PBP inspector for plan ${HNUMBER}-${PLAN_NUM}`);
console.log(`Extract dir: ${EXTRACT_DIR}`);
console.log("=".repeat(80));

if (!fs.existsSync(EXTRACT_DIR)) {
  console.error(`\nERROR: extract dir missing. Run prepare-pbp.ts 2026 first.`);
  process.exit(1);
}

for (const fname of FILES) {
  if (fileFilter && !fname.includes(fileFilter)) continue;
  const fpath = path.join(EXTRACT_DIR, fname);
  const parsed = parseTSV(fpath);
  if (!parsed) {
    console.log(`\n--- ${fname} --- (file missing)`);
    continue;
  }
  const matches = parsed.rows.filter(matchesPlan);
  console.log(`\n${"-".repeat(80)}`);
  console.log(`${fname}  (${matches.length} matching rows)`);
  console.log(`${"-".repeat(80)}`);

  if (matches.length === 0) {
    console.log("  (no rows for this plan in this file)");
    continue;
  }

  for (let i = 0; i < matches.length; i++) {
    const row = matches[i];
    console.log(`\n  [row ${i + 1}]`);
    // Always show segment + tier id for context
    const identity = [
      row.segment_id ? `segment_id=${row.segment_id}` : null,
      row.mrx_tier_id ? `mrx_tier_id=${row.mrx_tier_id}` : null,
      row.bid_id ? `bid_id=${row.bid_id}` : null,
    ].filter(Boolean).join("  ");
    if (identity) console.log(`    ${identity}`);

    // Show only fields that have non-empty values, and skip the
    // identity fields we already printed
    const skip = new Set([
      "pbp_a_hnumber", "pbp_a_plan_identifier", "segment_id",
      "pbp_a_ben_cov", "pbp_a_plan_type", "orgtype", "bid_id", "version",
    ]);
    const kept = [];
    for (const k of Object.keys(row)) {
      if (skip.has(k)) continue;
      const v = row[k];
      if (v === "" || v === undefined) continue;
      kept.push([k, v]);
    }
    if (kept.length === 0) {
      console.log("    (all fields empty)");
    } else {
      // Pretty columns
      const maxK = Math.max(...kept.map(([k]) => k.length));
      for (const [k, v] of kept) {
        console.log(`    ${k.padEnd(maxK)}  =  ${v}`);
      }
    }
  }
}

console.log("\n" + "=".repeat(80));
console.log("What to look for:");
console.log("  - pbp_mrx_tier.txt: does this plan have rows with mrx_tier_id 1-6?");
console.log("    If yes, which *_copay_* or *_coins_* columns are populated?");
console.log("    Common variants:");
console.log("      mrx_tier_rstd_copay_1m    (retail standard, 1-month)");
console.log("      mrx_tier_pref_copay_1m    (retail preferred, 1-month)");
console.log("      mrx_tier_mail_copay_1m    (mail order, 1-month)");
console.log("      mrx_tier_rstd_coins_1m    (retail standard, coinsurance %)");
console.log("      mrx_tier_pref_coins_1m    (retail preferred, coinsurance %)");
console.log("=".repeat(80));
