// scripts/rederive-otc-food-allowances.js
//
// Re-derives otcAllowance / otcMaxPeriod / foodCardAllowance /
// foodCardMaxPeriod from the raw PBP files using the CORRECT periodicity
// codebook. (ssbci*Allowance columns are NOT touched here — re-run
// `node scripts/enrich-ssbci-benefits.js --apply --force` for those; it
// owns the VBID b19b card-merge logic and now has the fixed codebook.)
//
// Root cause (caught by Dale 2026-06-10): import-pbp.js and
// enrich-ssbci-benefits.js assumed per-codes 1=year/2=month/3=quarter/
// 4=6mo/5=other. The actual CMS codebook (PBP_Benefits_2026_dictionary.xlsx)
// is 1=every 3 YEARS, 2=every 2 YEARS, 3=every YEAR, 4=every 6 months,
// 5=every 3 MONTHS (quarter), 6=Other/Describe, 7=every MONTH. Net effect:
//   - quarterly OTC cards (per=5, the dominant filing) were annualized x12
//     instead of x4 -> 3x overstated, and labeled "month" instead of
//     "quarter" (e.g. Aetna Eagle H5521-229: SB says $180/quarter; DB said
//     $2,160/yr displayed as "$180/mo").
//   - yearly food cards (per=3) were annualized x4 -> 4x overstated.
//   - monthly filings (per=7) got x1 -> 12x UNDERstated.
//
// Mirrors import-pbp.js aggregation semantics exactly: max across
// segments, b13c meal fallback when SSBCI yields no food card, first-seen
// period label wins. Periods are only written when computed (no null
// blasting). NOTE: sbVerified* columns are untouched — those came from SB
// PDFs and are independently annualized.
//
// Prereqs: .cms-import-tmp/pbp-2026/ extracted; foodCardMaxPeriod column
// added to Plan (npx prisma db push after the 2026-06-10 schema edit).
//
// USAGE (from repo root):
//   node scripts/rederive-otc-food-allowances.js              # dry run
//   node scripts/rederive-otc-food-allowances.js --apply      # write
//
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { makePrisma } = require("./prisma-client");
const prisma = makePrisma();

const APPLY = process.argv.includes("--apply");
const PLAN_YEAR = 2026;
const PBP_DIR = path.join(process.cwd(), ".cms-import-tmp", `pbp-${PLAN_YEAR}`);

// Correct codebook (see header).
const PERIOD_MULT = { '1': 1 / 3, '2': 1 / 2, '3': 1, '4': 2, '5': 4, '6': 1, '7': 12 };
const PERIOD_LABEL = {
  '1': '3 years', '2': '2 years', '3': 'year', '4': '6 months',
  '5': 'quarter', '6': 'other', '7': 'month',
};

function num(s) {
  if (s == null || s === '') return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}
function annualize(amt, perCode) {
  const m = PERIOD_MULT[perCode] !== undefined ? PERIOD_MULT[perCode] : 1;
  return num(amt) * m;
}
function planIdFor(row) {
  const h = row.pbp_a_hnumber;
  const p = parseInt(row.pbp_a_plan_identifier, 10);
  if (!h || Number.isNaN(p)) return null;
  return `${h}-${p}`;
}
async function* readPbp(file) {
  const full = path.join(PBP_DIR, file);
  if (!fs.existsSync(full)) { console.error(`Missing PBP file: ${full}`); process.exit(1); }
  const rl = readline.createInterface({ input: fs.createReadStream(full, { encoding: "utf8" }), crlfDelay: Infinity });
  let header = null;
  for await (const line of rl) {
    if (!line) continue;
    const cols = line.split("\t");
    if (!header) { header = cols; continue; }
    const row = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = cols[i] || '';
    yield row;
  }
}

async function main() {
  console.log(`PBP dir: ${PBP_DIR}`);
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN"}\n`);

  // agg: planId -> { otcAllowance, otcMaxPeriod, foodCardAllowance,
  //                  foodCardMaxPeriod, ssbci* }
  const agg = new Map();
  const get = (pid) => {
    let c = agg.get(pid);
    if (!c) {
      c = {
        otcAllowance: 0, otcMaxPeriod: null,
        foodCardAllowance: 0, foodCardMaxPeriod: null,
        b13cMeal: 0, b13cMealPeriod: null,
      };
      agg.set(pid, c);
    }
    return c;
  };

  console.log("Reading pbp_b13_other_services.txt ...");
  for await (const row of readPbp("pbp_b13_other_services.txt")) {
    const pid = planIdFor(row);
    if (!pid) continue;
    const c = get(pid);
    const otc = annualize(row.pbp_b13b_maxplan_amt, row.pbp_b13b_otc_maxplan_per);
    if (otc > c.otcAllowance) c.otcAllowance = otc;
    if (otc > 0 && !c.otcMaxPeriod) c.otcMaxPeriod = PERIOD_LABEL[row.pbp_b13b_otc_maxplan_per] || null;
    const meal = annualize(row.pbp_b13c_maxplan_amt, row.pbp_b13c_maxplan_per);
    if (meal > c.b13cMeal) c.b13cMeal = meal;
    if (meal > 0 && !c.b13cMealPeriod) c.b13cMealPeriod = PERIOD_LABEL[row.pbp_b13c_maxplan_per] || null;
  }

  console.log("Reading pbp_b13i_b19b_services_vbid_ssbci.txt ...");
  for await (const row of readPbp("pbp_b13i_b19b_services_vbid_ssbci.txt")) {
    const pid = planIdFor(row);
    if (!pid) continue;
    const c = get(pid);
    const fd = annualize(row.pbp_b13i_fd_maxplan_amt, row.pbp_b13i_fd_maxplan_per);
    if (fd > c.foodCardAllowance) c.foodCardAllowance = fd;
    if (fd > 0 && !c.foodCardMaxPeriod) c.foodCardMaxPeriod = PERIOD_LABEL[row.pbp_b13i_fd_maxplan_per] || null;
  }

  // Meal fallback (import-pbp.js semantics)
  for (const [, c] of agg) {
    if (c.foodCardAllowance === 0 && c.b13cMeal > 0) {
      c.foodCardAllowance = c.b13cMeal;
      c.foodCardMaxPeriod = c.b13cMealPeriod;
    }
    delete c.b13cMeal;
    delete c.b13cMealPeriod;
  }

  console.log(`Aggregated ${agg.size} planIds.\n`);

  // Raw SQL on both sides (no prisma-client model fields), so this works
  // even before `npx prisma generate` has picked up foodCardMaxPeriod.
  const dbPlans = await prisma.$queryRawUnsafe(
    `SELECT DISTINCT ON ("planId") "planId", "otcAllowance", "otcMaxPeriod",
            "foodCardAllowance", "foodCardMaxPeriod"
     FROM "Plan" WHERE "planYear" = ${PLAN_YEAR} ORDER BY "planId"`
  );
  console.log(`${dbPlans.length} distinct DB plans (year ${PLAN_YEAR}).`);

  let changed = 0, unchanged = 0, noPbp = 0;
  const updates = []; // { planId, otc, otcPer, food, foodPer }
  const samples = [];
  const HEADLINE = new Set(["H4513-46", "H9888-1", "H5521-229", "H2802-41", "H4461-78"]);
  for (const p of dbPlans) {
    const src = agg.get(p.planId);
    if (!src) { noPbp++; continue; }
    const newOtcPer = src.otcMaxPeriod ?? p.otcMaxPeriod ?? null;
    const newFoodPer = src.foodCardMaxPeriod ?? p.foodCardMaxPeriod ?? null;
    const isChanged =
      src.otcAllowance !== (p.otcAllowance ?? 0) ||
      src.foodCardAllowance !== (p.foodCardAllowance ?? 0) ||
      newOtcPer !== (p.otcMaxPeriod ?? null) ||
      newFoodPer !== (p.foodCardMaxPeriod ?? null);
    if (!isChanged) { unchanged++; continue; }
    changed++;
    updates.push({ planId: p.planId, otc: src.otcAllowance, otcPer: newOtcPer, food: src.foodCardAllowance, foodPer: newFoodPer });
    if (samples.length < 20 || HEADLINE.has(p.planId)) {
      samples.push(`${p.planId}: otc ${p.otcAllowance}/${p.otcMaxPeriod} -> ${src.otcAllowance}/${newOtcPer} | food ${p.foodCardAllowance}/${p.foodCardMaxPeriod} -> ${src.foodCardAllowance}/${newFoodPer}`);
    }
  }

  console.log(`Plans changed: ${changed} | unchanged: ${unchanged} | no PBP row: ${noPbp}\n`);
  console.log("Headline / sample changes:");
  for (const s of samples.filter((x) => HEADLINE.has(x.split(":")[0])).concat(samples.slice(0, 15))) console.log("  " + s);

  if (!APPLY) {
    console.log("\nDry-run — no writes. Re-run with --apply to persist.");
    return;
  }

  // Fast path: VALUES-table UPDATE in batches (same pattern as
  // enrich-ssbci-benefits.js) — one round trip per 500 plans.
  const esc = (s) => (s == null ? "NULL" : `'${String(s).replace(/'/g, "''")}'`);
  let written = 0;
  const BATCH = 500;
  for (let i = 0; i < updates.length; i += BATCH) {
    const vals = updates.slice(i, i + BATCH)
      .map((u) => `(${esc(u.planId)}, ${u.otc}, ${esc(u.otcPer)}, ${u.food}, ${esc(u.foodPer)})`)
      .join(",\n");
    const n = await prisma.$executeRawUnsafe(
      `UPDATE "Plan" AS p SET
         "otcAllowance" = v.otc,
         "otcMaxPeriod" = v.otc_per,
         "foodCardAllowance" = v.food,
         "foodCardMaxPeriod" = v.food_per
       FROM (VALUES ${vals}) AS v("planId", otc, otc_per, food, food_per)
       WHERE p."planId" = v."planId" AND p."planYear" = ${PLAN_YEAR}`
    );
    written += n;
    console.log(`  ${Math.min(i + BATCH, updates.length)}/${updates.length} plans (${written} rows)`);
  }
  console.log(`\nRows written: ${written}`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
// EOF
