/**
 * CMS Medicare Advantage Plan Data Importer
 *
 * Downloads PBP (Plan Benefit Package) data from CMS and the MA landscape
 * file, parses the benefit details, and upserts plan records into the database.
 *
 * Data sources:
 *   - CMS PBP Benefits ZIP: https://www.cms.gov/files/zip/pbp-benefits-{year}.zip
 *     Contains tab-delimited .txt files with detailed benefit data.
 *   - NBER MA Landscape CSV: https://data.nber.org/drugcoverage/{year}/ma{year}.csv
 *     One row per plan per county with state, county, premium, MOOP, star rating.
 *
 * Usage:
 *   npx tsx scripts/import-cms-data.ts [--year 2025] [--dry-run]
 */

import {
  PrismaClient,
  PlanCategory,
  SnpSubtype,
  ChronicCondition,
} from "@prisma/client";
import { parse } from "csv-parse/sync";
import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as http from "http";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { execSync } from "child_process";
// Licensed-states gate (added 2026-04-28). Without this, a fresh
// landscape import re-adds the 35 states Dale isn't licensed in, and the
// reactive cleanup script (cleanup-nonlicensed-states.js) has to scrub
// them again. Gating at the source keeps the DB scoped to Dale's 18
// licensed states from row 1.
//
// Source list: scripts/licensed-states.js (CommonJS — required, not imported).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { LICENSED_STATES }: { LICENSED_STATES: string[] } = require("./licensed-states");
const LICENSED_STATES_SET = new Set(LICENSED_STATES);

// Long-running scripts must go through the session-mode pooler (:5432),
// not the transaction pooler (:6543) used by the web app. Transaction-mode
// PgBouncer recycles connections between statements, which breaks Prisma's
// prepared-statement cache with "prepared statement s1 already exists".
const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DIRECT_URL || process.env.DATABASE_URL },
  },
});

// ---------------------------------------------------------------------------
// CMS plan-type / SNP code decoders
// See docs/plan-type-catalog.md for the authoritative source (CMS dictionary).
// ---------------------------------------------------------------------------

// pbp_a_plan_type -> human-readable contract type label
const CONTRACT_TYPE_LABELS: Record<string, string> = {
  "01": "HMO",
  "02": "HMOPOS",
  "04": "Local PPO",
  "05": "PSO",
  "07": "MSA",
  "08": "RFB PFFS",
  "09": "PFFS",
  "18": "1876 Cost",
  "19": "HCPP - 1833 Cost",
  "20": "National PACE",
  "29": "PDP",
  "30": "Employer/Union Direct PDP",
  "31": "Regional PPO",
  "32": "Fallback",
  "40": "Employer/Union Direct PFFS",
  "42": "RFB HMO",
  "43": "RFB HMOPOS",
  "44": "RFB Local PPO",
  "45": "RFB PSO",
  "47": "Employer Direct PPO",
  "48": "MMP",
};

// pbp_a_snp_cond bit-string position (1-indexed) -> ChronicCondition
// 2026 has 33 positions; 2025 has 23 (positions 24-33 didn't exist yet).
// If CMS adds positions later, append to this array — order matters.
const CHRONIC_CONDITION_BY_POSITION: ChronicCondition[] = [
  ChronicCondition.ALCOHOL_SUD,              // pos 1
  ChronicCondition.AUTOIMMUNE,               // pos 2
  ChronicCondition.CANCER,                   // pos 3
  ChronicCondition.CARDIOVASCULAR,           // pos 4
  ChronicCondition.CHRONIC_HEART_FAILURE,    // pos 5
  ChronicCondition.DEMENTIA,                 // pos 6
  ChronicCondition.DIABETES,                 // pos 7
  ChronicCondition.GASTROINTESTINAL,         // pos 8
  ChronicCondition.CHRONIC_KIDNEY_DISEASE,   // pos 9
  ChronicCondition.HEMATOLOGIC,              // pos 10
  ChronicCondition.HIV_AIDS,                 // pos 11
  ChronicCondition.LUNG_DISORDERS,           // pos 12
  ChronicCondition.MENTAL_HEALTH,            // pos 13
  ChronicCondition.NEUROLOGIC,               // pos 14
  ChronicCondition.STROKE,                   // pos 15
  ChronicCondition.CHF_AND_CVD,              // pos 16
  ChronicCondition.DIABETES_AND_CVD,         // pos 17
  ChronicCondition.CHF_AND_DIABETES,         // pos 18
  ChronicCondition.DIABETES_CHF_CVD,         // pos 19
  ChronicCondition.STROKE_AND_CVD,           // pos 20
  ChronicCondition.METABOLIC_SYNDROME,       // pos 21
  ChronicCondition.POST_TRANSPLANT,          // pos 22
  ChronicCondition.IMMUNODEFICIENCY,         // pos 23
  ChronicCondition.COGNITIVE_IMPAIRMENT,     // pos 24 (2026+)
  ChronicCondition.FUNCTIONAL_CHALLENGES,    // pos 25
  ChronicCondition.SENSORY_IMPAIRMENT,       // pos 26
  ChronicCondition.THERAPY_MAINTENANCE,      // pos 27
  ChronicCondition.ANXIETY_WITH_COPD,        // pos 28
  ChronicCondition.CKD_AND_TRANSPLANT,       // pos 29
  ChronicCondition.SUD_AND_MH,               // pos 30
  ChronicCondition.OTHER_1,                  // pos 31
  ChronicCondition.OTHER_2,                  // pos 32
  ChronicCondition.OTHER_3,                  // pos 33
];

function decodeSnpCond(bitString: string | undefined): ChronicCondition[] {
  if (!bitString) return [];
  const conditions: ChronicCondition[] = [];
  for (let i = 0; i < bitString.length; i++) {
    if (bitString[i] === "1") {
      const cond = CHRONIC_CONDITION_BY_POSITION[i];
      if (cond) conditions.push(cond);
    }
  }
  return conditions;
}

// Derive the canonical PlanCategory from raw Section-A fields.
// Rules are documented in docs/plan-type-catalog.md.
function derivePlanCategory(row: PBPRow): PlanCategory {
  const snpFlag = row.pbp_a_special_need_flag?.trim();
  const snpType = row.pbp_a_special_need_plan_type?.trim();
  const planTypeCode = row.pbp_a_plan_type?.trim();
  const partD = row.pbp_a_contract_partd_flag?.trim();

  if (snpFlag === "1") {
    if (snpType === "3") return PlanCategory.DSNP;
    if (snpType === "4") return PlanCategory.CSNP;
    if (snpType === "1") return PlanCategory.ISNP;
  }
  if (planTypeCode === "29" || planTypeCode === "30") return PlanCategory.PDP;
  if (planTypeCode === "18" || planTypeCode === "19") return PlanCategory.COST;
  if (planTypeCode === "20") return PlanCategory.PACE;
  if (planTypeCode === "07") return PlanCategory.MSA;
  if (planTypeCode === "48") return PlanCategory.MMP;
  if (partD === "1") return PlanCategory.MAPD;
  return PlanCategory.MA_ONLY;
}

// Map pbp_a_snp_institutional_type to SnpSubtype (only meaningful for ISNP).
function deriveIsnpSubtype(row: PBPRow): SnpSubtype | null {
  const v = row.pbp_a_snp_institutional_type?.trim();
  switch (v) {
    case "1": return SnpSubtype.ISNP_FACILITY;
    case "2": return SnpSubtype.ISNP_EQUIVALENT;
    case "3": return SnpSubtype.ISNP_HYBRID;
    default:  return null;
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const DEFAULT_YEAR = new Date().getFullYear();
const args = process.argv.slice(2);
const yearIdx = args.indexOf("--year");
const PLAN_YEAR = yearIdx >= 0 ? parseInt(args[yearIdx + 1], 10) : DEFAULT_YEAR;
const DRY_RUN = args.includes("--dry-run");
const WORK_DIR = path.join(process.cwd(), ".cms-import-tmp");


// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
export type LogCallback = (message: string) => void;
let _logCallback: LogCallback | null = null;

export function setLogCallback(cb: LogCallback) {
  _logCallback = cb;
}

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  _logCallback?.(line);
}

// ---------------------------------------------------------------------------
// Download helpers
// ---------------------------------------------------------------------------
function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    const client = url.startsWith("https") ? https : http;

    function doRequest(reqUrl: string, redirects = 0) {
      if (redirects > 5) {
        reject(new Error("Too many redirects"));
        return;
      }
      client.get(reqUrl, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          doRequest(res.headers.location, redirects + 1);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode} for ${reqUrl}`));
          return;
        }
        pipeline(res, file).then(resolve).catch(reject);
      }).on("error", reject);
    }

    doRequest(url);
  });
}


// ---------------------------------------------------------------------------
// Parse tab-delimited PBP .txt files
// ---------------------------------------------------------------------------
type PBPRow = Record<string, string>;

function parseTSV(filePath: string): PBPRow[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8");
  return parse(content, {
    columns: true,
    delimiter: "\t",
    relax_column_count: true,
    skip_empty_lines: true,
    quote: false, // CMS PBP files contain unescaped quotes in free-text fields
  }) as PBPRow[];
}

function num(val: string | undefined): number | null {
  if (!val || val.trim() === "") return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

function planKey(row: PBPRow): string {
  return `${row.pbp_a_hnumber}-${row.pbp_a_plan_identifier}-${row.segment_id || "0"}`;
}

// ---------------------------------------------------------------------------
// Build per-plan benefit map from PBP files
// ---------------------------------------------------------------------------
interface PlanBenefits {
  // Section A — plan-type taxonomy (added 2026-04-21, backlog item #1)
  planCategory: PlanCategory | null;
  snpSubtype: SnpSubtype | null;
  chronicConditions: ChronicCondition[];
  hasPartD: boolean | null;
  isZeroDollarDsnp: boolean | null;
  cmsContractType: string | null;
  // Section D
  monthlyPremium: number | null;
  medicalDeductible: number | null;
  maxOutOfPocket: number | null;
  partBGivebackAmount: number | null;
  // b7 - Health professionals
  pcpCopay: number | null;
  specialistCopay: number | null;
  // b4 - Emergency
  emergencyRoomCopay: number | null;
  // b10 - Ambulance
  ambulanceCopay: number | null;
  // b9 - Outpatient
  outpatientHospitalCopay: number | null;
  // b1a - Hospital stay
  hospitalStayCopay: string | null;
  // b2 - SNF
  skilledNursingCopay: string | null;
  // b8 - Imaging
  mriCopay: number | null;
  catScanCopay: number | null;
  // mrx - Drug
  drugDeductible: number | null;
  drugTier1Copay: number | null;
  drugTier2Copay: number | null;
  drugTier3Copay: number | null;
  drugTier4Copay: number | null;
  drugTier5Copay: number | null;
  drugTier6Copay: number | null;
  // b13 - OTC / Food
  otcAllowance: number | null;
  foodCardAllowance: number | null;
  // b16 - Dental
  dentalBenefits: string | null;
  // b17 - Vision
  visionBenefits: string | null;
  // b18 - Hearing
  hearingBenefits: string | null;
  // b10b - Transportation
  transportationBenefit: string | null;
}

function buildBenefitMap(extractDir: string): Map<string, PlanBenefits> {
  const map = new Map<string, PlanBenefits>();

  function getOrCreate(key: string): PlanBenefits {
    if (!map.has(key)) {
      map.set(key, {
        planCategory: null, snpSubtype: null, chronicConditions: [],
        hasPartD: null, isZeroDollarDsnp: null, cmsContractType: null,
        monthlyPremium: null, medicalDeductible: null, maxOutOfPocket: null,
        partBGivebackAmount: null, pcpCopay: null, specialistCopay: null,
        emergencyRoomCopay: null, ambulanceCopay: null, outpatientHospitalCopay: null,
        hospitalStayCopay: null, skilledNursingCopay: null,
        mriCopay: null, catScanCopay: null,
        drugDeductible: null, drugTier1Copay: null, drugTier2Copay: null,
        drugTier3Copay: null, drugTier4Copay: null, drugTier5Copay: null,
        drugTier6Copay: null, otcAllowance: null, foodCardAllowance: null,
        dentalBenefits: null, visionBenefits: null, hearingBenefits: null,
        transportationBenefit: null,
      });
    }
    return map.get(key)!;
  }

  // Period code to human-readable label
  // CMS codes: 1=month, 2=quarter, 3=year, 4=2-year, 5=other, 6=episode, 7=benefit period
  function periodLabel(code: string | undefined): string {
    switch (code) {
      case "1": return "/month";
      case "2": return "/quarter";
      case "3": return "/year";
      case "4": return "/2 years";
      case "5": return "";
      case "6": return "/episode";
      case "7": return "/benefit period";
      default: return "";
    }
  }

  // Build a per-day copay string from interval fields (used for hospital/SNF)
  function buildDayStructure(
    row: PBPRow,
    prefix: string, // e.g. "pbp_b1a_copay_mcs" or "pbp_b2_copay_mcs"
    tier: string,    // e.g. "_t1"
  ): string | null {
    const parts: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const amt = num(row[`${prefix}_amt_int${i}${tier}`]);
      const bgn = row[`${prefix}_bgnd_int${i}${tier}`];
      const end = row[`${prefix}_endd_int${i}${tier}`];
      if (amt != null && bgn && end) {
        parts.push(`$${amt}/day days ${bgn}-${end}`);
      }
    }
    return parts.length > 0 ? parts.join(", ") : null;
  }

  // Section A: plan-type taxonomy (PlanCategory, SNP subtype, chronic conditions, etc.)
  // See docs/plan-type-catalog.md for raw-code -> enum mappings.
  log("Parsing pbp_Section_A.txt...");
  for (const row of parseTSV(path.join(extractDir, "pbp_Section_A.txt"))) {
    const b = getOrCreate(planKey(row));
    b.planCategory = derivePlanCategory(row);
    const planTypeCode = row.pbp_a_plan_type?.trim();
    b.cmsContractType = planTypeCode ? CONTRACT_TYPE_LABELS[planTypeCode] ?? null : null;
    b.hasPartD = row.pbp_a_contract_partd_flag?.trim() === "1";
    if (b.planCategory === PlanCategory.ISNP) {
      b.snpSubtype = deriveIsnpSubtype(row);
    }
    if (b.planCategory === PlanCategory.DSNP) {
      const z = row.pbp_a_dsnp_zerodollar?.trim();
      if (z === "1") b.isZeroDollarDsnp = true;
      else if (z === "2") b.isZeroDollarDsnp = false;
    }
    if (b.planCategory === PlanCategory.CSNP) {
      b.chronicConditions = decodeSnpCond(row.pbp_a_snp_cond);
    }
  }

  // Section D: premiums, deductible, MOOP, Part B giveback
  log("Parsing pbp_Section_D.txt...");
  for (const row of parseTSV(path.join(extractDir, "pbp_Section_D.txt"))) {
    const b = getOrCreate(planKey(row));
    b.monthlyPremium = num(row.pbp_d_mplusc_premium);
    // Medical deductible: only set when plan has one (yn=1)
    if (row.pbp_d_ann_deduct_yn === "1") {
      b.medicalDeductible = num(row.pbp_d_ann_deduct_amt) ?? 0;
    } else {
      b.medicalDeductible = 0;
    }
    // MOOP: in-network mandatory amount (out_pocket_amt), then combined, then overall mandatory
    b.maxOutOfPocket = num(row.pbp_d_out_pocket_amt)
      ?? num(row.pbp_d_comb_max_enr_amt)
      ?? num(row.pbp_d_maxenr_oopc_amt);
    // Part B giveback (premium reduction)
    if (row.pbp_d_mco_pay_reduct_yn === "1") {
      b.partBGivebackAmount = num(row.pbp_d_mco_pay_reduct_amt);
    }
  }

  // b7: PCP (b7a) and Specialist (b7b) copays
  log("Parsing pbp_b7_health_prof.txt...");
  for (const row of parseTSV(path.join(extractDir, "pbp_b7_health_prof.txt"))) {
    const b = getOrCreate(planKey(row));
    if (row.pbp_b7a_copay_yn === "1") {
      b.pcpCopay = num(row.pbp_b7a_copay_amt_mc_min);
    }
    if (row.pbp_b7b_copay_yn === "1") {
      b.specialistCopay = num(row.pbp_b7b_copay_mc_amt_min);
    }
  }

  // b4: Emergency (b4a) copay
  log("Parsing pbp_b4_emerg_urgent.txt...");
  for (const row of parseTSV(path.join(extractDir, "pbp_b4_emerg_urgent.txt"))) {
    const b = getOrCreate(planKey(row));
    if (row.pbp_b4a_copay_yn === "1") {
      b.emergencyRoomCopay = num(row.pbp_b4a_copay_amt_mc_min);
    }
  }

  // b10: Ambulance (b10a) and Transportation (b10b)
  log("Parsing pbp_b10_amb_trans.txt...");
  for (const row of parseTSV(path.join(extractDir, "pbp_b10_amb_trans.txt"))) {
    const b = getOrCreate(planKey(row));
    // b10a: Ambulance copay (ground ambulance)
    if (row.pbp_b10a_copay_yn === "1") {
      b.ambulanceCopay = num(row.pbp_b10a_copay_gas_amt_min);
    }
    // b10b: Transportation benefit
    // Sources: trip count (bendesc_amt_pal), dollar max (maxplan_amt), or all-transport trips (amt_al)
    if (row.pbp_b10b_bendesc_yn === "1") {
      const tripsPal = row.pbp_b10b_bendesc_amt_pal;
      const tripsAl = row.pbp_b10b_bendesc_amt_al;
      const tripPer = periodLabel(row.pbp_b10b_bendesc_per_pal || row.pbp_b10b_bendesc_per_al);
      const dollarMax = num(row.pbp_b10b_maxplan_amt) ?? num(row.pbp_b10b_maxenr_amt);
      const dollarPer = periodLabel(row.pbp_b10b_maxplan_per || row.pbp_b10b_maxenr_per);
      const trips = tripsPal || tripsAl;

      const parts: string[] = [];
      if (trips) parts.push(`${trips} one-way trips${tripPer}`);
      if (dollarMax != null) parts.push(`$${dollarMax}${dollarPer} max`);

      if (parts.length > 0) {
        b.transportationBenefit = parts.join(", ");
      } else {
        b.transportationBenefit = "Transportation benefit included";
      }
    }
  }

  // b9: Outpatient hospital copay
  log("Parsing pbp_b9_outpat_hosp.txt...");
  for (const row of parseTSV(path.join(extractDir, "pbp_b9_outpat_hosp.txt"))) {
    const b = getOrCreate(planKey(row));
    if (row.pbp_b9a_copay_yn === "1") {
      // Use max amount for "up to" semantics
      b.outpatientHospitalCopay = num(row.pbp_b9a_copay_ohs_amt_max) ?? num(row.pbp_b9a_copay_ohs_amt_min);
    }
  }

  // b1a: Inpatient hospital stay copay (per-day interval structure)
  log("Parsing pbp_b1a_inpat_hosp.txt...");
  for (const row of parseTSV(path.join(extractDir, "pbp_b1a_inpat_hosp.txt"))) {
    const b = getOrCreate(planKey(row));
    if (row.pbp_b1a_copay_yn === "1") {
      b.hospitalStayCopay = buildDayStructure(row, "pbp_b1a_copay_mcs", "_t1");
    }
  }

  // b2: Skilled nursing facility copay (per-day interval structure)
  log("Parsing pbp_b2_snf.txt...");
  for (const row of parseTSV(path.join(extractDir, "pbp_b2_snf.txt"))) {
    const b = getOrCreate(planKey(row));
    if (row.pbp_b2_copay_yn === "1") {
      b.skilledNursingCopay = buildDayStructure(row, "pbp_b2_copay_mcs", "_t1");
    }
  }

  // b8: Diagnostic imaging (MRI & CT scan copays)
  // b8a = diagnostic lab/radiology, b8b = therapeutic radiology
  // b8b has separate fields: _drs (diagnostic radiology svc), _tmc (therapeutic)
  log("Parsing pbp_b8_clin_diag_ther.txt...");
  for (const row of parseTSV(path.join(extractDir, "pbp_b8_clin_diag_ther.txt"))) {
    const b = getOrCreate(planKey(row));
    // Diagnostic radiology copay (b8a) — covers MRI, CT, X-ray
    if (row.pbp_b8a_copay_yn === "1") {
      b.mriCopay = num(row.pbp_b8a_copay_max_dmc_amt) ?? num(row.pbp_b8a_copay_min_dmc_amt);
      b.catScanCopay = b.mriCopay; // same category in CMS data
    }
    // If b8b (outpatient therapeutic) has separate copay for diagnostic radiology svc
    if (row.pbp_b8b_copay_yn === "1") {
      const drs = num(row.pbp_b8b_copay_amt_drs);
      if (drs != null) {
        b.mriCopay = b.mriCopay ?? drs;
        b.catScanCopay = b.catScanCopay ?? drs;
      }
    }
  }

  // mrx: Drug deductible
  log("Parsing pbp_mrx.txt...");
  for (const row of parseTSV(path.join(extractDir, "pbp_mrx.txt"))) {
    const b = getOrCreate(planKey(row));
    if (row.mrx_alt_ded_charge === "2") {
      // charge=2 means deductible applies
      b.drugDeductible = num(row.mrx_alt_ded_amount) ?? 0;
    } else {
      b.drugDeductible = 0;
    }
  }

  // mrx_tier: Drug tier copays (one row per tier)
  // Tiers 1-3 typically have flat copays; tiers 4-5 often use coinsurance (%)
  log("Parsing pbp_mrx_tier.txt...");
  for (const row of parseTSV(path.join(extractDir, "pbp_mrx_tier.txt"))) {
    const b = getOrCreate(planKey(row));
    const tierId = row.mrx_tier_id;
    // Prefer flat copay; fall back to coinsurance percentage as a dollar indicator
    let copay = num(row.mrx_tier_rstd_copay_1m);
    if (copay == null) {
      // Coinsurance is a percentage (e.g. 47 = 47%); store as-is for display
      const coins = num(row.mrx_tier_rstd_coins_1m);
      if (coins != null) copay = coins; // will display as "$47" but represents 47%
    }
    switch (tierId) {
      case "1": b.drugTier1Copay = copay; break;
      case "2": b.drugTier2Copay = copay; break;
      case "3": b.drugTier3Copay = copay; break;
      case "4": b.drugTier4Copay = copay; break;
      case "5": b.drugTier5Copay = copay; break;
      case "6": b.drugTier6Copay = copay; break;
    }
  }

  // b13: OTC allowance & food card / meals
  log("Parsing pbp_b13_other_services.txt...");
  for (const row of parseTSV(path.join(extractDir, "pbp_b13_other_services.txt"))) {
    const b = getOrCreate(planKey(row));
    // OTC allowance (b13b): bendesc_otc=1 means plan offers OTC
    if (row.pbp_b13b_bendesc_otc === "1" && row.pbp_b13b_maxplan_yn === "1") {
      b.otcAllowance = num(row.pbp_b13b_maxplan_amt);
    }
    // Food/grocery/meals (b13c): bendesc_service=1 means plan offers meals/food
    if (row.pbp_b13c_bendesc_service === "1" && row.pbp_b13c_maxplan_yn === "1") {
      b.foodCardAllowance = num(row.pbp_b13c_maxplan_amt);
    }
  }

  // b16: Dental benefits
  // b16a = preventive dental coverage, b16b = preventive max amounts,
  // b16c = comprehensive dental coverage and max amounts
  log("Parsing pbp_b16_dental.txt...");
  for (const row of parseTSV(path.join(extractDir, "pbp_b16_dental.txt"))) {
    const b = getOrCreate(planKey(row));

    // Check comprehensive dental first (b16c)
    if (row.pbp_b16c_maxplan_cmp_yn === "1") {
      // Try maxplan amount, then maxenr amount as fallback
      const cmpAmt = num(row.pbp_b16c_maxplan_cmp_amt) ?? num(row.pbp_b16c_maxenr_cmp_amt);
      const per = periodLabel(row.pbp_b16c_maxplan_cmp_per || row.pbp_b16c_maxenr_cmp_per);
      if (cmpAmt != null) {
        b.dentalBenefits = `Comprehensive dental - $${cmpAmt}${per} max`;
      } else {
        b.dentalBenefits = "Comprehensive dental (no max)";
      }
    } else if (row.pbp_b16b_maxplan_pv_yn === "1") {
      // Preventive dental with plan max
      const pvAmt = num(row.pbp_b16b_maxplan_pv_amt) ?? num(row.pbp_b16b_maxenr_pv_amt);
      const per = periodLabel(row.pbp_b16b_maxplan_pv_per || row.pbp_b16b_maxenr_pv_per);
      if (pvAmt != null) {
        b.dentalBenefits = `Preventive dental - $${pvAmt}${per} max`;
      } else {
        b.dentalBenefits = "Preventive dental (no max)";
      }
    } else if (row.pbp_b16a_maxenr_mc_yn === "1" || row.pbp_b16a_maxenr_mc_yn === "2") {
      // Preventive coverage exists — check if b16a has an enrollment max amount
      const pvEnrAmt = num(row.pbp_b16a_maxenr_mc_amt);
      const per = periodLabel(row.pbp_b16a_maxenr_mc_per);
      if (pvEnrAmt != null) {
        b.dentalBenefits = `Preventive dental - $${pvEnrAmt}${per} max`;
      } else {
        b.dentalBenefits = "Preventive dental (no max)";
      }
    }
  }

  // b17: Vision benefits
  // b17a = eye exams + eyewear (combined), b17b = eyewear (separate section)
  // Best eyewear amount source: b17b combined max > b17b individual max > b17a plan max > b17a enrollment max
  log("Parsing pbp_b17_eye_exams_wear.txt...");
  for (const row of parseTSV(path.join(extractDir, "pbp_b17_eye_exams_wear.txt"))) {
    const b = getOrCreate(planKey(row));
    const hasExamAndEyewear = row.pbp_b17a_bendesc_yn === "1";
    const hasExamOnly = row.pbp_b17a_bendesc_yn === "2";
    const hasEyewearSection = row.pbp_b17b_bendesc_yn === "1";

    if (!hasExamAndEyewear && !hasExamOnly) continue;

    // Try to find the eyewear allowance amount from best to worst source
    let eyewearAmt: number | null = null;
    let eyewearPer = "";

    // 1. b17b combined eyewear max (most common: 5,217 plans)
    if (row.pbp_b17b_comb_maxplan_yn === "1") {
      eyewearAmt = num(row.pbp_b17b_comb_maxplan_amt);
      eyewearPer = periodLabel(row.pbp_b17b_comb_maxplan_per);
    }
    // 2. b17b individual category max (contact lens amount as representative: 5,348 plans)
    if (eyewearAmt == null && row.pbp_b17b_maxplan_yn === "1") {
      eyewearAmt = num(row.pbp_b17b_indv_maxplan_amt_cl);
      eyewearPer = periodLabel(row.pbp_b17b_indv_maxplan_per_cl);
    }
    // 3. b17b enrollment max
    if (eyewearAmt == null && row.pbp_b17b_maxenr_yn === "1") {
      eyewearAmt = num(row.pbp_b17b_maxenr_amt);
      eyewearPer = periodLabel(row.pbp_b17b_maxenr_per);
    }
    // 4. b17a plan max (combined exam + eyewear: 932 plans)
    if (eyewearAmt == null && row.pbp_b17a_maxplan_yn === "1") {
      eyewearAmt = num(row.pbp_b17a_maxplan_amt);
      eyewearPer = periodLabel(row.pbp_b17a_maxplan_per);
    }
    // 5. b17a enrollment max
    if (eyewearAmt == null && row.pbp_b17a_maxenr_yn === "1") {
      eyewearAmt = num(row.pbp_b17a_maxenr_amt);
      eyewearPer = periodLabel(row.pbp_b17a_maxenr_per);
    }

    if (hasExamOnly && !hasEyewearSection) {
      b.visionBenefits = "Vision exam only (no eyewear benefit)";
    } else if (eyewearAmt != null) {
      b.visionBenefits = `$${eyewearAmt}${eyewearPer} eyewear allowance`;
    } else if (hasEyewearSection) {
      b.visionBenefits = "Eyewear benefit (no max)";
    } else {
      b.visionBenefits = "Vision coverage included";
    }
  }

  // b18: Hearing benefits
  // b18a = hearing exams, b18b = hearing aids (devices), b18c = hearing aid fitting/evaluation
  // Best amount: b18b maxplan > b18c maxplan > b18a maxplan > b18a maxenr
  log("Parsing pbp_b18_hearing_exams_aids.txt...");
  for (const row of parseTSV(path.join(extractDir, "pbp_b18_hearing_exams_aids.txt"))) {
    const b = getOrCreate(planKey(row));
    const hasExam = row.pbp_b18a_bendesc_yn === "1";
    const hasExamOnly = row.pbp_b18a_bendesc_yn === "2";
    const hasHearingAids = row.pbp_b18b_bendesc_yn === "1";

    if (!hasExam && !hasExamOnly) continue;

    let aidAmt: number | null = null;
    let aidPer = "";

    // 1. b18b hearing aid device max (2,054 plans)
    if (row.pbp_b18b_maxplan_yn === "1") {
      aidAmt = num(row.pbp_b18b_maxplan_amt);
      aidPer = periodLabel(row.pbp_b18b_maxplan_per);
    }
    // 2. b18b enrollment max
    if (aidAmt == null && row.pbp_b18b_maxenr_yn === "1") {
      aidAmt = num(row.pbp_b18b_maxenr_amt);
      aidPer = periodLabel(row.pbp_b18b_maxenr_per);
    }
    // 3. b18c hearing aid fitting max (237 plans)
    if (aidAmt == null && row.pbp_b18c_maxplan_yn === "1") {
      aidAmt = num(row.pbp_b18c_maxplan_amt);
      aidPer = periodLabel(row.pbp_b18c_maxplan_per);
    }
    // 4. b18c enrollment max
    if (aidAmt == null && row.pbp_b18c_maxenr_yn === "1") {
      aidAmt = num(row.pbp_b18c_maxenr_amt);
      aidPer = periodLabel(row.pbp_b18c_maxenr_per);
    }
    // 5. b18a combined exam+aid max (61 plans)
    if (aidAmt == null && row.pbp_b18a_maxplan_yn === "1") {
      aidAmt = num(row.pbp_b18a_maxplan_amt);
      aidPer = periodLabel(row.pbp_b18a_maxplan_per);
    }
    // 6. b18a enrollment max
    if (aidAmt == null && row.pbp_b18a_maxenr_yn === "1") {
      aidAmt = num(row.pbp_b18a_maxenr_amt);
      aidPer = periodLabel(row.pbp_b18a_maxenr_per);
    }

    if (hasExamOnly && !hasHearingAids) {
      b.hearingBenefits = "Hearing exam only (no hearing aid benefit)";
    } else if (aidAmt != null) {
      b.hearingBenefits = `$${aidAmt}${aidPer} hearing aid allowance`;
    } else if (hasHearingAids) {
      b.hearingBenefits = "Hearing aid benefit (no max)";
    } else {
      b.hearingBenefits = "Hearing coverage included";
    }
  }

  return map;
}

// ---------------------------------------------------------------------------
// Parse landscape CSV for state/county mapping
// ---------------------------------------------------------------------------
interface LandscapeRow {
  state: string;
  county: string;
  organizationname: string;
  planname: string;
  typeofmedicarehealthplan: string;
  monthlyconsolidatedpremiumi: string;
  annualdrugdeductible: string;
  contractid: string;
  planid: string;
  segmentid: string;
  innetworkmoopamount: string;
  overallstarrating: string;
}

function parseLandscape(csvPath: string): LandscapeRow[] {
  const content = fs.readFileSync(csvPath, "utf-8");
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  }) as LandscapeRow[];
}

// ---------------------------------------------------------------------------
// State abbreviation lookup
// ---------------------------------------------------------------------------
const STATE_ABBREVS: Record<string, string> = {
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA",
  Colorado: "CO", Connecticut: "CT", Delaware: "DE", "District of Columbia": "DC",
  Florida: "FL", Georgia: "GA", Hawaii: "HI", Idaho: "ID", Illinois: "IL",
  Indiana: "IN", Iowa: "IA", Kansas: "KS", Kentucky: "KY", Louisiana: "LA",
  Maine: "ME", Maryland: "MD", Massachusetts: "MA", Michigan: "MI", Minnesota: "MN",
  Mississippi: "MS", Missouri: "MO", Montana: "MT", Nebraska: "NE", Nevada: "NV",
  "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY",
  "North Carolina": "NC", "North Dakota": "ND", Ohio: "OH", Oklahoma: "OK",
  Oregon: "OR", Pennsylvania: "PA", "Puerto Rico": "PR", "Rhode Island": "RI",
  "South Carolina": "SC", "South Dakota": "SD", Tennessee: "TN", Texas: "TX",
  Utah: "UT", Vermont: "VT", Virginia: "VA", Washington: "WA",
  "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY",
};

// ---------------------------------------------------------------------------
// Main import
// ---------------------------------------------------------------------------
export async function runImport(year?: number): Promise<{ imported: number; skipped: number }> {
  const planYear = year ?? PLAN_YEAR;
  const pbpUrl = `https://www.cms.gov/files/zip/pbp-benefits-${planYear}.zip`;

  log(`Starting CMS data import for plan year ${planYear}`);
  log(DRY_RUN ? "DRY RUN — no database writes" : "LIVE — will write to database");

  // Create working directory
  if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR, { recursive: true });
  const pbpZipPath = path.join(WORK_DIR, `pbp-benefits-${planYear}.zip`);
  const landscapePath = path.join(WORK_DIR, `ma${planYear}.csv`);
  const extractDir = path.join(WORK_DIR, `pbp-${planYear}`);

  // Download PBP zip
  if (!fs.existsSync(pbpZipPath)) {
    log(`Downloading PBP benefits ZIP from ${pbpUrl}...`);
    await downloadFile(pbpUrl, pbpZipPath);
    log(`PBP ZIP downloaded (${(fs.statSync(pbpZipPath).size / 1024 / 1024).toFixed(1)} MB)`);
  } else {
    log("PBP ZIP already cached, skipping download.");
  }

  // Extract PBP zip
  if (!fs.existsSync(extractDir)) {
    log("Extracting PBP ZIP...");
    fs.mkdirSync(extractDir, { recursive: true });
    // Use system unzip - works on Windows (Git Bash), Mac, Linux
    try {
      execSync(`unzip -o -q "${pbpZipPath}" -d "${extractDir}"`, { stdio: "pipe" });
    } catch {
      // Fallback: try PowerShell on Windows
      execSync(
        `powershell -Command "Expand-Archive -Path '${pbpZipPath}' -DestinationPath '${extractDir}' -Force"`,
        { stdio: "pipe" },
      );
    }
    log("PBP ZIP extracted.");
  } else {
    log("PBP data already extracted, skipping.");
  }

  // Download landscape CSV — try current year, then fall back to prior years
  // (NBER typically publishes landscape data 1-2 years after the plan year)
  //
  // IMPORTANT: NBER landscape DOES NOT include SNPs and may be 1+ years stale.
  // Plans missing from landscape (but present in CMS PBP) are added later by
  // `npm run backfill-missing-plans`. Always run that after `import-cms`.
  if (!fs.existsSync(landscapePath)) {
    let downloaded = false;
    let landedYear = planYear;
    for (let tryYear = planYear; tryYear >= planYear - 3; tryYear--) {
      const url = `https://data.nber.org/drugcoverage/${tryYear}/ma${tryYear}.csv`;
      try {
        log(`Trying landscape CSV for ${tryYear}: ${url}`);
        await downloadFile(url, landscapePath);
        log(`Downloaded landscape CSV for year ${tryYear}.`);
        downloaded = true;
        landedYear = tryYear;
        break;
      } catch {
        log(`Landscape CSV not available for ${tryYear}, trying older year...`);
      }
    }
    if (!downloaded) {
      throw new Error("Could not download landscape CSV from NBER for any recent year.");
    }
    if (landedYear !== planYear) {
      log("");
      log("==========================================================");
      log(`WARNING: NBER hasn't published ${planYear} landscape yet.`);
      log(`Falling back to ${landedYear} landscape for plan footprint.`);
      log(`Many ${planYear} plans (and ALL SNPs) will be missing.`);
      log(`Run 'npm run backfill-missing-plans ${planYear}' after this import`);
      log(`to add them from PlanArea.txt + Section A (CMS source of truth).`);
      log("==========================================================");
      log("");
    }
  } else {
    log("Landscape CSV already cached, skipping download.");
    log(`(Reminder: NBER landscape may be stale for ${planYear}. Run`);
    log(` 'npm run backfill-missing-plans ${planYear}' after this import.)`);
  }

  // Parse PBP benefit data
  log("Parsing PBP benefit files...");
  const benefitMap = buildBenefitMap(extractDir);
  log(`Parsed benefits for ${benefitMap.size} plan variants.`);

  // Parse landscape CSV
  log("Parsing landscape CSV...");
  const allLandscapeRows = parseLandscape(landscapePath);
  log(`Landscape CSV has ${allLandscapeRows.length} rows (plan × county).`);

  // LICENSED_STATES gate (2026-04-28): drop rows for states Dale isn't
  // licensed in BEFORE we touch the DB. Comparing on the abbreviated
  // state code (post STATE_ABBREVS lookup) so we match scripts/licensed-states.js.
  const landscapeRows = allLandscapeRows.filter((row) => {
    const abbrev = STATE_ABBREVS[row.state] || row.state;
    return LICENSED_STATES_SET.has(abbrev);
  });
  const droppedNonLicensed = allLandscapeRows.length - landscapeRows.length;
  log(
    `Licensed-state gate: kept ${landscapeRows.length} rows in [${LICENSED_STATES.join(", ")}], ` +
      `dropped ${droppedNonLicensed} rows in non-licensed states.`,
  );

  // Build and upsert plan records
  let imported = 0;
  let skipped = 0;
  let skippedNoPbp = 0;
  const batchSize = 500;
  const total = landscapeRows.length;

  // Non-shoppable filter (added 2026-04-28): if a landscape row has no
  // PBP match (i.e. benefits is undefined for the plan key), CMS didn't
  // publish PBP data for that plan, AND medicare.gov's Plan Compare
  // also doesn't surface it. Verified via the plan-compare JSON API on
  // 2026-04-28: 421/421 such plans returned 404. They're EGHP / closed
  // to new enrollment / sanctioned. Agents shouldn't see them.
  //
  // We skip them at the source rather than letting them in and cleaning
  // up later. SNPs are NOT affected: they're added via the separate
  // backfill-missing-plans.ts pipeline which reads PBP directly.
  function isNonShoppable(benefits: PlanBenefits | undefined, planType: string): boolean {
    if (benefits) return false;
    // landscape's typeofmedicarehealthplan is the contract type label.
    // PDP/MSA/PACE are filed differently and may not have a PBP match
    // through this same key, so we don't gate them here.
    const t = (planType || "").toLowerCase();
    if (/pdp|msa|pace|cost|mmp/.test(t)) return false;
    // HMO, PPO, HMO-POS, PFFS, etc. → if no PBP data, treat as non-shoppable.
    return true;
  }

  // Fast path: if no rows exist for this plan year, we can skip the
  // per-batch deleteMany loop (which is a no-op anyway on a fresh table
  // but costs a round-trip per row). Re-imports still delete first.
  const existingForYear = DRY_RUN
    ? 0
    : await prisma.plan.count({ where: { planYear } });
  const freshImport = existingForYear === 0;
  log(
    freshImport
      ? `No existing rows for planYear=${planYear}; using fast-path createMany-only.`
      : `${existingForYear} existing rows for planYear=${planYear}; using delete-then-create path.`
  );

  for (let i = 0; i < total; i += batchSize) {
    const batch = landscapeRows.slice(i, i + batchSize);
    const operations = [];

    for (const row of batch) {
      const contractId = row.contractid?.trim();
      const planId = row.planid?.trim();
      const segmentId = row.segmentid?.trim() || "0";
      if (!contractId || !planId) { skipped++; continue; }

      // PBP files zero-pad plan IDs to 3 digits (e.g. "012"), landscape does not (e.g. "12")
      const paddedPlanId = planId.padStart(3, "0");
      const key = `${contractId}-${paddedPlanId}-${segmentId}`;
      const benefits = benefitMap.get(key);

      const stateAbbrev = STATE_ABBREVS[row.state] || row.state;
      const county = row.county?.trim();
      if (!county || !stateAbbrev) { skipped++; continue; }

      const planType = row.typeofmedicarehealthplan?.trim() || "Unknown";
      // Non-shoppable filter: skip MA-type rows with no PBP match.
      if (isNonShoppable(benefits, planType)) {
        skippedNoPbp++;
        continue;
      }
      const landscapePremium = num(row.monthlyconsolidatedpremiumi);
      const landscapeMOOP = num(row.innetworkmoopamount);
      const landscapeDrugDeductible = num(row.annualdrugdeductible);

      const data = {
        planYear,
        planId: `${contractId}-${planId}`,
        planName: row.planname?.trim() || `${contractId}-${planId}`,
        organizationName: row.organizationname?.trim() || "Unknown",
        planType,
        planCategory: benefits?.planCategory ?? null,
        snpSubtype: benefits?.snpSubtype ?? null,
        chronicConditions: benefits?.chronicConditions ?? [],
        hasPartD: benefits?.hasPartD ?? null,
        isZeroDollarDsnp: benefits?.isZeroDollarDsnp ?? null,
        cmsContractType: benefits?.cmsContractType ?? null,
        state: stateAbbrev,
        county,
        zipCode: null as string | null,
        monthlyPremium: benefits?.monthlyPremium ?? landscapePremium ?? 0,
        partBGivebackAmount: benefits?.partBGivebackAmount ?? 0,
        lowIncomeSubsidyLevel: null as string | null,
        medicaidLevel: null as string | null,
        medicalDeductible: benefits?.medicalDeductible ?? 0,
        maxOutOfPocket: benefits?.maxOutOfPocket ?? landscapeMOOP,
        pcpCopay: benefits?.pcpCopay,
        specialistCopay: benefits?.specialistCopay,
        emergencyRoomCopay: benefits?.emergencyRoomCopay,
        ambulanceCopay: benefits?.ambulanceCopay,
        outpatientHospitalCopay: benefits?.outpatientHospitalCopay,
        hospitalStayCopay: benefits?.hospitalStayCopay,
        skilledNursingCopay: benefits?.skilledNursingCopay,
        mriCopay: benefits?.mriCopay,
        catScanCopay: benefits?.catScanCopay,
        drugDeductible: benefits?.drugDeductible ?? landscapeDrugDeductible ?? 0,
        drugTier1Copay: benefits?.drugTier1Copay,
        drugTier2Copay: benefits?.drugTier2Copay,
        drugTier3Copay: benefits?.drugTier3Copay,
        drugTier4Copay: benefits?.drugTier4Copay,
        drugTier5Copay: benefits?.drugTier5Copay,
        drugTier6Copay: benefits?.drugTier6Copay,
        otcAllowance: benefits?.otcAllowance ?? 0,
        foodCardAllowance: benefits?.foodCardAllowance ?? 0,
        dentalBenefits: benefits?.dentalBenefits,
        hearingBenefits: benefits?.hearingBenefits,
        visionBenefits: benefits?.visionBenefits,
        transportationBenefit: benefits?.transportationBenefit,
      };

      if (!DRY_RUN) {
        operations.push(
          prisma.plan.upsert({
            where: {
              // Use a composite lookup: planYear + planId + state + county
              id: 0, // placeholder — we use the create/update approach below
            },
            update: data,
            create: data,
          }),
        );
      }
      imported++;
    }

    // Since Plan doesn't have a unique constraint on (planYear, planId, state, county),
    // we use deleteMany + createMany for upsert-like behavior per batch.
    if (!DRY_RUN && batch.length > 0) {
      const planKeys = batch
        .filter((r) => r.contractid?.trim() && r.planid?.trim())
        .map((r) => ({
          planYear,
          planId: `${r.contractid.trim()}-${r.planid.trim()}`,
          state: STATE_ABBREVS[r.state] || r.state,
          county: r.county?.trim(),
        }));

      // Delete existing records for these plan+county combos, then re-create.
      // Skipped on fast-path (fresh import) because the table is guaranteed empty for this year.
      if (!freshImport) {
        for (const pk of planKeys) {
          if (!pk.county || !pk.state) continue;
          await prisma.plan.deleteMany({
            where: {
              planYear: pk.planYear,
              planId: pk.planId,
              state: pk.state,
              county: pk.county,
            },
          });
        }
      }

      // Now create the batch
      const createData = batch
        .map((row) => {
          const contractId = row.contractid?.trim();
          const pid = row.planid?.trim();
          const segId = row.segmentid?.trim() || "0";
          if (!contractId || !pid) return null;

          const paddedPid = pid.padStart(3, "0");
          const key = `${contractId}-${paddedPid}-${segId}`;
          const benefits = benefitMap.get(key);
          const stateAbbrev = STATE_ABBREVS[row.state] || row.state;
          const county = row.county?.trim();
          if (!county || !stateAbbrev) return null;

          const planType = row.typeofmedicarehealthplan?.trim() || "Unknown";
          // Non-shoppable filter: skip MA-type rows with no PBP match.
          if (isNonShoppable(benefits, planType)) {
            skippedNoPbp++;
            return null;
          }

          return {
            planYear,
            planId: `${contractId}-${pid}`,
            planName: row.planname?.trim() || `${contractId}-${pid}`,
            organizationName: row.organizationname?.trim() || "Unknown",
            planType,
            planCategory: benefits?.planCategory ?? null,
            snpSubtype: benefits?.snpSubtype ?? null,
            chronicConditions: benefits?.chronicConditions ?? [],
            hasPartD: benefits?.hasPartD ?? null,
            isZeroDollarDsnp: benefits?.isZeroDollarDsnp ?? null,
            cmsContractType: benefits?.cmsContractType ?? null,
            state: stateAbbrev,
            county,
            zipCode: null as string | null,
            monthlyPremium: benefits?.monthlyPremium ?? num(row.monthlyconsolidatedpremiumi) ?? 0,
            partBGivebackAmount: benefits?.partBGivebackAmount ?? 0,
            lowIncomeSubsidyLevel: null as string | null,
            medicaidLevel: null as string | null,
            medicalDeductible: benefits?.medicalDeductible ?? 0,
            maxOutOfPocket: benefits?.maxOutOfPocket ?? num(row.innetworkmoopamount),
            pcpCopay: benefits?.pcpCopay ?? null,
            specialistCopay: benefits?.specialistCopay ?? null,
            emergencyRoomCopay: benefits?.emergencyRoomCopay ?? null,
            ambulanceCopay: benefits?.ambulanceCopay ?? null,
            outpatientHospitalCopay: benefits?.outpatientHospitalCopay ?? null,
            hospitalStayCopay: benefits?.hospitalStayCopay ?? null,
            skilledNursingCopay: benefits?.skilledNursingCopay ?? null,
            mriCopay: benefits?.mriCopay ?? null,
            catScanCopay: benefits?.catScanCopay ?? null,
            drugDeductible: benefits?.drugDeductible ?? num(row.annualdrugdeductible) ?? 0,
            drugTier1Copay: benefits?.drugTier1Copay ?? null,
            drugTier2Copay: benefits?.drugTier2Copay ?? null,
            drugTier3Copay: benefits?.drugTier3Copay ?? null,
            drugTier4Copay: benefits?.drugTier4Copay ?? null,
            drugTier5Copay: benefits?.drugTier5Copay ?? null,
            drugTier6Copay: benefits?.drugTier6Copay ?? null,
            otcAllowance: benefits?.otcAllowance ?? 0,
            foodCardAllowance: benefits?.foodCardAllowance ?? 0,
            dentalBenefits: benefits?.dentalBenefits ?? null,
            hearingBenefits: benefits?.hearingBenefits ?? null,
            visionBenefits: benefits?.visionBenefits ?? null,
            transportationBenefit: benefits?.transportationBenefit ?? null,
          };
        })
        .filter((d): d is NonNullable<typeof d> => d !== null);

      if (createData.length > 0) {
        await prisma.plan.createMany({ data: createData });
      }
    }

    log(`Progress: ${Math.min(i + batchSize, total)}/${total} rows processed (${imported} imported, ${skipped} skipped)`);
  }

  log(
    `Import complete: ${imported} plans imported, ${skipped} skipped (bad data), ` +
      `${skippedNoPbp} skipped (non-shoppable, no PBP match).`,
  );
  return { imported, skipped };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
if (require.main === module || process.argv[1]?.endsWith("import-cms-data.ts")) {
  runImport()
    .then(({ imported, skipped }) => {
      log(`Final: ${imported} imported, ${skipped} skipped`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("Import failed:", err);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
