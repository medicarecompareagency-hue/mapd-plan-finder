// backfill-lis-premiums.js
// Populates partCPremium, partDPremium on all licensed-state plans for 2026.
//
// Sources (priority order):
//   1. CMS CY2026 Landscape (cy2026-landscape-202603.csv) — authoritative for all plan types.
//      Has "Monthly Consolidated Premium (Part C + D)" per county.  Use this first.
//   2. NBER ma2026.csv — secondary fallback (covers 2025 NBER plans, not new 2026 contracts).
//   3. PBP Section D (pbp_Section_D.txt) — pbp_d_mplusc_premium = Part C (M+C) premium.
//      Used to split consolidated into partC and partD.
//
// For each plan:
//   partC = PBP Section D Part C premium (often $0 for MAPD plans)
//   consolidated = CMS 2026 landscape consolidated → NBER → plan.monthlyPremium fallback
//   partD = max(0, consolidated − partC)  [MA-Only / DSNP → 0 by definition]
//   monthlyPremium is reconciled to consolidated so all premium math is consistent.

const fs = require("fs");
const path = require("path");
const { makePrisma } = require("./prisma-client");
const { LICENSED_STATES } = require("./licensed-states");

const PBP_DIR    = path.join(__dirname, "..", ".cms-import-tmp", "pbp-2026");
const LANDSCAPE  = path.join(__dirname, "..", ".cms-import-tmp", "ma2026.csv"); // NBER fallback
const CMS_LANDSCAPE_2026 = path.join(__dirname, "..", ".cms-import-tmp",
  "cy2026-landscape", "CY2026_Landscape_202603", "CY2026_Landscape_202603.csv");
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

// RFC-4180 CSV parser (handles quoted fields with embedded commas like "$2,100.00")
function parseCSVLine(line) {
  const fields = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i+1] === '"') { field += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(field.trim());
      field = "";
    } else {
      field += ch;
    }
  }
  fields.push(field.trim());
  return fields;
}

function numFromDollar(s) {
  if (!s) return 0;
  const n = parseFloat(s.replace(/[$,]/g, "").trim());
  return isNaN(n) ? 0 : n;
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

  // ── CMS 2026 Landscape (primary premium source) ────────────────────────
  const cms2026Map = new Map(); // planId → { consolidated, hasDrug }
  if (fs.existsSync(CMS_LANDSCAPE_2026)) {
    console.log("Loading CMS CY2026 Landscape (primary premium source)...");
    const cmsText = fs.readFileSync(CMS_LANDSCAPE_2026, "utf8");
    const cmsLines = cmsText.split(/\r?\n/).filter(Boolean);
    const cmsH = parseCSVLine(cmsLines[0]);
    const cmsIContract   = cmsH.indexOf("Contract ID");
    const cmsIPlan       = cmsH.indexOf("Plan ID");
    const cmsIState      = cmsH.indexOf("State Territory Abbreviation");
    const cmsIOrg        = cmsH.indexOf("Organization Marketing Name");
    const cmsIConsolidated = cmsH.indexOf("Monthly Consolidated Premium (Part C + D)");
    const cmsIDrugType   = cmsH.indexOf("Drug Benefit Type");
    for (const line of cmsLines.slice(1)) {
      const cols = parseCSVLine(line);
      const state = cols[cmsIState]?.trim();
      if (!LICENSED_STATES.includes(state)) continue;
      const org = cols[cmsIOrg]?.trim();
      if (!LICENSED_CARRIERS.has(org)) continue;
      const id = normId(cols[cmsIContract], cols[cmsIPlan]);
      if (!cms2026Map.has(id)) {
        const consolidated = numFromDollar(cols[cmsIConsolidated]);
        const hasDrug = !!cols[cmsIDrugType]?.trim() &&
                        cols[cmsIDrugType].trim() !== "Not Applicable";
        cms2026Map.set(id, { consolidated, hasDrug });
      }
    }
    console.log(`  CMS 2026 map: ${cms2026Map.size} planIds (licensed states+carriers)`);
  } else {
    console.warn(`  WARNING: CMS CY2026 Landscape not found at ${CMS_LANDSCAPE_2026}`);
  }

  // ── Consolidated map from ma2026.csv (NBER fallback) ────────────────────
  console.log("Loading ma2026.csv (NBER fallback)...");
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
  console.log(`  NBER map: ${consolidatedMap.size} planIds (licensed states)`);

  // ── Load plans from DB ─────────────────────────────────────────────────
  console.log("Loading plans from DB...");
  const dbPlans = await prisma.plan.findMany({
    where: { planYear: YEAR, state: { in: LICENSED_STATES }, organizationName: { in: [...LICENSED_CARRIERS] } },
    select: { id: true, planId: true, planCategory: true, monthlyPremium: true },
    orderBy: { planId: "asc" },
  });
  console.log(`  DB plans: ${dbPlans.length} rows`);

  // ── Compute per-planId updates (deduplicated) ──────────────────────────
  // Priority: (1) CMS 2026 Landscape → (2) NBER landscape → (3) plan.monthlyPremium fallback
  const byPlanId = new Map(); // planId → { partC, partD, consolidated, source }
  let nCms2026 = 0, nNber = 0, nFallback = 0;
  for (const plan of dbPlans) {
    if (byPlanId.has(plan.planId)) continue;
    const partC = partCMap.get(plan.planId) ?? 0;

    // 1. CMS 2026 Landscape (most authoritative; covers all 2026 contracts)
    const cms = cms2026Map.get(plan.planId);
    if (cms) {
      const partD = cms.hasDrug ? Math.max(0, cms.consolidated - partC) : 0;
      byPlanId.set(plan.planId, { partC, partD, consolidated: cms.consolidated, source: "CMS2026" });
      nCms2026++;
      continue;
    }

    // 2. NBER landscape (2025 data; good for plans that existed in 2025)
    const ls = consolidatedMap.get(plan.planId);
    if (ls) {
      const partD = ls.hasDrug ? Math.max(0, ls.consolidated - partC) : 0;
      byPlanId.set(plan.planId, { partC, partD, consolidated: ls.consolidated, source: "NBER" });
      nNber++;
      continue;
    }

    // 3. Fallback: DSNP $0 by design; others use existing monthlyPremium
    const consolidated = plan.monthlyPremium;
    const partD = (plan.planCategory === "DSNP" || plan.planCategory === "MA_ONLY")
      ? 0
      : Math.max(0, consolidated - partC);
    byPlanId.set(plan.planId, { partC, partD, consolidated, source: "fallback" });
    nFallback++;
  }
  console.log(`\nSources: CMS2026=${nCms2026} NBER=${nNber} Fallback=${nFallback}`);
  console.log(`Total unique planIds to update: ${byPlanId.size}`);

  // Spot-check: how many plans will have monthlyPremium change by >$1?
  const bigChanges = [];
  for (const plan of dbPlans) {
    const upd = byPlanId.get(plan.planId);
    const inAnyLandscape = cms2026Map.has(plan.planId) || consolidatedMap.has(plan.planId);
    if (upd && inAnyLandscape && Math.abs(upd.consolidated - plan.monthlyPremium) > 1) {
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
