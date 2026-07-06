// scripts/rederive-outpatient-hospital.js
//
// Re-derives outpatientHospitalCoinsPct (WRITE TARGET) for every 2026 plan
// from PBP b9a (Outpatient Hospital Services). Range rule (Dale, 2026-07-06,
// mirrors the MRI range-max rule): a filed range's MIN is commonly a
// preventive/carve-out floor (e.g. 0% for a screening colonoscopy), not the
// general rate a member pays for typical outpatient hospital surgery/services.
// The headline value must be the MAX (the general rate), never the carve-out.
//
// Bug fixed: import-cms-data.ts's coinsPct() helper read MIN first (falling
// back to max only if min was blank), so a filed "0%-20%" range surfaced as
// 0% -- e.g. H4407-4 (HealthSpring TotalCare).
//
// outpatientHospitalCopay is NEVER written by this script. Its base
// derivation already used max() and was never buggy, AND some FULL_DUAL DSNP
// plans have copay INTENTIONALLY set to 0 by enrich-dsnp-fulldual-coins-as-
// zero.js to override a coinsurance-only benefit (Medicaid covers the
// coinsurance for FULL_DUAL). cs() in plan-detail-modal.tsx renders copay
// ahead of coinsPct whenever copay is non-null -- so leaving that intentional
// $0 alone while still fixing the underlying coinsPct is exactly right: the
// FULL_DUAL view keeps showing $0 (correct), while every other view (default,
// PARTIAL_DUAL) that falls through to coinsPct now sees the true rate.
// Copay is still loaded/printed here for context, never for comparison/write.
//
// USAGE (from repo root):
//   node scripts/rederive-outpatient-hospital.js                 # dry-run
//   node scripts/rederive-outpatient-hospital.js --apply         # write
//   node scripts/rederive-outpatient-hospital.js --pbp <path>    # override PBP file path
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
  : path.join(process.cwd(), ".cms-import-tmp", `pbp-${PLAN_YEAR}`, "pbp_b9_outpat_hosp.txt");

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
    console.error(`Point --pbp at pbp_b9_outpat_hosp.txt (the b9 'outpatient hospital' staging file).`);
    process.exit(1);
  }
  const raw = fs.readFileSync(PBP_FILE, "utf8").replace(/\r\n/g, "\n");
  const lines = raw.split("\n");
  const H = lines[0].split("\t");
  const col = (n) => { const i = H.indexOf(n); if (i < 0) throw new Error(`PBP column missing: ${n}`); return i; };
  const cHnum = col("pbp_a_hnumber");
  const cPlan = col("pbp_a_plan_identifier");
  const cCopYn = col("pbp_b9a_copay_yn");
  const cCopMin = col("pbp_b9a_copay_ohs_amt_min");
  const cCopMax = col("pbp_b9a_copay_ohs_amt_max");
  const cCoinYn = col("pbp_b9a_coins_yn");
  const cCoinMin = col("pbp_b9a_coins_ohs_pct_min");
  const cCoinMax = col("pbp_b9a_coins_ohs_pct_max");

  const cSeg = col("segment_id");

  // NOTE: the real importer keys plans by `${hnum}-${plan}-${segment_id||"0"}`
  // (import-cms-data.ts planKey()) -- different segments of the same contract
  // can legitimately file different rates. An earlier version of this script
  // collapsed all segments into one planId key, which produced false
  // "ambiguous" flags for plans where the DB already correctly stores a
  // different value per segment (e.g. H1951-47: segment 1 = $155, segment 2 =
  // $135, both already correct). Key by planId+segment to match reality.
  const byPlan = new Map(); // "planId::segmentKey" -> { copay, coins, ambiguous }
  for (let i = 1; i < lines.length; i++) {
    const r = lines[i].split("\t");
    if (r.length <= cCoinMax) continue;
    const hnum = (r[cHnum] || "").trim();
    const pid = (r[cPlan] || "").trim();
    if (!hnum || !pid) continue;
    const planId = `${hnum}-${parseInt(pid, 10)}`;
    const rawSeg = (r[cSeg] || "").trim();
    const segmentKey = (rawSeg === "" || rawSeg === "0") ? "null" : rawSeg;
    const key = `${planId}::${segmentKey}`;
    const e = byPlan.get(key) || { planId, segmentKey, copay: null, coins: null, ambiguous: false };

    // NOTE: unlike MRI's b8b, this benefit files copay_yn and coins_yn
    // independently -- both are frequently "1" on the SAME row (e.g. an
    // in-network copay alongside an out-of-network coinsurance rate). The
    // importer (import-cms-data.ts) writes both fields unconditionally, so
    // this must mirror that -- NOT suppress coins just because a copay exists.
    if ((r[cCopYn] || "").trim() === "1") {
      const mn = num(r[cCopMin]), mx = num(r[cCopMax]);
      // Range-max rule applies to a filed copay range too (a carve-out could
      // in principle be filed as $0 copay vs. a higher general-rate copay).
      const pick = (mn != null && mx != null) ? Math.max(mn, mx) : (mx != null ? mx : mn);
      if (pick != null) {
        if (e.copay != null && e.copay !== pick) e.ambiguous = true;
        e.copay = e.copay == null ? pick : Math.max(e.copay, pick);
      }
    }
    if ((r[cCoinYn] || "").trim() === "1") {
      const mn = num(r[cCoinMin]), mx = num(r[cCoinMax]);
      const pick = (mn != null && mx != null) ? Math.max(mn, mx) : (mx != null ? mx : mn);
      if (pick != null) {
        if (e.coins != null && e.coins !== pick) e.ambiguous = true;
        e.coins = e.coins == null ? pick : Math.max(e.coins, pick);
      }
    }
    byPlan.set(key, e);
  }
  return byPlan;
}

async function main() {
  console.log(`PBP file: ${PBP_FILE}`);
  const pbp = loadPbp();
  console.log(`Parsed b9a OHS data for ${pbp.size} planIds.`);

  const dbPlans = await prisma.plan.findMany({
    where: { planYear: PLAN_YEAR },
    select: { planId: true, segmentId: true, organizationName: true, outpatientHospitalCopay: true, outpatientHospitalCoinsPct: true },
    distinct: ["planId", "segmentId"],
  });
  console.log(`${dbPlans.length} distinct DB (planId, segmentId) combos (year ${PLAN_YEAR}).`);

  const CARVE_OUT = [], UNDERSTATED = [], UNCHANGED = [], SKIPPED = [];

  for (const p of dbPlans) {
    // DB has a pre-existing inconsistency where some rows store segmentId as
    // the literal string "0" instead of null for "no real segment" (e.g.
    // H4407-4's Madison county row) -- normalize the same way as the PBP side.
    const segmentKey = (p.segmentId == null || p.segmentId === "0") ? "null" : String(p.segmentId);
    const key = `${p.planId}::${segmentKey}`;
    const src = pbp.get(key);
    if (!src) { SKIPPED.push({ planId: p.planId, segmentId: p.segmentId, organizationName: p.organizationName, reason: "no b9a row in PBP for this planId+segment" }); continue; }
    if (src.ambiguous) { SKIPPED.push({ planId: p.planId, segmentId: p.segmentId, organizationName: p.organizationName, reason: "multiple conflicting non-null values across PBP rows for this planId+segment -- SB-verify manually" }); continue; }

    // oldCopay/newCopay are context-only (see file header) -- never compared,
    // never written. Only coinsPct is a write target.
    const oldCopay = p.outpatientHospitalCopay;
    const newCopay = src.copay;
    const oldCoins = p.outpatientHospitalCoinsPct;
    const newCoins = src.coins; // independent of copay -- see loadPbp note

    if (newCoins === oldCoins) {
      UNCHANGED.push({ planId: p.planId, segmentId: p.segmentId, organizationName: p.organizationName, copay: oldCopay, coins: oldCoins });
      continue;
    }

    const entry = { planId: p.planId, segmentId: p.segmentId, organizationName: p.organizationName, oldCopay, newCopay, oldCoins, newCoins };
    const wasCarveOut = oldCoins === 0 && (newCoins ?? 0) > 0;
    if (wasCarveOut) CARVE_OUT.push(entry);
    else UNDERSTATED.push(entry);
  }

  function deltaOf(e) {
    return Math.abs((e.newCoins ?? 0) - (e.oldCoins ?? 0));
  }

  console.log(`\n=== CARVE-OUT SUSPECTS (stored 0, PBP general rate > 0) ===`);
  const carveByCarrier = {};
  for (const e of CARVE_OUT) carveByCarrier[e.organizationName] = (carveByCarrier[e.organizationName] || 0) + 1;
  for (const [c, n] of Object.entries(carveByCarrier).sort((a, b) => b[1] - a[1])) console.log(`  ${c}: ${n}`);
  console.log(`  TOTAL: ${CARVE_OUT.length}`);

  console.log(`\n=== UNDERSTATED (stored < PBP general rate, not a 0-carve-out) ===`);
  const underByCarrier = {};
  for (const e of UNDERSTATED) underByCarrier[e.organizationName] = (underByCarrier[e.organizationName] || 0) + 1;
  for (const [c, n] of Object.entries(underByCarrier).sort((a, b) => b[1] - a[1])) console.log(`  ${c}: ${n}`);
  console.log(`  TOTAL: ${UNDERSTATED.length}`);

  console.log(`\n=== UNCHANGED === ${UNCHANGED.length}`);
  console.log(`\n=== SKIPPED === ${SKIPPED.length}`);
  for (const s of SKIPPED.slice(0, 40)) console.log(`  ${s.planId} seg=${s.segmentId} (${s.organizationName}): ${s.reason}`);
  if (SKIPPED.length > 40) console.log(`  ... and ${SKIPPED.length - 40} more`);

  const allChanged = [...CARVE_OUT, ...UNDERSTATED];
  allChanged.sort((a, b) => deltaOf(b) - deltaOf(a));
  console.log(`\n=== 20 largest deltas ===`);
  for (const e of allChanged.slice(0, 20)) {
    console.log(`  ${e.planId} seg=${e.segmentId} (${e.organizationName}): copay ${e.oldCopay} -> ${e.newCopay}; coins ${e.oldCoins} -> ${e.newCoins}`);
  }

  const anchor = allChanged.find(e => e.planId === "H4407-4");
  if (anchor) {
    console.log(`\nAnchor check: H4407-4 in changed list: coins ${anchor.oldCoins} -> ${anchor.newCoins}`);
    if (anchor.newCoins !== 20) { console.log("ANCHOR GATE FAIL: expected 20. ABORTING."); process.exit(2); }
  } else {
    console.log(`\nWARNING: H4407-4 not in changed list — investigate before applying.`);
  }

  console.log(`\nPlans to change: ${allChanged.length}. ${APPLY ? "APPLYING..." : "DRY-RUN — re-run with --apply to persist."}`);

  if (APPLY) {
    let rows = 0;
    for (const e of allChanged) {
      // outpatientHospitalCopay is intentionally NOT in this data object --
      // see file header (never buggy, and some FULL_DUAL plans rely on an
      // intentional $0 copay override that must survive this pass untouched).
      const r = await prisma.plan.updateMany({
        where: { planId: e.planId, planYear: PLAN_YEAR, segmentId: e.segmentId },
        data: { outpatientHospitalCoinsPct: e.newCoins },
      });
      rows += r.count;
    }
    console.log(`Rows written: ${rows}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
