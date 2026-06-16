// scripts/rederive-drugtier-coins-mask.js
//
// Fixes the 2026-06-16 audit's "62% bug": drugTierNCopay's NUMBER is correct (0
// AMOUNT_MISMATCH against PBP mrx_tier), but for many MAPD/CSNP plans the value is
// actually a coinsurance PERCENTAGE that import-cms-data.ts wrote into the copay
// path without ever setting drugTierCoinsuranceMask (see that file's mrx_tier block,
// ~line 611-615 — the comment literally says "will display as $47 but represents 47%").
// enrich-plan-copays-from-pbp.js has the correct rspfd>rsstd>rstd precedence and DOES
// track coinsurance, but only fills NULLs (COALESCE) so it can never correct a value
// import-cms-data.ts already wrote.
//
// This script ONLY rewrites drugTierCoinsuranceMask (the $/% type flag) for MAPD+CSNP
// plans. It never changes drugTierNCopay's numeric value. DSNP is excluded — DSNP tiers
// render LIS copays (lib/lisDrugCopays2026.ts), not the plan's filed tiers.
//
// USAGE:
//   node scripts/rederive-drugtier-coins-mask.js                 # dry-run
//   node scripts/rederive-drugtier-coins-mask.js --apply         # write
//
const fs = require("fs");
const path = require("path");
const { makePrisma } = require("./prisma-client");
const prisma = makePrisma();

const APPLY = process.argv.includes("--apply");
const PLAN_YEAR = 2026;
const PBP_FILE = path.join(process.cwd(), ".cms-import-tmp", "pbp-2026", "pbp_mrx_tier.txt");

function num(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (t === "") return null;
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : null;
}

function loadMrxTier() {
  const raw = fs.readFileSync(PBP_FILE, "latin1").replace(/\r\n/g, "\n");
  const lines = raw.split("\n");
  const H = lines[0].split("\t");
  const idx = (name) => { const i = H.indexOf(name); if (i < 0) throw new Error(`PBP column missing: ${name}`); return i; };
  const cHnum = idx("pbp_a_hnumber"), cPlan = idx("pbp_a_plan_identifier"), cTier = idx("mrx_tier_id");
  const cRspfdCopay = idx("mrx_tier_rspfd_copay_1m"), cRsstdCopay = idx("mrx_tier_rsstd_copay_1m"), cRstdCopay = idx("mrx_tier_rstd_copay_1m");
  const cRspfdCoins = idx("mrx_tier_rspfd_coins_1m"), cRsstdCoins = idx("mrx_tier_rsstd_coins_1m"), cRstdCoins = idx("mrx_tier_rstd_coins_1m");

  // byPlan: planId -> { tierNum -> { copay, isCoins } }
  const byPlan = new Map();
  for (let i = 1; i < lines.length; i++) {
    const r = lines[i].split("\t");
    if (r.length <= cRstdCoins) continue;
    const hnum = (r[cHnum] || "").trim();
    const pid = (r[cPlan] || "").trim();
    if (!hnum || !pid) continue;
    const planId = `${hnum}-${parseInt(pid, 10)}`;
    const tierNum = parseInt((r[cTier] || "").trim(), 10);
    if (!Number.isFinite(tierNum) || tierNum < 1 || tierNum > 6) continue;

    let copay = num(r[cRspfdCopay]);
    if (copay === null) copay = num(r[cRsstdCopay]);
    if (copay === null) copay = num(r[cRstdCopay]);
    let isCoins = false;
    if (copay === null) {
      copay = num(r[cRspfdCoins]);
      if (copay === null) copay = num(r[cRsstdCoins]);
      if (copay === null) copay = num(r[cRstdCoins]);
      if (copay !== null) isCoins = true;
    }
    if (copay === null) continue;
    const e = byPlan.get(planId) || {};
    if (!(tierNum in e)) e[tierNum] = { copay, isCoins };
    byPlan.set(planId, e);
  }
  return byPlan;
}

async function main() {
  console.log(`PBP file: ${PBP_FILE}`);
  const pbp = loadMrxTier();
  console.log(`Parsed mrx_tier for ${pbp.size} planIds.`);

  const plans = await prisma.plan.findMany({
    where: { planYear: PLAN_YEAR, planCategory: { in: ["MAPD", "CSNP"] } },
    select: {
      planId: true, organizationName: true, planCategory: true,
      drugTier1Copay: true, drugTier2Copay: true, drugTier3Copay: true,
      drugTier4Copay: true, drugTier5Copay: true, drugTier6Copay: true,
      drugTierCoinsuranceMask: true,
    },
    distinct: ["planId"],
  });
  console.log(`${plans.length} distinct MAPD+CSNP plans (year ${PLAN_YEAR}).`);

  let changed = 0, unchanged = 0, noPbp = 0, changedRows = 0;
  const samples = [];
  const HEADLINE = new Set(["H2406-37", "R0759-1", "H5525-42", "H5216-229", "H7301-27", "H0628-31", "H1290-46"]);
  const flippedAwayFromCoins = []; // tiers that LOSE coinsurance flag — worth a closer look

  for (const p of plans) {
    const pbpTiers = pbp.get(p.planId);
    if (!pbpTiers) { noPbp++; continue; }
    const oldMask = p.drugTierCoinsuranceMask || "";
    const newCoinsTiers = [];
    for (let t = 1; t <= 6; t++) {
      const dbVal = p[`drugTier${t}Copay`];
      const src = pbpTiers[t];
      if (dbVal == null || !src) continue; // don't invent flags for tiers with no DB value or no PBP match
      if (src.isCoins) newCoinsTiers.push(t);
    }
    const newMask = newCoinsTiers.length ? newCoinsTiers.join("") : null;
    const oldSet = new Set(oldMask.split("").filter(Boolean));
    const newSet = new Set(newCoinsTiers.map(String));
    const same = oldSet.size === newSet.size && [...oldSet].every((d) => newSet.has(d));
    if (same) { unchanged++; continue; }

    changed++;
    // Track any tier that HAD a coinsurance flag and is losing it (regression risk)
    for (const d of oldSet) if (!newSet.has(d)) flippedAwayFromCoins.push({ planId: p.planId, tier: d });

    if (samples.length < 30 || HEADLINE.has(p.planId)) {
      samples.push(`${p.planId} ${p.organizationName} (${p.planCategory}): mask "${oldMask}" -> "${newMask || ''}"`);
    }
    if (APPLY) {
      const r = await prisma.plan.updateMany({
        where: { planId: p.planId, planYear: PLAN_YEAR },
        data: { drugTierCoinsuranceMask: newMask },
      });
      changedRows += r.count;
    }
  }

  console.log(`\nPlans with mask change: ${changed} | unchanged: ${unchanged} | no PBP match: ${noPbp}`);
  console.log(`Tiers LOSING a coinsurance flag (regression risk, should be 0 or near-0): ${flippedAwayFromCoins.length}`);
  if (flippedAwayFromCoins.length) console.log(JSON.stringify(flippedAwayFromCoins.slice(0, 20), null, 2));
  console.log(`\nSample / headline (up to 30):`);
  for (const s of samples) console.log("  " + s);
  if (APPLY) console.log(`\nRows written: ${changedRows}`);
  else console.log(`\nDry-run — no writes. Re-run with --apply to persist.`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
