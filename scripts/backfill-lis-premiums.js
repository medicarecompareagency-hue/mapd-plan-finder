// backfill-lis-premiums.js
// Populates partCPremium, partDPremium on all licensed-state plans for 2026.
//
// Sources:
//   pbp_Section_D.txt  — pbp_d_mplusc_premium = Part C (M+C) premium
//   ma2026.csv         — monthlyconsolidatedpremiumi = Part C + Part D total
//
// Join notes:
//   MAPD + MA_ONLY: 100% matched in landscape → partD = max(0, consolidated−partC)
//   DSNP/CSNP/ISNP: NOT in NBER landscape (separate CMS file). These plans
//     have $0 premium in almost all cases (D-SNP = auto-LIS; $0 Part D by design).
//     For the rare non-zero cases we use existing monthlyPremium as consolidated.
//
// Also reconciles monthlyPremium to the consolidated total so all premium math
// shares one consistent basis going forward.

const fs = require("fs");
const path = require("path");
const { makePrisma } = require("./prisma-client");
const { LICENSED_STATES } = require("./licensed-states");

const PBP_DIR    = path.join(__dirname, "..", ".cms-import-tmp", "pbp-2026");
const LANDSCAPE  = path.join(__dirname, "..", ".cms-import-tmp", "ma2026.csv");
const CHECKPOINT = path.join(__dirname, "..", "lis-backfill-checkpoint.json");
const YEAR       = 2026;
const BATCH      = 100;

const LICENSED_CARRIERS = new Set([
  "HealthSpring","Cigna","Cigna Healthcare","UnitedHealthcare",
  "Wellcare","Aetna Medicare","Humana","Devoted Health",
]);

const STATE_CODES = {
  "Alabama":"AL","Arkansas":"AR","Florida":"FL","Georgia":"GA",
  "Illinois":"IL","Indiana":"IN","Kansas":"KS","Kentucky":"KY",
  "Louisiana":"LA","Missouri":"MO","Mississippi":"MS","Ohio":"OH",
  "Oklahoma":"OK","South Carolina":"SC","Tennessee":"TN","Texas":"TX",
  "Virginia":"VA","West Virginia":"WV",
};

function parseTSVHeader(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headers = lines[0].split("\t").map(h => h.trim());
  return { headers, lines };
}

function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

function normId(contractId, planId) {
  return `${contractId.toUpperCase().trim()}-${parseInt(planId, 10)}`;
}

async function main() {
  const prisma = makePrisma();

  // ── Checkpoint ─────────────────────────────────────────────────────────
  let done = new Set();
  if (fs.existsSync(CHECKPOINT)) {
    done = new Set(JSON.parse(fs.readFileSync(CHECKPOINT, "utf8")));
    console.log(`Resuming: ${done.size} planIds already done.`);
  }

  // ── Part C map from pbp_Section_D.txt ──────────────────────────────────
  console.log("Loading pbp_Section_D.txt...");
  const { headers: secDH, lines: secDL } = parseTSVHeader(path.join(PBP_DIR, "pbp_Section_D.txt"));
  const iHn  = secDH.indexOf("pbp_a_hnumber");
  const iPln = secDH.indexOf("pbp_a_plan_identifier");
  const iPremC = secDH.indexOf("pbp_d_mplusc_premium");
  const partCMap = new Map();
  for (const line of secDL.slice(1)) {
    const cols = line.split("\t");
    const id = normId(cols[iHn], cols[iPln]);
    if (!partCMap.has(id)) partCMap.set(id, num(cols[iPremC]));
  }
  console.log(`  Part C map: ${partCMap.size} planIds`);

  // ── Consolidated map from ma2026.csv ────────────────────────────────────
  console.log("Loading ma2026.csv...");
  const csvText = fs.readFileSync(LANDSCAPE, "utf8");
  const csvLines = csvText.split(/\r?\n/).filter(Boolean);
  const csvH = csvLines[0].split(",").map(h => h.trim());
  const iS = csvH.indexOf("state"), iC2 = csvH.indexOf("contractid");
  const iP2 = csvH.indexOf("planid"), iM = csvH.indexOf("monthlyconsolidatedpremiumi");
  const iDrug = csvH.indexOf("drugbenefittype");
  const consolidatedMap = new Map(); // planId → { consolidated, hasDrug }
  for (const line of csvLines.slice(1)) {
    const cols = line.split(",");
    const stateCode = STATE_CODES[cols[iS]?.trim()];
    if (!stateCode || !LICENSED_STATES.includes(stateCode)) continue;
    const id = normId(cols[iC2], cols[iP2]);
    if (!consolidatedMap.has(id))
      consolidatedMap.set(id, { consolidated: num(cols[iM]), hasDrug: !!cols[iDrug]?.trim() });
  }
  console.log(`  Consolidated map: ${consolidatedMap.size} planIds (licensed states)`);

  // ── Load plans from DB ─────────────────────────────────────────────────
  console.log("Loading plans from DB...");
  const dbPlans = await prisma.plan.findMany({
    where: { planYear: YEAR, state: { in: LICENSED_STATES }, organizationName: { in: [...LICENSED_CARRIERS] } },
    select: { id: true, planId: true, planCategory: true, monthlyPremium: true },
    orderBy: { planId: "asc" },
  });
  console.log(`  DB plans: ${dbPlans.length} rows`);

  // ── Compute per-planId updates (deduplicated) ──────────────────────────
  const byPlanId = new Map(); // planId → { partC, partD, consolidated }
  let lsMatched = 0, lsFallback = 0;
  for (const plan of dbPlans) {
    if (byPlanId.has(plan.planId)) continue; // already computed for this planId
    const partC = partCMap.get(plan.planId) ?? 0;
    const ls = consolidatedMap.get(plan.planId);
    if (ls) {
      const partD = ls.hasDrug ? Math.max(0, ls.consolidated - partC) : 0;
      byPlanId.set(plan.planId, { partC, partD, consolidated: ls.consolidated });
      lsMatched++;
    } else {
      // DSNP/CSNP/ISNP not in NBER landscape — use monthlyPremium as consolidated.
      // 612/615 of these are $0, so partD = 0 is correct. For the rare non-$0
      // ones (CSNP H5652-4 $62.5 etc.), consolidated = monthlyPremium.
      const consolidated = plan.monthlyPremium;
      const partD = (plan.planCategory === "DSNP" || plan.planCategory === "MA_ONLY")
        ? 0
        : Math.max(0, consolidated - partC);
      byPlanId.set(plan.planId, { partC, partD, consolidated });
      lsFallback++;
    }
  }
  console.log(`\nLandscape-sourced: ${lsMatched}, Fallback (SNP/unlisted): ${lsFallback}`);
  console.log(`Total unique planIds to update: ${byPlanId.size}`);

  // Spot-check: how many MAPD plans will have monthlyPremium change by >$1?
  const bigChanges = [];
  for (const plan of dbPlans) {
    const upd = byPlanId.get(plan.planId);
    if (upd && consolidatedMap.has(plan.planId) && Math.abs(upd.consolidated - plan.monthlyPremium) > 1) {
      bigChanges.push(plan);
    }
  }
  const uniqueBigChanges = [...new Map(bigChanges.map(p => [p.planId, p])).values()];
  console.log(`Plans where monthlyPremium will change by >$1: ${uniqueBigChanges.length}`);
  if (uniqueBigChanges.length > 0) {
    console.log("Sample:");
    for (const p of uniqueBigChanges.slice(0, 6)) {
      const upd = byPlanId.get(p.planId);
      console.log(`  ${p.planId} ${p.planCategory}: was $${p.monthlyPremium} → consolidated $${upd?.consolidated} (partC=$${upd?.partC} partD=$${upd?.partD})`);
    }
  }

  // ── Write in batches ───────────────────────────────────────────────────
  const pending = [...byPlanId.entries()].filter(([id]) => !done.has(id));
  console.log(`\nWriting ${pending.length} planIds (${pending.length} updateMany calls)...`);
  let written = 0;
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    await Promise.all(batch.map(([planId, upd]) =>
      prisma.plan.updateMany({
        where: { planId, planYear: YEAR },
        data: { partCPremium: upd.partC, partDPremium: upd.partD, monthlyPremium: upd.consolidated },
      })
    ));
    written += batch.length;
    for (const [planId] of batch) done.add(planId);
    if (written % 200 === 0 || written === pending.length) {
      fs.writeFileSync(CHECKPOINT, JSON.stringify([...done]));
      process.stdout.write(`\r  ${written}/${pending.length} written`);
    }
  }
  console.log("");

  // ── Verification sample ────────────────────────────────────────────────
  console.log("\n── Verification sample ──");
  for (const cat of ["MA_ONLY", "MAPD", "DSNP", "CSNP"]) {
    const sample = await prisma.plan.findMany({
      where: { planYear: YEAR, planCategory: cat, state: { in: LICENSED_STATES } },
      select: { planId: true, state: true, partCPremium: true, partDPremium: true, monthlyPremium: true },
      take: 3,
      orderBy: { monthlyPremium: "desc" },
    });
    console.log(`\n${cat}:`);
    for (const pl of sample) {
      const sum = (pl.partCPremium ?? 0) + (pl.partDPremium ?? 0);
      const ok = Math.abs(sum - pl.monthlyPremium) < 0.02 ? "✓" : "MISMATCH";
      console.log(`  ${pl.planId} ${pl.state}  partC=$${pl.partCPremium}  partD=$${pl.partDPremium}  total=$${pl.monthlyPremium}  ${ok}`);
    }
  }

  await prisma.$disconnect();
  console.log(`\nBackfill complete. ${written} planIds updated.`);
}

main().catch(e => { console.error(e); process.exit(1); });
