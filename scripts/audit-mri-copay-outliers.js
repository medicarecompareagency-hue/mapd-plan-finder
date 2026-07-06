// scripts/audit-mri-copay-outliers.js
// Read-only audit: finds every 2026 planId whose stored mriCopay/catScanCopay looks like
// it inherited an inflated cross-setting/aggregate PBP range max instead of a real
// single-visit imaging copay. Classifies into SPREAD / IMPLAUSIBLE / ORPHAN buckets
// (a plan can land in more than one) and writes a deduped worklist for SB verification.
//
// Reuses the b8b DRS (Diagnostic Radiology Services) column layout from
// scripts/rederive-mri-cat-copay.js — same PBP staging file, same columns.
//
//   node scripts/audit-mri-copay-outliers.js
//
const fs = require("fs");
const path = require("path");
const { makePrisma } = require("./prisma-client");
const prisma = makePrisma();

const PLAN_YEAR = 2026;
const PBP_FILE = path.join(process.cwd(), ".cms-import-tmp", `pbp-${PLAN_YEAR}`, "pbp_b8_clin_diag_ther.txt");
const IMPLAUSIBLE_FLOOR = 500;
const SPREAD_MIN = 75;

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

  const byPlan = new Map(); // planId -> { drsMin, drsMax }
  for (let i = 1; i < lines.length; i++) {
    const r = lines[i].split("\t");
    if (r.length <= cDrsMax) continue;
    const hnum = (r[cHnum] || "").trim();
    const pid = (r[cPlan] || "").trim();
    if (!hnum || !pid) continue;
    const planId = `${hnum}-${parseInt(pid, 10)}`;
    if ((r[cCopYn] || "").trim() !== "1") continue;
    const mn = num(r[cDrs]), mx = num(r[cDrsMax]);
    if (mn == null && mx == null) continue;
    const e = byPlan.get(planId) || { drsMin: null, drsMax: null };
    if (mn != null) e.drsMin = e.drsMin == null ? mn : Math.min(e.drsMin, mn);
    if (mx != null) e.drsMax = e.drsMax == null ? mx : Math.max(e.drsMax, mx);
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
    select: { planId: true, organizationName: true, state: true, mriCopay: true, catScanCopay: true },
    distinct: ["planId"],
  });
  console.log(`${dbPlans.length} distinct DB plans (year ${PLAN_YEAR}).\n`);

  const worklist = [];
  const bucketCounts = { SPREAD: {}, IMPLAUSIBLE: {}, ORPHAN: {} };

  for (const p of dbPlans) {
    if (p.mriCopay == null) continue; // coinsurance-only or N/A — out of scope for this audit
    const src = pbp.get(p.planId) || { drsMin: null, drsMax: null };
    const buckets = [];

    const bothPresent = src.drsMin != null && src.drsMax != null;
    const storedMax = bothPresent ? Math.max(src.drsMin, src.drsMax) : null;
    if (bothPresent && src.drsMin !== src.drsMax && (src.drsMax - src.drsMin) >= SPREAD_MIN && p.mriCopay === storedMax) {
      buckets.push("SPREAD");
    }
    if (p.mriCopay >= IMPLAUSIBLE_FLOOR) {
      buckets.push("IMPLAUSIBLE");
    }
    const matchesPbp = (src.drsMin != null && p.mriCopay === src.drsMin) || (src.drsMax != null && p.mriCopay === src.drsMax);
    if (!matchesPbp) {
      buckets.push("ORPHAN");
    }

    if (buckets.length === 0) continue;
    for (const b of buckets) {
      const carrier = p.organizationName || "UNKNOWN";
      bucketCounts[b][carrier] = (bucketCounts[b][carrier] || 0) + 1;
    }
    worklist.push({
      planId: p.planId,
      organizationName: p.organizationName,
      state: p.state,
      mriCopay: p.mriCopay,
      drsMin: src.drsMin,
      drsMax: src.drsMax,
      buckets,
    });
  }

  for (const bucket of ["SPREAD", "IMPLAUSIBLE", "ORPHAN"]) {
    console.log(`=== ${bucket} ===`);
    const counts = bucketCounts[bucket];
    const carriers = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    let total = 0;
    for (const c of carriers) { console.log(`  ${c}: ${counts[c]}`); total += counts[c]; }
    console.log(`  TOTAL: ${total}\n`);
  }

  console.log(`=== Deduped worklist: ${worklist.length} planIds ===`);
  for (const w of worklist) {
    console.log(`  ${w.planId} (${w.organizationName}, ${w.state}) mriCopay=${w.mriCopay} drs=[${w.drsMin},${w.drsMax}] buckets=${w.buckets.join(",")}`);
  }

  const anchor = worklist.find(w => w.planId === "H1036-329");
  console.log(anchor ? "\nAnchor check: H1036-329 present in worklist." : "\nWARNING: H1036-329 NOT present in worklist — investigate.");

  const outPath = "scripts/data/mri-audit-worklist-2026-07.json";
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: "2026-07-06", planYear: PLAN_YEAR, count: worklist.length, worklist }, null, 2));
  console.log(`\nWorklist written to ${outPath}`);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
