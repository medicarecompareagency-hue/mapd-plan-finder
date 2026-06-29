// Targeted one-shot: add H1889-15 (UHC MAPD AL) from CMS PBP files.
// Idempotent — skips rows already in DB. Run once; delete after.
const fs = require("fs");
const path = require("path");
const { makePrisma } = require("./prisma-client");
const { LICENSED_STATES } = require("./licensed-states");

const PBP_DIR = path.join(process.cwd(), ".cms-import-tmp", "pbp-2026");
const TARGET_CONTRACT = "H1889";
const TARGET_PLAN = "015";  // padded
const TARGET_PLAN_INT = 15; // unpadded -> planId = "H1889-15"
const PLAN_YEAR = 2026;
const LICENSED_STATES_SET = new Set(LICENSED_STATES);

const STATE_ABBREVS = {
  Alabama:"AL",Alaska:"AK",Arizona:"AZ",Arkansas:"AR",California:"CA",Colorado:"CO",
  Connecticut:"CT",Delaware:"DE","District of Columbia":"DC",Florida:"FL",Georgia:"GA",
  Hawaii:"HI",Idaho:"ID",Illinois:"IL",Indiana:"IN",Iowa:"IA",Kansas:"KS",Kentucky:"KY",
  Louisiana:"LA",Maine:"ME",Maryland:"MD",Massachusetts:"MA",Michigan:"MI",Minnesota:"MN",
  Mississippi:"MS",Missouri:"MO",Montana:"MT",Nebraska:"NE",Nevada:"NV",
  "New Hampshire":"NH","New Jersey":"NJ","New Mexico":"NM","New York":"NY",
  "North Carolina":"NC","North Dakota":"ND",Ohio:"OH",Oklahoma:"OK",Oregon:"OR",
  Pennsylvania:"PA","Puerto Rico":"PR","Rhode Island":"RI","South Carolina":"SC",
  "South Dakota":"SD",Tennessee:"TN",Texas:"TX",Utah:"UT",Vermont:"VT",Virginia:"VA",
  Washington:"WA","West Virginia":"WV",Wisconsin:"WI",Wyoming:"WY",
};

function parseTSV(filePath) {
  const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/).filter(Boolean);
  const headers = lines[0].split("\t").map(s => s.trim());
  return lines.slice(1).map(line => {
    const cols = line.split("\t");
    const obj = {};
    headers.forEach((h, i) => { obj[h] = cols[i] ?? ""; });
    return obj;
  });
}

function num(s) {
  if (!s) return null;
  const t = String(s).trim();
  const n = parseFloat(t);
  return isNaN(n) ? null : n;
}

// --- Section A: get plan name, org, finance classification ---
console.log("Reading pbp_Section_A.txt for H1889-015...");
const secA = parseTSV(path.join(PBP_DIR, "pbp_Section_A.txt"));
const planInfo = secA.find(r =>
  r.pbp_a_hnumber?.trim().toUpperCase() === TARGET_CONTRACT &&
  r.pbp_a_plan_identifier?.trim() === TARGET_PLAN
);
if (!planInfo) { console.error("H1889-015 not found in Section A — abort"); process.exit(1); }

const orgName = planInfo.pbp_a_org_marketing_name?.trim() || planInfo.pbp_a_org_name?.trim() || "UnitedHealthcare";
const planName = planInfo.pbp_a_plan_name?.trim() || "H1889-15";
const cmsContractType = planInfo.pbp_a_plan_type?.trim() === "04" ? "Local PPO" : (planInfo.pbp_a_plan_type?.trim() || "PPO");
const hasPartD = planInfo.pbp_a_contract_partd_flag?.trim() === "1";
console.log(`  org="${orgName}" planName="${planName}" partD=${hasPartD} type=${cmsContractType}`);

// --- Section D: get premium / deductible ---
console.log("Reading pbp_Section_D.txt for H1889-015...");
const secD = parseTSV(path.join(PBP_DIR, "pbp_Section_D.txt"));
const financeRow = secD.find(r =>
  r.pbp_a_hnumber?.trim().toUpperCase() === TARGET_CONTRACT &&
  r.pbp_a_plan_identifier?.trim() === TARGET_PLAN
);
const monthlyPremium = num(financeRow?.pbp_d_mplusc_premium) ?? 0;
const medicalDeductible = financeRow?.pbp_d_ann_deduct_yn === "1"
  ? (num(financeRow?.pbp_d_ann_deduct_amt) ?? 0) : 0;
const maxOutOfPocket = num(financeRow?.pbp_d_moop_amt_in) ?? null;
const partBGiveback = num(financeRow?.pbp_d_ptb_reduct_amt) ?? 0;
console.log(`  premium=$${monthlyPremium} deductible=$${medicalDeductible} moop=${maxOutOfPocket}`);

// --- PlanArea.txt: get state+county rows ---
console.log("Reading PlanArea.txt for H1889-015...");
const paLines = fs.readFileSync(path.join(PBP_DIR, "PlanArea.txt"), "utf-8").split(/\r?\n/).filter(Boolean);
const paH = paLines[0].split("\t").map(s => s.trim());
const iHn = paH.indexOf("pbp_a_hnumber");
const iPl = paH.indexOf("pbp_a_plan_identifier");
const iState = paH.indexOf("stcd");
const iCounty = paH.indexOf("county");
const iPending = paH.indexOf("pending_flag");
const iEghp = paH.indexOf("eghp_flag");

const locations = [];
const seen = new Set();
for (const line of paLines.slice(1)) {
  const c = line.split("\t");
  if (c[iHn]?.trim().toUpperCase() !== TARGET_CONTRACT) continue;
  if (c[iPl]?.trim() !== TARGET_PLAN) continue;
  if (c[iPending]?.trim() === "1") continue;
  if (c[iEghp]?.trim() === "1") continue;
  const stFull = c[iState]?.trim();
  const stAbbrev = STATE_ABBREVS[stFull] || stFull;
  const county = c[iCounty]?.trim();
  if (!stAbbrev || !county) continue;
  if (!LICENSED_STATES_SET.has(stAbbrev)) continue;
  const key = `${stAbbrev}|${county}`;
  if (seen.has(key)) continue;
  seen.add(key);
  locations.push({ state: stAbbrev, county });
}
console.log(`  Found ${locations.length} licensed state+county rows for H1889-15`);

if (locations.length === 0) { console.error("No licensed state+county rows found — abort"); process.exit(1); }

// --- DB: check existing rows ---
const prisma = makePrisma();
(async () => {
  const existing = await prisma.plan.findMany({
    where: { planId: "H1889-15", planYear: PLAN_YEAR },
    select: { state: true, county: true },
  });
  const existingSet = new Set(existing.map(r => `${r.state}|${r.county}`));
  console.log(`  ${existingSet.size} rows already in DB`);

  const toInsert = locations
    .filter(loc => !existingSet.has(`${loc.state}|${loc.county}`))
    .map(loc => ({
      planYear: PLAN_YEAR,
      planId: "H1889-15",
      planName,
      organizationName: orgName,
      planType: cmsContractType,
      planCategory: "MAPD",
      snpSubtype: null,
      chronicConditions: [],
      hasPartD,
      isZeroDollarDsnp: null,
      cmsContractType,
      state: loc.state,
      county: loc.county,
      zipCode: null,
      monthlyPremium,
      partBGivebackAmount: partBGiveback,
      lowIncomeSubsidyLevel: null,
      medicaidLevel: null,
      medicalDeductible,
      maxOutOfPocket,
      drugDeductible: 0,
      otcAllowance: 0,
      foodCardAllowance: 0,
    }));

  if (toInsert.length === 0) {
    console.log("Nothing to insert — all rows already in DB.");
    await prisma.$disconnect();
    return;
  }

  console.log(`\nInserting ${toInsert.length} new rows for H1889-15...`);
  const BATCH = 50;
  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += BATCH) {
    await prisma.plan.createMany({ data: toInsert.slice(i, i + BATCH) });
    inserted += Math.min(BATCH, toInsert.length - i);
  }
  console.log(`Done. Inserted ${inserted} rows for H1889-15.`);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
