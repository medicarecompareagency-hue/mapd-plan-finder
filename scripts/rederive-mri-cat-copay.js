// scripts/rederive-mri-cat-copay.js
//
// Re-derives mriCopay/catScanCopay (and *CoinsPct) for every plan from the CORRECT
// PBP field b8b DRS (Diagnostic Radiology Services). Fixes the b8a(generic diagnostic)
// mis-map. Range rule: store the MAX. Clears the bogus b8a value where b8b files no DRS.
//
// 2026-06-16 fix: coinsurance was reading pbp_b8b_coins_pct_drs (the MIN of the filed
// range, often 0 — a narrow carve-out like in-office EKG) instead of
// pbp_b8b_coins_pct_drs_max (the MAX, the real general-case cost-share, e.g. 20%).
// Confirmed against SB PDFs (HealthSpring H4513-55, UnitedHealthcare H2802-64): both file
// "0%-20%" / "$0 copay or 20% coinsurance otherwise" ranges where 20% is the standard rate.
//
// USAGE (from repo root):
//   node scripts/rederive-mri-cat-copay.js                 # dry-run
//   node scripts/rederive-mri-cat-copay.js --apply         # write
//   node scripts/rederive-mri-cat-copay.js --pbp <path>    # override PBP file path
//
const fs = require("fs");
const path = require("path");
const { makePrisma } = require("./prisma-client");
const prisma = makePrisma();

const APPLY = process.argv.includes("--apply");
const pIdx = process.argv.indexOf("--pbp");
const PLAN_YEAR = 2026;
const PBP_FILE = pIdx >= 0
  ? process.argv[pIdx + 1]
  : path.join(process.cwd(), ".cms-import-tmp", `pbp-${PLAN_YEAR}`, "pbp_b8_clin_diag_ther.txt");

function num(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (t === "") return null;
  const v = parseFloat(t.replace(/,/g, ""));
  return Number.isFinite(v) ? v : null;
}

function loadPbp() {
  if (!fs.existsSync(PBP_FILE)) {
    console.error(`PBP file not found: ${PBP_FILE}`);
    console.error(`Point --pbp at pbp_b8_clin_diag_ther.txt (the b8 'clinical/diagnostic/therapeutic' staging file).`);
    process.exit(1);
  }
  const raw = fs.readFileSync(PBP_FILE, "utf8").replace(/\r\n/g, "\n");
  const lines = raw.split("\n");
  const H = lines[0].split("\t");
  const col = (n) => { const i = H.indexOf(n); if (i < 0) throw new Error(`PBP column missing: ${n}`); return i; };
  const cHnum = col("pbp_a_hnumber");
  const cPlan = col("pbp_a_plan_identifier");
  const cCopYn = col("pbp_b8b_copay_yn");
  const cDrs = col("pbp_b8b_copay_amt_drs");
  const cDrsMax = col("pbp_b8b_copay_amt_drs_max");
  const cCoinYn = col("pbp_b8b_coins_yn");
  const cCoinDrsMax = col("pbp_b8b_coins_pct_drs_max");

  const byPlan = new Map(); // planId -> { copay, coins }
  for (let i = 1; i < lines.length; i++) {
    const r = lines[i].split("\t");
    if (r.length <= cDrsMax) continue;
    const hnum = (r[cHnum] || "").trim();
    const pid = (r[cPlan] || "").trim();
    if (!hnum || !pid) continue;
    const planId = `${hnum}-${parseInt(pid, 10)}`;
    const e = byPlan.get(planId) || { copay: null, coins: null };
    // 2026-06-16 fix: some PBP rows file copay_yn=1 (Yes) AND coins_yn=1 (Yes)
    // simultaneously, with BOTH copay amount fields blank — only the coins
    // amount is actually populated. The old code committed to the (empty)
    // copay branch and never checked coinsurance for that row, leaving the
    // plan N/A even though a real coinsurance % was sitting right there.
    // Fall through to coinsurance whenever the copay branch yields no amount.
    let gotCopay = false;
    if ((r[cCopYn] || "").trim() === "1") {
      const mn = num(r[cDrs]), mx = num(r[cDrsMax]);
      const pick = (mn != null && mx != null) ? Math.max(mn, mx) : (mx != null ? mx : mn);
      if (pick != null) {
        e.copay = e.copay == null ? pick : Math.max(e.copay, pick);
        gotCopay = true;
      }
    }
    if (!gotCopay && (r[cCoinYn] || "").trim() === "1") {
      const c = num(r[cCoinDrsMax]);
      if (c != null) e.coins = e.coins == null ? c : Math.max(e.coins, c);
    }
    byPlan.set(planId, e);
  }
  return byPlan;
}

async function main() {
  console.log(`PBP file: ${PBP_FILE}`);
  const pbp = loadPbp();
  console.log(`Parsed b8b DRS data for ${pbp.size} planIds.`);

  const dbPlans = await prisma.plan.findMany({
    where: { planYear: PLAN_YEAR },
    select: { planId: true, mriCopay: true, catScanCopay: true, mriCoinsPct: true, catScanCoinsPct: true },
    distinct: ["planId"],
  });
  console.log(`${dbPlans.length} distinct DB plans (year ${PLAN_YEAR}).`);

  let toCopay = 0, toCoins = 0, toNull = 0, unchanged = 0, noPbp = 0, changedRows = 0;
  const samples = [];
  const HEADLINE = new Set(["H4513-92","H1290-14","H2697-1","H7993-1"]);

  for (const p of dbPlans) {
    const src = pbp.get(p.planId);
    if (!src) { noPbp++; continue; }
    const newCopay = src.copay;                          // may be null
    const newCoins = src.copay == null ? src.coins : null;
    const changed = (newCopay !== p.mriCopay) || (newCopay !== p.catScanCopay)
      || (newCoins !== p.mriCoinsPct) || (newCoins !== p.catScanCoinsPct);
    if (!changed) { unchanged++; continue; }
    if (newCopay != null) toCopay++; else if (newCoins != null) toCoins++; else toNull++;
    if (samples.length < 25 || HEADLINE.has(p.planId)) {
      samples.push(`${p.planId}: mri ${p.mriCopay} -> ${newCopay}; coins ${p.mriCoinsPct} -> ${newCoins}`);
    }
    if (APPLY) {
      const r = await prisma.plan.updateMany({
        where: { planId: p.planId, planYear: PLAN_YEAR },
        data: { mriCopay: newCopay, catScanCopay: newCopay, mriCoinsPct: newCoins, catScanCoinsPct: newCoins },
      });
      changedRows += r.count;
    }
  }

  console.log(`\nPlans changed: ${toCopay + toCoins + toNull} (->copay ${toCopay}, ->coins ${toCoins}, ->null ${toNull})`);
  console.log(`Unchanged: ${unchanged} | DB plans with no b8 row: ${noPbp}`);
  console.log(`\nSample / headline:`);
  for (const s of samples.filter(x => HEADLINE.has(x.split(":")[0])).concat(samples.slice(0, 12))) console.log("  " + s);
  if (APPLY) console.log(`\nRows written: ${changedRows}`);
  else console.log(`\nDry-run — no writes. Re-run with --apply to persist.`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
