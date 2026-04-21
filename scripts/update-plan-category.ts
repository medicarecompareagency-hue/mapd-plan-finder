/**
 * update-plan-category.ts
 *
 * Fast retroactive fill for the new Plan Type columns
 * (planCategory, snpSubtype, chronicConditions[], hasPartD,
 * isZeroDollarDsnp, cmsContractType) on rows that were imported
 * BEFORE the Plan Type expansion landed.
 *
 * Re-running the full `import-cms-data.ts` to rebuild those columns
 * takes ~3.5 hours because its delete-then-create path walks every
 * row individually. This script just UPDATEs — it doesn't touch
 * premiums, benefits, MOOP, or any other field that's already in
 * the DB. All it needs is `pbp_Section_A.txt` (already cached
 * under `.cms-import-tmp/`).
 *
 * Algorithm:
 *   1. Read `pbp_Section_A.txt` for the given year.
 *   2. Build a map from planId (`${contractId}-${parseInt(planNum)}`)
 *      to { planCategory, snpSubtype, chronicConditions, hasPartD,
 *      isZeroDollarDsnp, cmsContractType }.
 *   3. For each entry, `prisma.plan.updateMany({ where:
 *      { planYear, planId } })` — Prisma fans that out to a single
 *      UPDATE that touches every (state, county) variant of the plan
 *      in one round-trip.
 *
 *   npx tsx scripts/update-plan-category.ts 2025
 *   npx tsx scripts/update-plan-category.ts 2026   # safe to re-run
 */

import {
  PrismaClient,
  PlanCategory,
  SnpSubtype,
  ChronicCondition,
} from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

const args = process.argv.slice(2);
const PLAN_YEAR = parseInt(args.find((a) => /^\d{4}$/.test(a)) || "2026", 10);
const PBP_DIR = path.join(process.cwd(), ".cms-import-tmp", `pbp-${PLAN_YEAR}`);

function makeClient(): PrismaClient {
  return new PrismaClient({
    datasources: {
      db: { url: process.env.DIRECT_URL || process.env.DATABASE_URL },
    },
    log: ["warn", "error"],
  });
}

// ---------------------------------------------------------------------------
// Code -> label / enum mappings (copy of the ones in import-cms-data.ts)
// ---------------------------------------------------------------------------
const CONTRACT_TYPE_LABELS: Record<string, string> = {
  "01": "HMO", "02": "HMOPOS", "04": "Local PPO", "05": "PSO",
  "07": "MSA", "08": "RFB PFFS", "09": "PFFS",
  "18": "1876 Cost", "19": "HCPP - 1833 Cost", "20": "National PACE",
  "29": "PDP", "30": "Employer/Union Direct PDP", "31": "Regional PPO",
  "32": "Fallback", "40": "Employer/Union Direct PFFS",
  "42": "RFB HMO", "43": "RFB HMOPOS", "44": "RFB Local PPO",
  "45": "RFB PSO", "47": "Employer Direct PPO", "48": "MMP",
};

const CHRONIC_CONDITION_BY_POSITION: ChronicCondition[] = [
  ChronicCondition.ALCOHOL_SUD, ChronicCondition.AUTOIMMUNE,
  ChronicCondition.CANCER, ChronicCondition.CARDIOVASCULAR,
  ChronicCondition.CHRONIC_HEART_FAILURE, ChronicCondition.DEMENTIA,
  ChronicCondition.DIABETES, ChronicCondition.GASTROINTESTINAL,
  ChronicCondition.CHRONIC_KIDNEY_DISEASE, ChronicCondition.HEMATOLOGIC,
  ChronicCondition.HIV_AIDS, ChronicCondition.LUNG_DISORDERS,
  ChronicCondition.MENTAL_HEALTH, ChronicCondition.NEUROLOGIC,
  ChronicCondition.STROKE, ChronicCondition.CHF_AND_CVD,
  ChronicCondition.DIABETES_AND_CVD, ChronicCondition.CHF_AND_DIABETES,
  ChronicCondition.DIABETES_CHF_CVD, ChronicCondition.STROKE_AND_CVD,
  ChronicCondition.METABOLIC_SYNDROME, ChronicCondition.POST_TRANSPLANT,
  ChronicCondition.IMMUNODEFICIENCY, ChronicCondition.COGNITIVE_IMPAIRMENT,
  ChronicCondition.FUNCTIONAL_CHALLENGES, ChronicCondition.SENSORY_IMPAIRMENT,
  ChronicCondition.THERAPY_MAINTENANCE, ChronicCondition.ANXIETY_WITH_COPD,
  ChronicCondition.CKD_AND_TRANSPLANT, ChronicCondition.SUD_AND_MH,
  ChronicCondition.OTHER_1, ChronicCondition.OTHER_2, ChronicCondition.OTHER_3,
];

function decodeSnpCond(bitString: string | undefined): ChronicCondition[] {
  if (!bitString) return [];
  const out: ChronicCondition[] = [];
  for (let i = 0; i < bitString.length; i++) {
    if (bitString[i] === "1") {
      const c = CHRONIC_CONDITION_BY_POSITION[i];
      if (c) out.push(c);
    }
  }
  return out;
}

function deriveIsnpSubtype(institutionalType: string): SnpSubtype | null {
  switch (institutionalType.trim()) {
    case "1": return SnpSubtype.ISNP_FACILITY;
    case "2": return SnpSubtype.ISNP_EQUIVALENT;
    case "3": return SnpSubtype.ISNP_HYBRID;
    default: return null;
  }
}

function derivePlanCategory(a: {
  snpFlag: string; snpType: string; planType: string; partD: string;
}): PlanCategory {
  if (a.snpFlag === "1") {
    if (a.snpType === "3") return PlanCategory.DSNP;
    if (a.snpType === "4") return PlanCategory.CSNP;
    if (a.snpType === "1") return PlanCategory.ISNP;
  }
  if (a.planType === "29" || a.planType === "30") return PlanCategory.PDP;
  if (a.planType === "18" || a.planType === "19") return PlanCategory.COST;
  if (a.planType === "20") return PlanCategory.PACE;
  if (a.planType === "07") return PlanCategory.MSA;
  if (a.planType === "48") return PlanCategory.MMP;
  if (a.partD === "1") return PlanCategory.MAPD;
  return PlanCategory.MA_ONLY;
}

// ---------------------------------------------------------------------------
// TSV parser that keeps the FIRST occurrence of duplicate column names.
// ---------------------------------------------------------------------------
type Row = Record<string, string>;

function parseTSV(filePath: string): Row[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Required file not found: ${filePath}`);
  }
  const buf = fs.readFileSync(filePath, "utf-8");
  const lines = buf.split(/\r?\n/);
  if (lines.length === 0) return [];
  const header = lines[0].split("\t");
  const idx = new Map<string, number>();
  header.forEach((name, i) => { if (!idx.has(name)) idx.set(name, i); });

  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cells = line.split("\t");
    const row: Row = {};
    for (const [name, j] of idx) row[name] = cells[j] ?? "";
    rows.push(row);
  }
  return rows;
}

interface PlanMeta {
  planCategory: PlanCategory;
  snpSubtype: SnpSubtype | null;
  chronicConditions: ChronicCondition[];
  hasPartD: boolean;
  isZeroDollarDsnp: boolean | null;
  cmsContractType: string | null;
}

// ---------------------------------------------------------------------------
// Build planId -> meta map. Section A is keyed by (hnumber, planid, segment);
// the DB dedups segments (uses plan-level planId). Where two segments of the
// same plan disagree on classification (very rare), the first wins — that's
// consistent with the original import behavior.
// ---------------------------------------------------------------------------
function buildMetaMap(): Map<string, PlanMeta> {
  console.log("Reading pbp_Section_A.txt...");
  const rows = parseTSV(path.join(PBP_DIR, "pbp_Section_A.txt"));
  console.log(`  ${rows.length} rows`);

  const map = new Map<string, PlanMeta>();
  for (const r of rows) {
    const h = (r.pbp_a_hnumber || "").trim();
    const p = (r.pbp_a_plan_identifier || "").trim();
    if (!h || !p) continue;

    const planId = `${h}-${parseInt(p, 10)}`;
    if (map.has(planId)) continue; // first segment wins

    const planType = (r.pbp_a_plan_type || "").trim();
    const snpFlag = (r.pbp_a_special_need_flag || "").trim();
    const snpType = (r.pbp_a_special_need_plan_type || "").trim();
    const partD = (r.pbp_a_contract_partd_flag || "").trim();
    const cat = derivePlanCategory({ snpFlag, snpType, planType, partD });

    map.set(planId, {
      planCategory: cat,
      snpSubtype: cat === PlanCategory.ISNP
        ? deriveIsnpSubtype(r.pbp_a_snp_institutional_type || "")
        : null,
      chronicConditions: cat === PlanCategory.CSNP
        ? decodeSnpCond(r.pbp_a_snp_cond)
        : [],
      hasPartD: partD === "1",
      isZeroDollarDsnp: cat === PlanCategory.DSNP
        ? ((r.pbp_a_dsnp_zerodollar || "").trim() === "1" ? true
           : (r.pbp_a_dsnp_zerodollar || "").trim() === "2" ? false : null)
        : null,
      cmsContractType: planType ? (CONTRACT_TYPE_LABELS[planType] ?? null) : null,
    });
  }
  console.log(`  ${map.size.toLocaleString()} distinct planIds`);
  return map;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\nRetroactive Plan Type column fill for plan year ${PLAN_YEAR}`);
  console.log("================================================\n");

  const meta = buildMetaMap();
  let prisma = makeClient();

  console.log("\nChecking DB coverage...");
  const dbPlanIds = await prisma.plan.findMany({
    where: { planYear: PLAN_YEAR },
    select: { planId: true },
    distinct: ["planId"],
  });
  const dbPlanIdSet = new Set(dbPlanIds.map((p) => p.planId));
  console.log(`  ${dbPlanIdSet.size.toLocaleString()} distinct planIds in DB for ${PLAN_YEAR}`);

  // The plans we can update are the intersection.
  const updatable = [...meta.entries()].filter(([pid]) => dbPlanIdSet.has(pid));
  console.log(`  ${updatable.length.toLocaleString()} planIds present in both DB and Section A`);

  const categoryTotals = new Map<PlanCategory, number>();
  for (const [, m] of updatable) {
    categoryTotals.set(m.planCategory, (categoryTotals.get(m.planCategory) ?? 0) + 1);
  }
  console.log("\nPlanIds by derived category:");
  for (const [c, n] of [...categoryTotals.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(c).padEnd(10)} ${n.toLocaleString().padStart(6)}`);
  }

  // -------------------------------------------------------------------------
  // Run the updates. Each `updateMany` touches every (state, county) variant
  // of a planId in a single round-trip, so ~6-8K queries total.
  // -------------------------------------------------------------------------
  const RECYCLE_AFTER = 500;
  let updatedPlans = 0;
  let updatedRows = 0;
  let sinceRecycle = 0;
  const startTime = Date.now();

  console.log("\nUpdating...");
  for (const [planId, m] of updatable) {
    const res = await prisma.plan.updateMany({
      where: { planYear: PLAN_YEAR, planId },
      data: {
        planCategory: m.planCategory,
        snpSubtype: m.snpSubtype,
        chronicConditions: m.chronicConditions,
        hasPartD: m.hasPartD,
        isZeroDollarDsnp: m.isZeroDollarDsnp,
        cmsContractType: m.cmsContractType,
      },
    });
    updatedPlans++;
    updatedRows += res.count;
    sinceRecycle++;

    if (updatedPlans % 500 === 0 || updatedPlans === updatable.length) {
      const pct = ((updatedPlans / updatable.length) * 100).toFixed(1);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(
        `  ${updatedPlans.toLocaleString().padStart(5)} / ${updatable.length.toLocaleString()} planIds (${pct}%) — ${updatedRows.toLocaleString()} rows — elapsed ${elapsed}s`,
      );
    }

    if (sinceRecycle >= RECYCLE_AFTER && updatedPlans < updatable.length) {
      await prisma.$disconnect();
      prisma = makeClient();
      sinceRecycle = 0;
    }
  }

  const totalSecs = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(
    `\nDone in ${totalSecs}s. Updated ${updatedRows.toLocaleString()} rows across ${updatedPlans.toLocaleString()} planIds.`,
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
