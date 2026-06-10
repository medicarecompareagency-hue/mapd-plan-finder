// scripts/rederive-ambulance-pcp-copay.js
//
// Re-derives ambulanceCopay and pcpCopay for every plan using Dale's range
// rule: when the PBP files a copay range (min != max), store the MAX.
//
// Why: the importer/enricher previously stored the MIN of the range for
// these two fields. The min is often a waived/$0 case — e.g. Devoted
// CHOICE Alabama H9888-1 files ground ambulance $0(min)–$405(max) and the
// DB showed $0 ambulance, which Dale caught 2026-06-10 ("unheard of in an
// MAPD plan"). Specialist (b7d) and outpatient (b9a) already used the max;
// this brings ambulance (b10a, ~497 plans with min!=max) and PCP (b7a,
// ~41 plans) in line. ER (b4a) has zero min!=max plans in 2026 PBP, left as-is.
//
// Coinsurance handling matches rederive-specialist-copay.js: coins pct is
// only stored when no copay is filed.
//
// USAGE (from repo root):
//   node scripts/rederive-ambulance-pcp-copay.js                 # dry-run
//   node scripts/rederive-ambulance-pcp-copay.js --apply         # write
//
const fs = require("fs");
const path = require("path");
const { makePrisma } = require("./prisma-client");
const prisma = makePrisma();

const APPLY = process.argv.includes("--apply");
const PLAN_YEAR = 2026;
const PBP_DIR = path.join(process.cwd(), ".cms-import-tmp", `pbp-${PLAN_YEAR}`);

function num(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (t === "") return null;
  const v = parseFloat(t.replace(/,/g, ""));
  return Number.isFinite(v) ? v : null;
}

function loadFile(name) {
  const file = path.join(PBP_DIR, name);
  if (!fs.existsSync(file)) {
    console.error(`PBP file not found: ${file}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const lines = raw.split("\n");
  const H = lines[0].split("\t");
  const col = (n) => { const i = H.indexOf(n); if (i < 0) throw new Error(`PBP column missing: ${n} in ${name}`); return i; };
  return { lines, col };
}

// Generic: aggregate per planId across segments. Range rule = max copay;
// coins = min pct. First-positive wins is NOT used — max across segments
// (consistent with rederive-specialist-copay.js).
function buildMap(name, fields) {
  const { lines, col } = loadFile(name);
  const cHnum = col("pbp_a_hnumber");
  const cPlan = col("pbp_a_plan_identifier");
  const cCopYn = col(fields.copYn);
  const cCopMin = col(fields.copMin);
  const cCopMax = col(fields.copMax);
  const cCoinYn = col(fields.coinYn);
  const cCoinMin = col(fields.coinMin);

  const byPlan = new Map(); // planId -> { copay, coins, noCostShare }
  for (let i = 1; i < lines.length; i++) {
    const r = lines[i].split("\t");
    if (r.length <= cCopMax) continue;
    const hnum = (r[cHnum] || "").trim();
    const pid = (r[cPlan] || "").trim();
    if (!hnum || !pid) continue;
    const planId = `${hnum}-${parseInt(pid, 10)}`;
    const e = byPlan.get(planId) || { copay: null, coins: null, noCostShare: false };
    const copYn = (r[cCopYn] || "").trim();
    const coinYn = (r[cCoinYn] || "").trim();
    if (copYn === "1") {
      const mn = num(r[cCopMin]), mx = num(r[cCopMax]);
      const pick = (mn != null && mx != null) ? Math.max(mn, mx) : (mx != null ? mx : mn);
      if (pick != null) e.copay = e.copay == null ? pick : Math.max(e.copay, pick);
    } else if (coinYn === "1") {
      const c = num(r[cCoinMin]);
      if (c != null) e.coins = e.coins == null ? c : Math.min(e.coins, c);
    } else if (copYn === "2") {
      // no copay and no coinsurance filed -> $0 cost share
      e.noCostShare = true;
    }
    byPlan.set(planId, e);
  }
  return byPlan;
}

async function rederive(label, map, copayField, coinsField) {
  const dbPlans = await prisma.plan.findMany({
    where: { planYear: PLAN_YEAR },
    select: { planId: true, [copayField]: true, [coinsField]: true },
    distinct: ["planId"],
  });
  console.log(`\n=== ${label}: ${dbPlans.length} distinct DB plans (year ${PLAN_YEAR}) ===`);

  let changed = 0, unchanged = 0, noPbp = 0, changedRows = 0;
  const samples = [];
  for (const p of dbPlans) {
    const src = map.get(p.planId);
    if (!src) { noPbp++; continue; }
    let newCopay = src.copay;
    if (newCopay == null && src.coins == null && src.noCostShare) newCopay = 0;
    const newCoins = newCopay == null ? src.coins : null;
    if (newCopay === p[copayField] && newCoins === p[coinsField]) { unchanged++; continue; }
    changed++;
    if (samples.length < 20) samples.push(`${p.planId}: copay ${p[copayField]} -> ${newCopay}; coins ${p[coinsField]} -> ${newCoins}`);
    if (APPLY) {
      const r = await prisma.plan.updateMany({
        where: { planId: p.planId, planYear: PLAN_YEAR },
        data: { [copayField]: newCopay, [coinsField]: newCoins },
      });
      changedRows += r.count;
    }
  }
  console.log(`Plans changed: ${changed} | unchanged: ${unchanged} | no PBP row: ${noPbp}`);
  for (const s of samples) console.log("  " + s);
  if (APPLY) console.log(`Rows written: ${changedRows}`);
}

async function main() {
  console.log(`PBP dir: ${PBP_DIR}`);
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN"}`);

  const amb = buildMap("pbp_b10_amb_trans.txt", {
    copYn: "pbp_b10a_copay_yn",
    copMin: "pbp_b10a_copay_gas_amt_min",
    copMax: "pbp_b10a_copay_gas_amt_max",
    coinYn: "pbp_b10a_coins_yn",
    coinMin: "pbp_b10a_coins_gas_pct_min",
  });
  console.log(`Parsed b10a ambulance data for ${amb.size} planIds.`);
  await rederive("ambulanceCopay (b10a, ground)", amb, "ambulanceCopay", "ambulanceCoinsPct");

  const pcp = buildMap("pbp_b7_health_prof.txt", {
    copYn: "pbp_b7a_copay_yn",
    copMin: "pbp_b7a_copay_amt_mc_min",
    copMax: "pbp_b7a_copay_amt_mc_max",
    coinYn: "pbp_b7a_coins_yn",
    coinMin: "pbp_b7a_coins_pct_mc_min",
  });
  console.log(`Parsed b7a PCP data for ${pcp.size} planIds.`);
  await rederive("pcpCopay (b7a, primary care)", pcp, "pcpCopay", "pcpCoinsPct");

  if (!APPLY) console.log("\nDry-run — no writes. Re-run with --apply to persist.");
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
