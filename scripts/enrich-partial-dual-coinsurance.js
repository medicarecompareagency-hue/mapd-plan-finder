// scripts/enrich-partial-dual-coinsurance.js
//
// Fills the *CoinsPct fields on partial-dual / unset DSNP plans by reading
// PBP coinsurance percentage columns. Companion to the FULL_DUAL residual
// fill (which wrote $0 copays). For PARTIAL_DUAL beneficiaries (SLMB / QI-1)
// the carrier filed coinsurance, not a flat copay, so we need to surface
// "X% coins" instead of leaving N/A.
//
// SCOPE
//   planCategory = 'DSNP'
//   AND (dsnpTargetGroup IS NULL OR dsnpTargetGroup = 'PARTIAL_DUAL')
//
// WRITE SEMANTICS
//   COALESCE — only fill currently-NULL CoinsPct fields. Never overwrites.
//   Does NOT touch the *Copay fields.
//
// USAGE (from repo root)
//   node scripts/enrich-partial-dual-coinsurance.js
//   node scripts/enrich-partial-dual-coinsurance.js --year 2026
//   node scripts/enrich-partial-dual-coinsurance.js --dry-run
//   node scripts/enrich-partial-dual-coinsurance.js --plan H3239-2

const fs = require("fs");
const path = require("path");
const { makePrisma } = require("./prisma-client");

const prisma = makePrisma();

const yearArgIdx = process.argv.indexOf("--year");
const PLAN_YEAR = yearArgIdx >= 0 ? parseInt(process.argv[yearArgIdx + 1], 10) : 2026;
const DRY_RUN = process.argv.includes("--dry-run");
const planArgIdx = process.argv.indexOf("--plan");
const FOCUS_PLAN = planArgIdx >= 0 ? process.argv[planArgIdx + 1] : null;

const EXTRACT_DIR = path.join(process.cwd(), ".cms-import-tmp", `pbp-${PLAN_YEAR}`);

const C = { g: "\x1b[32m", c: "\x1b[36m", y: "\x1b[33m", r: "\x1b[31m", m: "\x1b[35m", z: "\x1b[0m" };
function log(msg, color) { console.log(`${color ? C[color] : ""}${msg}${C.z}`); }
function line(n = 72) { return "=".repeat(n); }

// Service definitions, mapped to the actual 2026 PBP coinsurance column names.
// Verified against PBP file headers 2026-05-07. Earlier diagnostic guesses
// were missing the *_mc_ / *_gas_ / *_ohs_ / *_dmc subcategory suffixes.
const SERVICES = [
  {
    pctField: "pcpCoinsPct",
    file: "pbp_b7_health_prof.txt",
    coinsYn: "pbp_b7a_coins_yn",
    minCol: "pbp_b7a_coins_pct_mc_min",
    maxCol: "pbp_b7a_coins_pct_mc_max",
  },
  {
    pctField: "specialistCoinsPct",
    file: "pbp_b7_health_prof.txt",
    coinsYn: "pbp_b7b_coins_yn",
    minCol: "pbp_b7b_coins_pct_mc_min",
    maxCol: "pbp_b7b_coins_pct_mc_max",
  },
  {
    pctField: "emergencyRoomCoinsPct",
    file: "pbp_b4_emerg_urgent.txt",
    coinsYn: "pbp_b4a_coins_yn",
    minCol: "pbp_b4a_coins_pct_mc_min",
    maxCol: "pbp_b4a_coins_pct_mc_max",
  },
  {
    pctField: "ambulanceCoinsPct",
    file: "pbp_b10_amb_trans.txt",
    coinsYn: "pbp_b10a_coins_yn",
    minCol: "pbp_b10a_coins_gas_pct_min",
    maxCol: "pbp_b10a_coins_gas_pct_max",
  },
  {
    pctField: "outpatientHospitalCoinsPct",
    file: "pbp_b9_outpat_hosp.txt",
    coinsYn: "pbp_b9a_coins_yn",
    minCol: "pbp_b9a_coins_ohs_pct_min",
    maxCol: "pbp_b9a_coins_ohs_pct_max",
  },
  {
    pctField: "mriCoinsPct",
    file: "pbp_b8_clin_diag_ther.txt",
    coinsYn: "pbp_b8a_coins_yn",
    minCol: "pbp_b8a_coins_pct_dmc",
    maxCol: "pbp_b8a_coins_pct_dmc_max",
  },
  {
    pctField: "catScanCoinsPct",
    file: "pbp_b8_clin_diag_ther.txt",
    coinsYn: "pbp_b8a_coins_yn",
    minCol: "pbp_b8a_coins_pct_dmc",
    maxCol: "pbp_b8a_coins_pct_dmc_max",
  },
];

const FILES_NEEDED = [...new Set(SERVICES.map((s) => s.file))];
const PCT_FIELDS = SERVICES.map((s) => s.pctField);

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

// Returns the coinsurance percentage as a Number, or null.
// Reads min first; falls back to max. Treats blank / non-numeric as null.
function extractPct(row, svc) {
  if (!row) return null;
  const yn = row[svc.coinsYn];
  if (yn !== "1") return null; // Only honor coinsurance when carrier filed it.
  const candidates = [row[svc.minCol], row[svc.maxCol]];
  for (const v of candidates) {
    if (v === undefined || v === null) continue;
    const trimmed = String(v).trim();
    if (trimmed === "") continue;
    const n = parseFloat(trimmed);
    if (!isNaN(n)) return n;
  }
  return null;
}

async function main() {
  log(line(), "c");
  log(`Partial-dual DSNP coinsurance enrichment — planYear=${PLAN_YEAR}${DRY_RUN ? " [DRY-RUN]" : ""}`, "c");
  log(line(), "c");

  if (!fs.existsSync(EXTRACT_DIR)) {
    log(`\nERROR: PBP extract dir not found at ${EXTRACT_DIR}`, "r");
    log(`Run this first: npx tsx scripts/prepare-pbp.ts ${PLAN_YEAR}`, "y");
    process.exit(1);
  }

  log("\nLoading PBP files...", "c");
  const pbpByFile = {};
  for (const f of FILES_NEEDED) {
    log(`  ${f} ...`);
    const rows = parseTSV(path.join(EXTRACT_DIR, f));
    const map = new Map();
    for (const r of rows) {
      const k = dbPlanKey(r);
      if (!k) continue;
      if (!map.has(k)) map.set(k, r); // first segment wins, matches enrichment behavior
    }
    pbpByFile[f] = map;
  }

  // Pull in-scope plans with at least one NULL CoinsPct field. Subsetting on
  // NULL keeps the work-set small and matches COALESCE intent.
  const nullClause = PCT_FIELDS.map((f) => `"${f}" IS NULL`).join(" OR ");
  const params = [PLAN_YEAR];
  let where = `"planYear" = $1
       AND "planCategory" = 'DSNP'
       AND ("dsnpTargetGroup" IS NULL OR "dsnpTargetGroup" = 'PARTIAL_DUAL')
       AND (${nullClause})`;
  if (FOCUS_PLAN) {
    where += ` AND "planId" = $2`;
    params.push(FOCUS_PLAN);
  }

  const plans = await prisma.$queryRawUnsafe(
    `SELECT DISTINCT "planId" FROM "Plan" WHERE ${where}`,
    ...params,
  );
  log(`\nIn-scope planIds: ${plans.length.toLocaleString()}`, "g");

  let plansTouched = 0;
  let cellsFilled = 0;
  const perField = Object.fromEntries(PCT_FIELDS.map((f) => [f, 0]));
  const perCarrier = {};

  for (const { planId } of plans) {
    // Find every Plan row for this planId (could be multiple segments).
    const rows = await prisma.plan.findMany({
      where: {
        planId,
        planYear: PLAN_YEAR,
        planCategory: "DSNP",
        OR: [
          { dsnpTargetGroup: null },
          { dsnpTargetGroup: "PARTIAL_DUAL" },
        ],
      },
      select: {
        id: true,
        organizationName: true,
        ...Object.fromEntries(PCT_FIELDS.map((f) => [f, true])),
      },
    });
    if (rows.length === 0) continue;

    // Determine PCT values once per planId.
    const updates = {};
    for (const svc of SERVICES) {
      const pct = extractPct(pbpByFile[svc.file]?.get(planId), svc);
      if (pct === null) continue;
      updates[svc.pctField] = pct;
    }
    if (Object.keys(updates).length === 0) continue;

    let touchedThisPlan = false;
    for (const r of rows) {
      const patch = {};
      for (const [field, val] of Object.entries(updates)) {
        if (r[field] === null || r[field] === undefined) {
          patch[field] = val;
        }
      }
      if (Object.keys(patch).length === 0) continue;

      if (!DRY_RUN) {
        await prisma.plan.update({ where: { id: r.id }, data: patch });
      }
      for (const f of Object.keys(patch)) {
        perField[f]++;
        cellsFilled++;
      }
      const ck = r.organizationName || "(unknown)";
      perCarrier[ck] = (perCarrier[ck] || 0) + Object.keys(patch).length;
      touchedThisPlan = true;
    }
    if (touchedThisPlan) plansTouched++;
  }

  log("\n" + line(), "c");
  log(`${DRY_RUN ? "[DRY-RUN] would fill" : "Filled"} ${cellsFilled.toLocaleString()} cells across ${plansTouched.toLocaleString()} distinct planIds`, "g");
  log(line(), "c");
  log("Per-field:", "c");
  for (const f of PCT_FIELDS) log(`  ${f.padEnd(30)} ${String(perField[f]).padStart(6)}`);
  log("\nPer-carrier:", "c");
  const sorted = Object.entries(perCarrier).sort((a, b) => b[1] - a[1]);
  for (const [name, n] of sorted) log(`  ${name.substring(0, 36).padEnd(36)} ${String(n).padStart(6)}`);

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
