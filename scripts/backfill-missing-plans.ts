﻿/**
 * backfill-missing-plans.ts
 *
 * Top-up script for backlog item #1.
 *
 * The main `import-cms-data.ts` seeds plan rows from the NBER MA landscape
 * CSV. That file has two big gaps we hit on the 2026 run:
 *
 *   1. NBER hadn't published 2026 yet. The downloader silently fell back to
 *      the 2025 landscape, so SNPs and plans new for 2026 never made it in.
 *   2. NBER's landscape never includes SNPs at all â€” they ship in a separate
 *      CMS file. Even a year-correct landscape would still miss every D-SNP /
 *      C-SNP / I-SNP.
 *
 * This script closes both gaps by treating CMS's own files as the source of
 * truth:
 *
 *   - `PlanArea.txt`       â†’  authoritative plan Ã— county footprint
 *   - `pbp_Section_A.txt`  â†’  plan classification, name, contract type
 *   - `pbp_Section_D.txt`  â†’  premium / deductible / MOOP
 *
 * -------------------------------------------------------------------
 * SCOPE: by default we only backfill the categories that NBER never
 * publishes or that are missing by design:
 *
 *     DSNP / CSNP / ISNP / PACE / MSA / COST / MMP / MA_ONLY
 *
 * We intentionally SKIP MAPD additions unless you pass `--include-mapd`.
 * Those ~289K rows are plans NBER trimmed because they aren't shoppable
 * on Medicare Plan Finder (non-eligible for AEP, closed to new enroll-
 * ment, etc.). Adding them would pollute agent search results.
 * -------------------------------------------------------------------
 *
 * EGHP plans (employer/union group) are always excluded.
 *
 * Idempotent: only inserts (planYear, planId, state, county) rows that
 * don't already exist. Safe to re-run.
 *
 *   npx tsx scripts/backfill-missing-plans.ts 2026
 *   npx tsx scripts/backfill-missing-plans.ts 2026 --include-mapd   (rare)
 */

import {
  PrismaClient,
  PlanCategory,
  SnpSubtype,
  ChronicCondition,
} from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

// Licensed-states gate (added 2026-04-28). PlanArea.txt is a state-blind
// list of every planÃ—county combo CMS publishes; without this filter the
// SNP backfill re-adds non-licensed states the cleanup script just dropped.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { LICENSED_STATES }: { LICENSED_STATES: string[] } = require("./licensed-states");
const LICENSED_STATES_SET = new Set(LICENSED_STATES);

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const PLAN_YEAR = parseInt(args.find((a) => /^\d{4}$/.test(a)) || "2026", 10);
const INCLUDE_MAPD = args.includes("--include-mapd");
const PBP_DIR = path.join(process.cwd(), ".cms-import-tmp", `pbp-${PLAN_YEAR}`);

// Categories we actively want to add. By default SNPs + specialty plans only.
const ALWAYS_INCLUDED: Set<PlanCategory> = new Set([
  PlanCategory.DSNP,
  PlanCategory.CSNP,
  PlanCategory.ISNP,
  PlanCategory.PACE,
  PlanCategory.MSA,
  PlanCategory.COST,
  PlanCategory.MMP,
  PlanCategory.MA_ONLY,
]);

function shouldInsert(cat: PlanCategory): boolean {
  if (ALWAYS_INCLUDED.has(cat)) return true;
  if (cat === PlanCategory.MAPD && INCLUDE_MAPD) return true;
  // PDP, OTHER, and MAPD (without flag) are skipped by default.
  return false;
}

// ---------------------------------------------------------------------------
// Prisma client factory. We recycle the connection every few thousand rows
// to clear Supabase session-pooler prepared-statement cache â€” this is what
// was causing the previous run to deadlock at exactly row 251,000.
// ---------------------------------------------------------------------------
function makeClient(): PrismaClient {
  return new PrismaClient({
    datasources: {
      db: { url: process.env.DIRECT_URL || process.env.DATABASE_URL },
    },
    log: ["warn", "error"],
  });
}

// ---------------------------------------------------------------------------
// Constants (mirrors of the lookups in import-cms-data.ts â€” kept inline so
// this script is self-contained and a refactor of the main importer can't
// silently change the backfill semantics)
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
// (Section A and PlanArea both have duplicate columns. csv-parse keeps the
// last occurrence by default which is the wrong one for our purposes.)
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
  header.forEach((name, i) => {
    if (!idx.has(name)) idx.set(name, i);
  });

  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cells = line.split("\t");
    const row: Row = {};
    for (const [name, j] of idx) {
      row[name] = cells[j] ?? "";
    }
    rows.push(row);
  }
  return rows;
}

function key(h: string, p: string, s: string): string {
  return `${h}-${p}-${s || "0"}`;
}

// ---------------------------------------------------------------------------
// Build per-plan classification map from Section A
// ---------------------------------------------------------------------------
interface PlanInfo {
  planCategory: PlanCategory;
  snpSubtype: SnpSubtype | null;
  chronicConditions: ChronicCondition[];
  hasPartD: boolean;
  isZeroDollarDsnp: boolean | null;
  cmsContractType: string | null;
  planName: string;
  organizationName: string;
}

function buildPlanInfoMap(): Map<string, PlanInfo> {
  console.log("Reading pbp_Section_A.txt...");
  const rows = parseTSV(path.join(PBP_DIR, "pbp_Section_A.txt"));
  console.log(`  ${rows.length} rows in Section A`);

  const map = new Map<string, PlanInfo>();
  for (const r of rows) {
    const h = (r.pbp_a_hnumber || "").trim();
    const p = (r.pbp_a_plan_identifier || "").trim();
    const s = (r.segment_id || "").trim();
    if (!h || !p) continue;

    const planType = (r.pbp_a_plan_type || "").trim();
    const snpFlag = (r.pbp_a_special_need_flag || "").trim();
    const snpType = (r.pbp_a_special_need_plan_type || "").trim();
    const partD = (r.pbp_a_contract_partd_flag || "").trim();

    const cat = derivePlanCategory({ snpFlag, snpType, planType, partD });

    const info: PlanInfo = {
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
      planName: (r.pbp_a_plan_name || "").trim() || `${h}-${p}`,
      organizationName:
        (r.pbp_a_org_marketing_name || "").trim() ||
        (r.pbp_a_org_name || "").trim() ||
        "Unknown",
    };
    map.set(key(h, p, s), info);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Pull premium / deductible / MOOP from Section D so the new rows aren't
// completely empty.
// ---------------------------------------------------------------------------
interface PlanFinance {
  monthlyPremium: number;
  medicalDeductible: number;
  maxOutOfPocket: number | null;
  partBGivebackAmount: number | null;
}

function num(s: string | undefined): number | null {
  if (!s) return null;
  const t = s.trim();
  if (!t) return null;
  const n = parseFloat(t);
  return isNaN(n) ? null : n;
}

function buildFinanceMap(): Map<string, PlanFinance> {
  console.log("Reading pbp_Section_D.txt...");
  const rows = parseTSV(path.join(PBP_DIR, "pbp_Section_D.txt"));
  console.log(`  ${rows.length} rows in Section D`);

  const map = new Map<string, PlanFinance>();
  for (const r of rows) {
    const h = (r.pbp_a_hnumber || "").trim();
    const p = (r.pbp_a_plan_identifier || "").trim();
    const s = (r.segment_id || "").trim();
    if (!h || !p) continue;

    const fin: PlanFinance = {
      monthlyPremium: num(r.pbp_d_mplusc_premium) ?? 0,
      medicalDeductible: r.pbp_d_ann_deduct_yn === "1"
        ? (num(r.pbp_d_ann_deduct_amt) ?? 0)
        : 0,
      maxOutOfPocket: num(r.pbp_d_out_pocket_amt)
        ?? num(r.pbp_d_comb_max_enr_amt)
        ?? num(r.pbp_d_maxenr_oopc_amt),
      // Part B giveback (Dale's MA-Only ranking key #1). Mirrors the
      // logic in import-cms-data.ts so MA-Only plans get their headline
      // ranking input populated when this skeleton-row backfill runs.
      partBGivebackAmount: r.pbp_d_mco_pay_reduct_yn === "1"
        ? num(r.pbp_d_mco_pay_reduct_amt)
        : null,
    };
    map.set(key(h, p, s), fin);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Pull the plan Ã— county footprint from PlanArea.txt (excludes EGHP)
// ---------------------------------------------------------------------------
interface PlanLocation {
  planKey: string;
  state: string;
  county: string;
}

function readPlanArea(): PlanLocation[] {
  console.log("Reading PlanArea.txt...");
  const rows = parseTSV(path.join(PBP_DIR, "PlanArea.txt"));
  console.log(`  ${rows.length} rows in PlanArea`);

  const out: PlanLocation[] = [];
  let skippedEghp = 0;
  let skippedNonLicensed = 0;
  for (const r of rows) {
    if ((r.eghp_flag || "").trim() === "1") { skippedEghp++; continue; }
    const h = (r.pbp_a_hnumber || "").trim();
    const p = (r.pbp_a_plan_identifier || "").trim();
    const s = (r.segment_id || "").trim();
    const st = (r.stcd || "").trim();
    const co = (r.county || "").trim();
    if (!h || !p || !st || !co) continue;
    // Licensed-states gate (2026-04-28): stcd is already a 2-letter code,
    // so we can drop right here without lookup.
    if (!LICENSED_STATES_SET.has(st)) { skippedNonLicensed++; continue; }
    out.push({ planKey: key(h, p, s), state: st, county: co });
  }
  console.log(
    `  ${out.length} non-EGHP planÃ—county rows (skipped ${skippedEghp} EGHP, ` +
      `${skippedNonLicensed} in non-licensed states)`,
  );
  return out;
}

// ---------------------------------------------------------------------------
// Bulk insert with per-batch error recovery. On a batch failure, we fall
// back to row-by-row inserts so a single bad row can't take down the
// whole run â€” we log offenders and keep going.
// ---------------------------------------------------------------------------
async function insertWithRecovery(
  prisma: PrismaClient,
  slice: any[],
): Promise<{ inserted: number; failed: number }> {
  try {
    const res = await prisma.plan.createMany({
      data: slice,
      skipDuplicates: true,
    });
    return { inserted: res.count, failed: 0 };
  } catch (err) {
    console.warn(
      `  batch failed (${(err as Error).message.slice(0, 100)}) â€” falling back to per-row inserts`,
    );
    let ok = 0;
    let bad = 0;
    for (const row of slice) {
      try {
        await prisma.plan.create({ data: row });
        ok++;
      } catch (rowErr) {
        bad++;
        console.warn(
          `    skip ${row.planId} ${row.state}/${row.county}: ${(rowErr as Error).message.slice(0, 80)}`,
        );
      }
    }
    return { inserted: ok, failed: bad };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\nBackfilling missing plans for plan year ${PLAN_YEAR}`);
  console.log(`MAPD inclusion: ${INCLUDE_MAPD ? "YES (--include-mapd)" : "NO (default)"}`);
  console.log("================================================\n");

  const planInfoMap = buildPlanInfoMap();
  const financeMap = buildFinanceMap();
  const locations = readPlanArea();

  // The DB stores planId as `${contractId}-${planId}` (no zero padding on the
  // plan portion in the legacy import). Match that.
  function planIdString(planKey: string): string {
    const [h, p] = planKey.split("-");
    return `${h}-${parseInt(p, 10)}`;
  }

  // Snapshot existing rows for the year so we know what to skip.
  console.log("\nLoading existing DB rows for year...");
  let prisma = makeClient();
  const existing = await prisma.plan.findMany({
    where: { planYear: PLAN_YEAR },
    select: { planId: true, state: true, county: true },
  });
  const existingSet = new Set(
    existing.map((r) => `${r.planId}|${r.state}|${r.county}`),
  );
  console.log(`  ${existing.length.toLocaleString()} existing rows for ${PLAN_YEAR}`);

  // Build the list of rows to insert.
  let scanned = 0;
  let skippedExisting = 0;
  let skippedNoInfo = 0;
  let skippedCategory = 0;
  const skippedByCategory = new Map<PlanCategory, number>();
  const toInsert: any[] = [];

  for (const loc of locations) {
    scanned++;
    const info = planInfoMap.get(loc.planKey);
    if (!info) { skippedNoInfo++; continue; }

    if (!shouldInsert(info.planCategory)) {
      skippedCategory++;
      skippedByCategory.set(
        info.planCategory,
        (skippedByCategory.get(info.planCategory) ?? 0) + 1,
      );
      continue;
    }

    const planId = planIdString(loc.planKey);
    const dedupKey = `${planId}|${loc.state}|${loc.county}`;
    if (existingSet.has(dedupKey)) { skippedExisting++; continue; }
    existingSet.add(dedupKey); // guard against PlanArea duplicates within the run

    const fin = financeMap.get(loc.planKey);

    toInsert.push({
      planYear: PLAN_YEAR,
      planId,
      planName: info.planName,
      organizationName: info.organizationName,
      planType: info.cmsContractType ?? "Unknown",
      planCategory: info.planCategory,
      snpSubtype: info.snpSubtype,
      chronicConditions: info.chronicConditions,
      hasPartD: info.hasPartD,
      isZeroDollarDsnp: info.isZeroDollarDsnp,
      cmsContractType: info.cmsContractType,
      state: loc.state,
      county: loc.county,
      zipCode: null,
      monthlyPremium: fin?.monthlyPremium ?? 0,
      partBGivebackAmount: fin?.partBGivebackAmount ?? 0,
      lowIncomeSubsidyLevel: null,
      medicaidLevel: null,
      medicalDeductible: fin?.medicalDeductible ?? 0,
      maxOutOfPocket: fin?.maxOutOfPocket ?? null,
      drugDeductible: 0,
      otcAllowance: 0,
      foodCardAllowance: 0,
    });
  }

  console.log(`\nPlanArea rows scanned:         ${scanned.toLocaleString()}`);
  console.log(`  matched existing DB rows:    ${skippedExisting.toLocaleString()}`);
  console.log(`  no Section A entry:          ${skippedNoInfo.toLocaleString()}`);
  console.log(`  skipped by category:         ${skippedCategory.toLocaleString()}`);
  if (skippedByCategory.size > 0) {
    for (const [c, n] of [...skippedByCategory.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    - ${String(c).padEnd(10)} ${n.toLocaleString().padStart(8)}`);
    }
  }
  console.log(`  to insert:                   ${toInsert.length.toLocaleString()}`);

  // Category breakdown of what we're about to add.
  const catBreakdown = new Map<PlanCategory, number>();
  for (const r of toInsert) {
    catBreakdown.set(r.planCategory, (catBreakdown.get(r.planCategory) ?? 0) + 1);
  }
  console.log("\nNew rows by planCategory:");
  for (const [c, n] of [...catBreakdown.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(c).padEnd(10)} ${n.toLocaleString().padStart(8)}`);
  }

  if (toInsert.length === 0) {
    console.log("\nNothing to insert. Done.");
    await prisma.$disconnect();
    return;
  }

  // -------------------------------------------------------------------------
  // Insert phase.
  //
  //  * BATCH = 50 keeps each createMany well under the 65,535-parameter
  //    Postgres limit (22 cols Ã— 50 rows = 1,100 params) AND under 1s on
  //    the Supabase session pooler even when the table is hot.
  //
  //  * We recycle the Prisma client every 50 batches (~2,500 rows) to
  //    flush prepared-statement cache on the session pooler. That cache
  //    accumulating was the cause of the deterministic hang at row 251,000
  //    on the previous (batch=200) run.
  //
  //  * Per-batch error recovery in insertWithRecovery() means a single bad
  //    row won't kill the run â€” it gets logged and skipped.
  // -------------------------------------------------------------------------
  const BATCH = 50;
  const RECYCLE_AFTER_BATCHES = 50;
  let inserted = 0;
  let failed = 0;
  let batchesSinceRecycle = 0;
  const startTime = Date.now();
  console.log("\nInserting...");

  for (let i = 0; i < toInsert.length; i += BATCH) {
    const slice = toInsert.slice(i, i + BATCH);
    const t0 = Date.now();
    const { inserted: ok, failed: bad } = await insertWithRecovery(prisma, slice);
    inserted += ok;
    failed += bad;
    batchesSinceRecycle++;

    const elapsed = Date.now() - t0;
    const done = Math.min(i + BATCH, toInsert.length);
    // Log every batch if slow OR every 20 batches (~1000 rows) if fast.
    const shouldLog =
      elapsed > 800 ||
      (Math.floor(done / BATCH) % 20 === 0) ||
      done >= toInsert.length;
    if (shouldLog) {
      const pct = ((done / toInsert.length) * 100).toFixed(1);
      const elapsedTotal = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(
        `  ${done.toLocaleString().padStart(7)} / ${toInsert.length.toLocaleString()} (${pct}%) â€” batch ${elapsed}ms â€” elapsed ${elapsedTotal}s${failed ? ` â€” ${failed} skipped` : ""}`,
      );
    }

    // Recycle the connection periodically to clear prepared-statement cache.
    if (batchesSinceRecycle >= RECYCLE_AFTER_BATCHES && i + BATCH < toInsert.length) {
      await prisma.$disconnect();
      prisma = makeClient();
      batchesSinceRecycle = 0;
    }
  }

  const totalSecs = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`\nDone in ${totalSecs}s. Inserted ${inserted.toLocaleString()} new rows${failed ? `, ${failed} rows skipped due to errors` : ""}.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
