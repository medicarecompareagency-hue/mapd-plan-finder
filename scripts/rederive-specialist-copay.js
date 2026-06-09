// scripts/rederive-specialist-copay.js
//
// Re-derives specialistCopay (and specialistCoinsPct) for every plan from the
// CORRECT PBP field b7d ('Phys Spclist'). Fixes the b7b(chiropractic) mis-map.
// Range rule: store the MAX of the b7d copay range. Clears the bogus chiropractic
// value where b7d files no specialist copay.
//
// USAGE (from repo root):
//   node scripts/rederive-specialist-copay.js                 # dry-run
//   node scripts/rederive-specialist-copay.js --apply         # write
//   node scripts/rederive-specialist-copay.js --pbp <path>    # override PBP file path
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
  : path.join(process.cwd(), ".cms-import-tmp", `pbp-${PLAN_YEAR}`, "pbp_b7_health_prof.txt");

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
    console.error(`Point --pbp at pbp_b7_health_prof.txt (it's the b7 'health professional' staging file).`);
    process.exit(1);
  }
  const raw = fs.readFileSync(PBP_FILE, "utf8").replace(/\r\n/g, "\n");
  const lines = raw.split("\n");
  const H = lines[0].split("\t");
  const col = (name) => { const i = H.indexOf(name); if (i < 0) throw new Error(`PBP column missing: ${name}`); return i; };
  const cHnum = col("pbp_a_hnumber");
  const cPlan = col("pbp_a_plan_identifier");
  const cCopYn = col("pbp_b7d_copay_yn");
  const cCopMin = col("pbp_b7d_copay_amt_mc_min");
  const cCopMax = col("pbp_b7d_copay_amt_mc_max");
  const cCoinYn = col("pbp_b7d_coins_yn");
  const cCoinMin = col("pbp_b7d_coins_pct_mc_min");

  // aggregate per planId across segments (range rule = max copay; coins = min pct)
  const byPlan = new Map(); // planId -> { copay:number|null, coins:number|null }
  for (let i = 1; i < lines.length; i++) {
    const r = lines[i].split("\t");
    if (r.length <= cCopMax) continue;
    const hnum = (r[cHnum] || "").trim();
    const pid = (r[cPlan] || "").trim();
    if (!hnum || !pid) continue;
    const planId = `${hnum}-${parseInt(pid, 10)}`;
    const e = byPlan.get(planId) || { copay: null, coins: null };
    if ((r[cCopYn] || "").trim() === "1") {
      const mn = num(r[cCopMin]), mx = num(r[cCopMax]);
      const pick = (mn != null && mx != null) ? Math.max(mn, mx) : (mx != null ? mx : mn);
      if (pick != null) e.copay = e.copay == null ? pick : Math.max(e.copay, pick);
    } else if ((r[cCoinYn] || "").trim() === "1") {
      const c = num(r[cCoinMin]);
      if (c != null) e.coins = e.coins == null ? c : Math.min(e.coins, c);
    }
    byPlan.set(planId, e);
  }
  return byPlan;
}

async function main() {
  console.log(`PBP file: ${PBP_FILE}`);
  const pbp = loadPbp();
  console.log(`Parsed b7d specialist data for ${pbp.size} planIds.`);

  // distinct planIds in the DB for this year
  const dbPlans = await prisma.plan.findMany({
    where: { planYear: PLAN_YEAR },
    select: { planId: true, specialistCopay: true, specialistCoinsPct: true },
    distinct: ["planId"],
  });
  console.log(`${dbPlans.length} distinct DB plans (year ${PLAN_YEAR}).`);

  let toCopay = 0, toCoins = 0, toNull = 0, unchanged = 0, noPbp = 0, changedRows = 0;
  const samples = [];
  const HEADLINE = new Set(["H1290-14","H1290-15","H2697-1","H2697-15","H7993-1","H7993-19","H1290-13"]);

  for (const p of dbPlans) {
    const src = pbp.get(p.planId);
    if (!src) { noPbp++; continue; }
    const newCopay = src.copay;                       // may be null
    const newCoins = src.copay == null ? src.coins : null; // coins only when no copay
    const changed = (newCopay !== p.specialistCopay) || (newCoins !== p.specialistCoinsPct);
    if (!changed) { unchanged++; continue; }
    if (newCopay != null) toCopay++; else if (newCoins != null) toCoins++; else toNull++;
    if (samples.length < 25 || HEADLINE.has(p.planId)) {
      samples.push(`${p.planId}: copay ${p.specialistCopay} -> ${newCopay}; coins ${p.specialistCoinsPct} -> ${newCoins}`);
    }
    if (APPLY) {
      const r = await prisma.plan.updateMany({
        where: { planId: p.planId, planYear: PLAN_YEAR },
        data: { specialistCopay: newCopay, specialistCoinsPct: newCoins },
      });
      changedRows += r.count;
    }
  }

  console.log(`\nPlans changed: ${toCopay + toCoins + toNull} (->copay ${toCopay}, ->coins ${toCoins}, ->null ${toNull})`);
  console.log(`Unchanged: ${unchanged} | DB plans with no b7d row: ${noPbp}`);
  console.log(`\nSample / headline:`);
  for (const s of samples.filter(x => HEADLINE.has(x.split(":")[0])).concat(samples.slice(0, 15))) console.log("  " + s);
  if (APPLY) console.log(`\nRows written: ${changedRows}`);
  else console.log(`\nDry-run — no writes. Re-run with --apply to persist.`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
