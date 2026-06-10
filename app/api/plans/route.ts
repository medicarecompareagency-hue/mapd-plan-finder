import { Prisma } from "@prisma/client";
import { LICENSED_CARRIERS } from "@/lib/licensed-carriers";
import { lisAdjustedPremium, LIS_SUBSIDY_PCT, type LisLevel } from "@/lib/lisBenchmarks";
import { zipToCounty } from "@/lib/zip-to-county";

// SNP ranking spec (Dale, 2026-04-27). See SNP-RANKING-SPEC-2026-04-27.md.
// Phase 1: ranking against existing plan-level columns.
// Phase 2: dental/vision numeric columns.
// Phase 3: per-(plan x Medicaid level) benefits via PlanMedicaidBenefit.
// Phase 1.1 (2026-04-27): chronicCondition gated to CSNP, ISNP excluded,
// allowlist updated for Cigna -> HealthSpring rebrand.
// Phase 1.2 (2026-04-27): dedupe by planId after ranking (same plan in
// multiple counties no longer eats top-5 slots), hasBenefitRank now
// recognizes "No Dental"/"No Vision"/"No Hearing" as missing benefits.
// Phase 1.3 (2026-04-27): SNP dental/vision tiebreakers switched from
// string-based hasBenefitRank to numeric DESC on dentalAnnualMax /
// visionAnnualMax (populated by scripts/import-pbp.js). Plans with
// $0/null annual max fall through to the next tiebreaker; the string
// hasBenefitRank still applies as a final fallback.
// Phase 1.5 (2026-04-27): D-SNP/I-SNP cmp order moved dental above OTC.
// Dual-eligible clients tend to need dental more than OTC supplies.
// New chain: food card > dental > OTC > vision > hospital > premium.
//
// Phase 1.6 (2026-04-27): reverted to Dale's spec - food card > OTC >
// dental > vision > hospital > premium. Per Dale, the dental max amount
// is a ceiling not a guaranteed payout, so it should not outrank OTC.
// Numeric dental display stays in the UI (Phase 1.5).
//
// Phase 1.4 (2026-04-27): top-5 dedupe key changed from planId to
// organizationName so the result surfaces 5 distinct carriers rather
// than 5 plan-segments of the same product line (e.g. all five Cigna
// HealthSpring TotalCare variants across counties). Also bumped the
// pre-ranking candidate pool from MAX_RESULTS*4 to MAX_RESULTS*50 so a
// statewide search (~22k FL D-SNP county-rows) actually sees all
// carriers, not just the first 2000 rows by insertion order.
//
// MA_ONLY ranking (Dale, 2026-05-06). 5 keys, lexicographic, NULL last:
//   1. partBGivebackAmount  DESC
//   2. hospitalStayCopay    ASC  (parsed via parseHospitalCopayDay1)
//   3. specialistCopay      ASC
//   4. pcpCopay             ASC
//   5. dentalAnnualMax      DESC (cmpBenefitDesc)
// Differs from default 6-key by elevating Part B giveback to the top
// (the headline pitch for MA-Only plans) and dropping deductible/MOOP/
// star. MA_ONLY is a PlanCategory enum value, orthogonal to planType
// (HMO/PPO/PFFS/HMOPOS) — see CLAUDE.md domain terminology section.
// DSNP ranking (Dale, 2026-05-12 spec). Split by beneficiary dual level:
//   FULL_DUAL (QMB+, QMB, SLMB+, FBDE) — 6 keys, lexicographic, NULL last:
//     1. foodCardAllowance      DESC
//     2. otcAllowance           DESC
//     3. dentalAnnualMax        DESC (cmpBenefitDesc)
//     4. visionAnnualMax        DESC (cmpBenefitDesc)
//     5. hearingAnnualMax       DESC (cmpBenefitDesc)
//     6. maxOutOfPocket         ASC
//   PARTIAL_DUAL (SLMB, QI-1) — 9 keys, lexicographic, NULL last:
//     1. hospitalStayCopay      ASC (parsed day-1 per-day)
//     2. specialistCopay        ASC (effectiveCopay — coins→999)
//     3. foodCardAllowance      DESC
//     4. otcAllowance           DESC
//     5. dentalAnnualMax        DESC
//     6. visionAnnualMax        DESC
//     7. skilledNursingCopay    ASC (parsed day-1 per-day, same parser)
//     8. hearingAnnualMax       DESC
//     9. maxOutOfPocket         ASC
// DSNP search WITHOUT beneficiaryDualLevel returns empty results: Dale's
// rule is that QMB+/QMB/SLMB+/FBDE plans render with a 20% co-payment
// column that's misleading to PARTIAL_DUAL beneficiaries (and vice
// versa), so we don't show DSNPs until the agent picks who they're
// shopping for.
//
// CSNP ranking (Dale, 2026-05-12 spec). 11 keys, lexicographic, NULL last:
//   1. monthlyPremium         ASC
//   2. hospitalStayCopay      ASC (parsed)
//   3. foodCardAllowance      DESC
//   4. otcAllowance           DESC
//   5. drugDeductible         ASC
//   6. specialistCopay        ASC (effectiveCopay)
//   7. dentalAnnualMax        DESC
//   8. visionAnnualMax        DESC
//   9. skilledNursingCopay    ASC
//  10. hearingAnnualMax       DESC
//  11. maxOutOfPocket         ASC
// Supersedes the prior CSNP 8-key ranker (Phase 1.x, 2026-04-27).
// "Chronic Lung Only" sub-filter is handled via the existing
// chronicCondition dropdown (LUNG_DISORDERS / ANXIETY_WITH_COPD enums) —
// no separate ranker.
//
// ISNP falls through to the default 6-key ranker per Dale 2026-05-12.

export async function GET(request: Request) {
  const { prisma } = await import("@/lib/prisma");
  const { searchParams } = new URL(request.url);

  const where: Prisma.PlanWhereInput = {
    organizationName: { in: [...LICENSED_CARRIERS] },
    AND: [{ planCategory: { not: "ISNP" as never } }],
  };

  const state = searchParams.get("state");
  const zip = searchParams.get("zip");
  let county = searchParams.get("county");

  // ZIP→county fallback: if zip arrives but county does not, resolve server-side.
  // Handles the race where the client fires Search before reverseZipLookup completes.
  // Unrecognized ZIPs (e.g. PO Box ZCTAs) fall through to a statewide search.
  if (zip && !county) {
    const resolved = zipToCounty(zip);
    if (resolved) {
      county = resolved.county;
      if (!state) where.state = resolved.state;
    }
  }

  if (state) where.state = state;
  if (county) {
    const bare = county.replace(/\s+(County|Parish|Borough|Census Area|Municipality|city)$/i, "").trim();
    where.county = bare !== county ? { in: [county, bare] } : county;
  }

  const planYear = searchParams.get("planYear");
  if (planYear) {
    const yearNum = parseInt(planYear, 10);
    if (!Number.isNaN(yearNum)) where.planYear = yearNum;
  }

  const organizationName = searchParams.get("organizationName");
  if (organizationName) where.organizationName = organizationName;

  const planType = searchParams.get("planType");
  if (planType) where.planType = { contains: planType };

  const planCategory = searchParams.get("planCategory");
  if (planCategory) {
    (where as Record<string, unknown>).planCategory = planCategory;
  }
  const snpSubtype = searchParams.get("snpSubtype");
  if (snpSubtype) {
    (where as Record<string, unknown>).snpSubtype = snpSubtype;
  }
  const chronicCondition = searchParams.get("chronicCondition");
  if (chronicCondition && planCategory === "CSNP") {
    (where as Record<string, unknown>).chronicConditions = { has: chronicCondition };
  }
  const isZeroDollarDsnp = searchParams.get("isZeroDollarDsnp");
  if (isZeroDollarDsnp === "true") {
    (where as Record<string, unknown>).isZeroDollarDsnp = true;
  }

  const lowIncomeSubsidyLevel = searchParams.get("lowIncomeSubsidyLevel");
  const medicaidLevel = searchParams.get("medicaidLevel");
  if (lowIncomeSubsidyLevel) where.lowIncomeSubsidyLevel = lowIncomeSubsidyLevel;
  if (medicaidLevel) where.medicaidLevel = medicaidLevel;

  // Beneficiary dual-eligibility level → plan dsnpTargetGroup mapping (2026-05-05).
  //
  // Industry rule per Dale (MAPD agent practice, NOT raw CMS classification):
  // MAPD carriers/agents treat QMB as "full Medicaid" for benefit purposes
  // even though SMAC lists QMB as partial. Carrier example: HealthSpring
  // TotalCare Plus (PBP zero_dollar=1, FULL_DUAL) is marketed for both QMB+
  // and QMB; HealthSpring has no QMB+-specific plan. A QMB user routed to
  // a PARTIAL_DUAL plan (TotalCare proper) would miss richer-benefit options
  // they're entitled to.
  //
  // Mapping (industry-correct, supersedes PBP-literal interpretation):
  //   FULL_DUAL plans (PBP zero_dollar=1):  QMB+, QMB, SLMB+, FBDE
  //   PARTIAL_DUAL plans (zero_dollar=2):   SLMB, QI-1
  //
  // Hard filter — non-matching plans excluded from results entirely.
  // Spec: beneficiary_dual_level_spec memory + 2026-05-05 Dale clarification.
  const beneficiaryDualLevel = searchParams.get("beneficiaryDualLevel");
  const FULL_DUAL_LEVELS = new Set(["QMB+", "QMB", "SLMB+", "FBDE"]);
  const PARTIAL_DUAL_LEVELS = new Set(["SLMB", "QI-1"]);
  let beneficiaryGroup: "FULL_DUAL" | "PARTIAL_DUAL" | null = null;
  if (beneficiaryDualLevel) {
    if (FULL_DUAL_LEVELS.has(beneficiaryDualLevel)) {
      beneficiaryGroup = "FULL_DUAL";
      (where as Record<string, unknown>).dsnpTargetGroup = "FULL_DUAL";
    } else if (PARTIAL_DUAL_LEVELS.has(beneficiaryDualLevel)) {
      beneficiaryGroup = "PARTIAL_DUAL";
      (where as Record<string, unknown>).dsnpTargetGroup = "PARTIAL_DUAL";
    }
  }

  // LIS / Extra Help level — affects ranking and display, NOT the WHERE clause.
  const lisLevelRaw = searchParams.get("lisLevel");
  const lisLevel: LisLevel | null =
    lisLevelRaw && (lisLevelRaw in LIS_SUBSIDY_PCT) ? (lisLevelRaw as LisLevel) : null;

  // Compute LIS-adjusted premium for a plan (uses stored partC/partD columns).
  function planAdjustedPremium(plan: Record<string, unknown>): number {
    const partC = (plan.partCPremium as number | null) ?? (plan.monthlyPremium as number ?? 0);
    const partD = (plan.partDPremium as number | null) ?? 0;
    return lisAdjustedPremium(partC, partD, plan.state as string, lisLevel);
  }

  const numericMaxFilters: [string, keyof Prisma.PlanWhereInput][] = [
    ["monthlyPremium", "monthlyPremium"],
    ["maxOutOfPocket", "maxOutOfPocket"],
    ["medicalDeductible", "medicalDeductible"],
    ["pcpCopay", "pcpCopay"],
    ["specialistCopay", "specialistCopay"],
    ["emergencyRoomCopay", "emergencyRoomCopay"],
    ["ambulanceCopay", "ambulanceCopay"],
    ["outpatientHospitalCopay", "outpatientHospitalCopay"],
    ["mriCopay", "mriCopay"],
    ["catScanCopay", "catScanCopay"],
    ["drugDeductible", "drugDeductible"],
    ["drugTier1Copay", "drugTier1Copay"],
    ["drugTier2Copay", "drugTier2Copay"],
    ["drugTier3Copay", "drugTier3Copay"],
    ["drugTier4Copay", "drugTier4Copay"],
    ["drugTier5Copay", "drugTier5Copay"],
    ["drugTier6Copay", "drugTier6Copay"],
  ];
  for (const [param, field] of numericMaxFilters) {
    const val = searchParams.get(param);
    if (val) {
      (where as Record<string, unknown>)[field] = { lte: parseFloat(val) };
    }
  }

  const numericMinFilters: [string, keyof Prisma.PlanWhereInput][] = [
    ["partBGivebackAmount", "partBGivebackAmount"],
    ["otcAllowance", "otcAllowance"],
    ["foodCardAllowance", "foodCardAllowance"],
  ];
  for (const [param, field] of numericMinFilters) {
    const val = searchParams.get(param);
    if (val) {
      (where as Record<string, unknown>)[field] = { gte: parseFloat(val) };
    }
  }

  const stringBenefitFilters: [string, keyof Prisma.PlanWhereInput][] = [
    ["hospitalStayCopay", "hospitalStayCopay"],
    ["skilledNursingCopay", "skilledNursingCopay"],
    ["dentalBenefits", "dentalBenefits"],
    ["hearingBenefits", "hearingBenefits"],
    ["visionBenefits", "visionBenefits"],
    ["transportationBenefit", "transportationBenefit"],
  ];
  for (const [param, field] of stringBenefitFilters) {
    const val = searchParams.get(param);
    if (val === "yes") {
      (where as Record<string, unknown>)[field] = { not: null, notIn: ["None", ""] };
    } else if (val) {
      (where as Record<string, unknown>)[field] = val;
    }
  }

  const MAX_RESULTS = 500;
  // Pull a wide candidate pool so the ranking sees all carriers in the
  // result set, not just the first 2000 rows by insertion order. A
  // statewide D-SNP search has ~22k county-rows; nationwide ~178k. We
  // cap at 25,000 which is enough for any single-state search and a
  // reasonable subset for nationwide.
  const plans = await prisma.plan.findMany({ where, take: MAX_RESULTS * 50 });

  const isCsnp = planCategory === "CSNP";
  const isDsnp = planCategory === "DSNP";
  const isMaOnly = planCategory === "MA_ONLY";
  // ISNP falls through to default 6-key per Dale 2026-05-12.
  const useDefaultTop5 = !isCsnp && !isDsnp && !isMaOnly;

  // DSNP without a beneficiary dual level returns empty: cost-share
  // columns mean different things to FULL_DUAL vs PARTIAL_DUAL users,
  // and showing both groups mixed produces misleading rankings.
  if (isDsnp && beneficiaryGroup === null) {
    return Response.json([]);
  }

  // effectiveFoodCard priority:
  //   1. sbVerifiedFoodAmount  — from SB PDF (annualized, most accurate)
  //   2. foodCardAllowance     — from PBP pbp_b13i_fd_maxplan_amt (annualized)
  //   3. ssbciFoodAllowance    — from SSBCI PBP (annual per enrich script)
  //      Exception: suppressed when SB PDF confirmed an OTC-only card
  //      (sbVerifiedOtcAmount populated, sbVerifiedFoodAmount null). For those
  //      plans the SSBCI "food" entry is a chronic-condition-gated wallet
  //      expansion of the OTC card, not a standalone food benefit (e.g. Aetna
  //      H3239 Extra Benefits Card / Extra Supports Wallet).
  function effectiveFoodCard(plan: Record<string, unknown>): number | null {
    const sbPdf = plan.sbVerifiedFoodAmount as number | null;
    if (sbPdf != null && sbPdf > 0) return sbPdf;
    const direct = plan.foodCardAllowance as number | null;
    if (direct != null && direct > 0) return direct;
    const sbOtcConfirmed = (plan.sbVerifiedOtcAmount as number | null) != null
      && (plan.sbVerifiedOtcAmount as number) > 0;
    const sbFoodAbsent = (plan.sbVerifiedFoodAmount as number | null) == null;
    if (sbOtcConfirmed && sbFoodAbsent) return null;
    return (plan.ssbciFoodAllowance as number | null) ?? null;
  }

  // effectiveOtc priority:
  //   1. sbVerifiedOtcAmount  — from SB PDF (annualized, most accurate)
  //   2. otcAllowance         — from PBP (annualized; periodicity codebook fixed 2026-06-10)
  //      Exception (2026-06-10, mirror of the effectiveFoodCard suppression):
  //      when the SB PDF was parsed well enough to verify a chronic-gated
  //      food/spending card (sbVerifiedFoodAmount set, ssbciIsConditional)
  //      but found NO all-member OTC benefit, the PBP b13b OTC filing is the
  //      gated wallet itself, not an all-member card — suppress it so the OTC
  //      column never shows gated money as guaranteed (e.g. Devoted H9888-1:
  //      PBP files $100/qtr OTC; its SB offers only the chronic-gated $35/mo
  //      Food & Home Card. 95 Devoted + 30 Aetna plans fit this pattern).
  //   3. sbVerifiedFoodAmount — Humana only: combined "Healthy Options Allowance"
  //                            card; OTC amount === food amount for these plans
  function effectiveOtc(plan: Record<string, unknown>): number | null {
    const sbOtc = plan.sbVerifiedOtcAmount as number | null;
    if (sbOtc != null && sbOtc > 0) return sbOtc;
    const direct = plan.otcAllowance as number | null;
    if (direct != null && direct > 0) {
      // Suppress ONLY when the PBP OTC amount is IDENTICAL to the chronic-
      // gated wallet — that's the same wallet double-filed (e.g. Devoted
      // D-SNPs where otcAllowance === sbVerifiedFoodAmount exactly).
      // 2026-06-10 correction per Dale: when PBP files a DIFFERENT amount,
      // it's a genuine all-member OTC benefit even if the SB doesn't itemize
      // it (CMS base b13b filings must be uniform for all enrollees) — e.g.
      // Devoted H9888-1 files $100/qtr all-member OTC alongside its $35/mo
      // chronic Food & Home Card. Do NOT hide it.
      const sbFood = plan.sbVerifiedFoodAmount as number | null;
      const gated = plan.ssbciIsConditional === true;
      if (gated && sbFood != null && sbFood > 0 && direct === sbFood) return null;
      return direct;
    }
    // Humana combined card: OTC wallet === food wallet, same dollar amount
    const orgName = String(plan.organizationName ?? "").toLowerCase();
    if (orgName.includes("humana")) {
      const sbFood = plan.sbVerifiedFoodAmount as number | null;
      if (sbFood != null && sbFood > 0) return sbFood;
    }
    return null;
  }

  function cmp(a: number | null | undefined, b: number | null | undefined, ascending: boolean): number {
    const aNull = a == null;
    const bNull = b == null;
    if (aNull && bNull) return 0;
    if (aNull) return 1;
    if (bNull) return -1;
    return ascending ? (a as number) - (b as number) : (b as number) - (a as number);
  }

  // Cost-share rank value for ASC sort keys (PCP, Specialist, etc.).
  // Plans that filed coinsurance instead of a flat copay (typical partial-
  // dual DSNP filings) sort LAST under each cost-share key. Per Dale 2026-
  // 05-07: high coins = bad for SLMB beneficiaries, so penalize at $999.
  // True nulls (no copay AND no coinsurance filed) keep the existing
  // null-last behavior in cmp().
  function effectiveCopay(plan: Record<string, unknown>, copayField: string, coinsPctField: string): number | null {
    const c = plan[copayField] as number | null | undefined;
    if (c != null) return c;
    const p = plan[coinsPctField] as number | null | undefined;
    if (p != null) return 999;
    return null;
  }

  function parseHospitalCopayDay1(val: unknown): number | null {
    if (val == null) return null;
    const s = String(val).trim();
    if (!s || /^none$/i.test(s)) return null;
    let m = s.match(/\$?\s*(\d+(?:\.\d+)?)\s*(?:\/|per\s*)day/i);
    if (m) return parseFloat(m[1]);
    m = s.match(/\$?\s*(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : null;
  }

  // Recognize common "no benefit" markers used in CMS data:
  // null, empty, "None", "No Dental", "No Vision", "No Hearing", "Not Covered".
  // Returns 0 if benefit is present (sorts first), 1 if missing.
  function hasBenefitRank(val: unknown): number {
    if (val == null) return 1;
    const s = String(val).trim();
    if (!s) return 1;
    if (/^(none|no\b|not\s+covered)/i.test(s)) return 1;
    return 0;
  }

  // Dedupe a sorted list by planId, keeping the first occurrence.
  function dedupeByPlanId(sorted: Array<Record<string, unknown>>, n: number): Array<Record<string, unknown>> {
    const seen = new Set<string>();
    const out: Array<Record<string, unknown>> = [];
    for (const plan of sorted) {
      const id = String(plan.planId ?? "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(plan);
      if (out.length >= n) break;
    }
    return out;
  }

  // Dedupe a sorted list by organizationName (case/whitespace normalized),
  // keeping the first (highest-ranked) plan per carrier. Phase 1.4 default.
  function dedupeByCarrier(sorted: Array<Record<string, unknown>>, n: number): Array<Record<string, unknown>> {
    const seen = new Set<string>();
    const out: Array<Record<string, unknown>> = [];
    for (const plan of sorted) {
      const carrier = String(plan.organizationName ?? "").toLowerCase().trim();
      if (!carrier || seen.has(carrier)) continue;
      seen.add(carrier);
      out.push(plan);
      if (out.length >= n) break;
    }
    return out;
  }


  // Numeric benefit rank: returns the dollar value if > 0, else 0.
  // We use cmpBenefitDesc so that two zeros tie cleanly without NaN.
  function numericBenefit(val: unknown): number {
    if (val == null) return 0;
    const n = typeof val === "number" ? val : parseFloat(String(val));
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n;
  }
  // Descending compare: higher numericBenefit sorts first; equal values tie.
  function cmpBenefitDesc(a: unknown, b: unknown): number {
    const av = numericBenefit(a);
    const bv = numericBenefit(b);
    if (av === bv) return 0;
    return bv - av;
  }

  let sorted: Array<Record<string, unknown>>;

  if (useDefaultTop5) {
    sorted = (plans as Array<Record<string, unknown>>)
      .slice()
      .sort((a, b) => {
        // When LIS level selected, rank by adjusted premium; otherwise raw consolidated.
        let c = cmp(planAdjustedPremium(a), planAdjustedPremium(b), true);
        if (c !== 0) return c;
        c = cmp(a.medicalDeductible as number | null, b.medicalDeductible as number | null, true);
        if (c !== 0) return c;
        const ah = parseHospitalCopayDay1(a.hospitalStayCopay);
        const bh = parseHospitalCopayDay1(b.hospitalStayCopay);
        c = cmp(ah, bh, true);
        if (c !== 0) return c;
        c = cmp(effectiveCopay(a, "specialistCopay", "specialistCoinsPct"), effectiveCopay(b, "specialistCopay", "specialistCoinsPct"), true);
        if (c !== 0) return c;
        c = cmp(a.maxOutOfPocket as number | null, b.maxOutOfPocket as number | null, true);
        if (c !== 0) return c;
        return cmp(a.starRating as number | null, b.starRating as number | null, false);
      });
  } else if (isCsnp) {
    // CSNP 7-key ranking per Dale 2026-05-26 spec.
    // specialist → food/utilities → OTC → hospital → dental → vision → MOOP
    sorted = (plans as Array<Record<string, unknown>>)
      .slice()
      .sort((a, b) => {
        let c = cmp(effectiveCopay(a, "specialistCopay", "specialistCoinsPct"), effectiveCopay(b, "specialistCopay", "specialistCoinsPct"), true);
        if (c !== 0) return c;
        c = cmp(effectiveFoodCard(a), effectiveFoodCard(b), false);
        if (c !== 0) return c;
        c = cmp(effectiveOtc(a), effectiveOtc(b), false);
        if (c !== 0) return c;
        const ah = parseHospitalCopayDay1(a.hospitalStayCopay);
        const bh = parseHospitalCopayDay1(b.hospitalStayCopay);
        c = cmp(ah, bh, true);
        if (c !== 0) return c;
        c = cmpBenefitDesc(a.dentalAnnualMax, b.dentalAnnualMax);
        if (c !== 0) return c;
        c = cmpBenefitDesc(a.visionAnnualMax, b.visionAnnualMax);
        if (c !== 0) return c;
        return cmp(a.maxOutOfPocket as number | null, b.maxOutOfPocket as number | null, true);
      });
  } else if (isMaOnly) {
    // MA_ONLY 5-key ranking per Dale 2026-05-06.
    // Giveback is the headline pitch for these plans (no drug coverage
    // means the carrier has more room to push Part B premium back).
    sorted = (plans as Array<Record<string, unknown>>)
      .slice()
      .sort((a, b) => {
        let c = cmp(a.partBGivebackAmount as number | null, b.partBGivebackAmount as number | null, false);
        if (c !== 0) return c;
        const ah = parseHospitalCopayDay1(a.hospitalStayCopay);
        const bh = parseHospitalCopayDay1(b.hospitalStayCopay);
        c = cmp(ah, bh, true);
        if (c !== 0) return c;
        c = cmp(effectiveCopay(a, "specialistCopay", "specialistCoinsPct"), effectiveCopay(b, "specialistCopay", "specialistCoinsPct"), true);
        if (c !== 0) return c;
        c = cmp(effectiveCopay(a, "pcpCopay", "pcpCoinsPct"), effectiveCopay(b, "pcpCopay", "pcpCoinsPct"), true);
        if (c !== 0) return c;
        return cmpBenefitDesc(a.dentalAnnualMax, b.dentalAnnualMax);
      });
  } else if (isDsnp && beneficiaryGroup === "FULL_DUAL") {
    // DSNP FULL_DUAL (QMB, QMB+, FBDE) 5-key ranking per Dale 2026-05-26 spec.
    // food/utilities → OTC → dental → vision → transportation
    sorted = (plans as Array<Record<string, unknown>>)
      .slice()
      .sort((a, b) => {
        let c = cmp(effectiveFoodCard(a), effectiveFoodCard(b), false);
        if (c !== 0) return c;
        c = cmp(effectiveOtc(a), effectiveOtc(b), false);
        if (c !== 0) return c;
        c = cmpBenefitDesc(a.dentalAnnualMax, b.dentalAnnualMax);
        if (c !== 0) return c;
        c = cmpBenefitDesc(a.visionAnnualMax, b.visionAnnualMax);
        if (c !== 0) return c;
        return cmp(hasBenefitRank(a.transportationBenefit), hasBenefitRank(b.transportationBenefit), true);
      });
  } else {
    // DSNP PARTIAL_DUAL (SLMB, QI-1) 7-key ranking per Dale 2026-05-26 spec.
    // specialist → food/utilities → OTC → hospital → dental → vision → MOOP
    // This branch only fires when isDsnp && beneficiaryGroup === "PARTIAL_DUAL";
    // the no-level case returns empty earlier (above the prisma query).
    sorted = (plans as Array<Record<string, unknown>>)
      .slice()
      .sort((a, b) => {
        let c = cmp(effectiveCopay(a, "specialistCopay", "specialistCoinsPct"), effectiveCopay(b, "specialistCopay", "specialistCoinsPct"), true);
        if (c !== 0) return c;
        c = cmp(effectiveFoodCard(a), effectiveFoodCard(b), false);
        if (c !== 0) return c;
        c = cmp(effectiveOtc(a), effectiveOtc(b), false);
        if (c !== 0) return c;
        const ah = parseHospitalCopayDay1(a.hospitalStayCopay);
        const bh = parseHospitalCopayDay1(b.hospitalStayCopay);
        c = cmp(ah, bh, true);
        if (c !== 0) return c;
        c = cmpBenefitDesc(a.dentalAnnualMax, b.dentalAnnualMax);
        if (c !== 0) return c;
        c = cmpBenefitDesc(a.visionAnnualMax, b.visionAnnualMax);
        if (c !== 0) return c;
        return cmp(a.maxOutOfPocket as number | null, b.maxOutOfPocket as number | null, true);
      });
  }

  const ranked = dedupeByCarrier(sorted, 5).map((plan, i) => ({
    ...plan,
    rank: i + 1,
    // Use effective values for display (effectiveOtc/effectiveFoodCard are also
    // used for ranking, but the raw plan fields are what the UI renders).
    // No ?? fallback to the raw column: effectiveOtc returning null can mean
    // "suppressed — SB shows the PBP OTC filing is a chronic-gated wallet"
    // (2026-06-10), and falling back would undo that.
    otcAllowance: effectiveOtc(plan),
    foodCardAllowance: effectiveFoodCard(plan) ?? 0,
    ssbciFoodAllowance: effectiveFoodCard(plan),
    // LIS-adjusted premium for display on the card. Always computed; equals
    // monthlyPremium when lisLevel is null (no subsidy applied).
    adjustedPremium: planAdjustedPremium(plan),
  }));

  return Response.json(ranked);
}

export async function POST(request: Request) {
  const { prisma } = await import("@/lib/prisma");
  const body = await request.json();

  const state: string | undefined = body.state;
  const county: string | undefined = body.county;

  if (!state) {
    return Response.json({
      states: [], counties: [], zipCodes: [], planTypes: [],
      planCategories: [], snpSubtypes: [], chronicConditions: [],
      hasZeroDollarDsnp: false,
      planYears: [], organizationNames: [], starRatings: [],
      monthlyPremiums: [], lowIncomeSubsidyLevels: [], medicaidLevels: [],
      pcpCopays: [], specialistCopays: [], hospitalStayCopays: [],
      skilledNursingCopays: [], maxOutOfPockets: [], medicalDeductibles: [],
      emergencyRoomCopays: [], ambulanceCopays: [], outpatientHospitalCopays: [],
      drugTier1Copays: [], drugTier2Copays: [], drugTier3Copays: [],
      drugTier4Copays: [], drugTier5Copays: [], drugTier6Copays: [],
      drugDeductibles: [], otcAllowances: [], foodCardAllowances: [],
      mriCopays: [], catScanCopays: [], partBGivebackAmounts: [],
      dentalBenefits: [], hearingBenefits: [], visionBenefits: [],
      transportationBenefits: [],
    });
  }

  const where: Prisma.PlanWhereInput = {
    state,
    organizationName: { in: [...LICENSED_CARRIERS] },
    AND: [{ planCategory: { not: "ISNP" as never } }],
  };
  if (county) {
    const bare = county.replace(/\s+(County|Parish|Borough|Census Area|Municipality|city)$/i, "").trim();
    where.county = bare !== county ? { in: [county, bare] } : county;
  }

  const plans = await prisma.plan.findMany({
    where,
    select: {
      state: true,
      county: true,
      zipCode: true,
      planType: true,
      planCategory: true,
      snpSubtype: true,
      chronicConditions: true,
      isZeroDollarDsnp: true,
      planYear: true,
      organizationName: true,
      starRating: true,
      monthlyPremium: true,
      partCPremium: true,
      partDPremium: true,
      lowIncomeSubsidyLevel: true,
      medicaidLevel: true,
      pcpCopay: true,
      specialistCopay: true,
      hospitalStayCopay: true,
      skilledNursingCopay: true,
      maxOutOfPocket: true,
      medicalDeductible: true,
      emergencyRoomCopay: true,
      ambulanceCopay: true,
      outpatientHospitalCopay: true,
      drugTier1Copay: true,
      drugTier2Copay: true,
      drugTier3Copay: true,
      drugTier4Copay: true,
      drugTier5Copay: true,
      drugTier6Copay: true,
      drugDeductible: true,
      otcAllowance: true,
      foodCardAllowance: true,
      ssbciFoodAllowance: true,
      mriCopay: true,
      catScanCopay: true,
      partBGivebackAmount: true,
      dentalBenefits: true,
      hearingBenefits: true,
      visionBenefits: true,
      transportationBenefit: true,
    },
  });

  function unique<T>(arr: (T | null | undefined)[]): T[] {
    return [...new Set(arr.filter((v): v is T => v != null && v !== undefined))].sort() as T[];
  }
  function uniqueNumbers(arr: (number | null | undefined)[]): number[] {
    return [...new Set(arr.filter((v): v is number => v != null))].sort((a, b) => a - b);
  }

  const chronicConditionsInScope = unique(
    plans.flatMap((p: any) => (p.chronicConditions ?? []) as string[]),
  );

  return Response.json({
    states: unique(plans.map((p: any) => p.state)),
    counties: unique(plans.map((p: any) => p.county)),
    zipCodes: unique(plans.map((p: any) => p.zipCode)),
    planTypes: unique(plans.map((p: any) => p.planType)),
    planCategories: unique(plans.map((p: any) => p.planCategory)).filter((c: string) => c !== "ISNP"),
    snpSubtypes: unique(plans.map((p: any) => p.snpSubtype)),
    chronicConditions: chronicConditionsInScope,
    hasZeroDollarDsnp: plans.some((p: any) => p.isZeroDollarDsnp === true),
    planYears: uniqueNumbers(plans.map((p: any) => p.planYear)),
    organizationNames: unique(plans.map((p: any) => p.organizationName)),
    starRatings: uniqueNumbers(plans.map((p: any) => p.starRating)),
    monthlyPremiums: uniqueNumbers(plans.map((p: any) => p.monthlyPremium)),
    lowIncomeSubsidyLevels: unique(plans.map((p: any) => p.lowIncomeSubsidyLevel)),
    medicaidLevels: unique(plans.map((p: any) => p.medicaidLevel)),
    pcpCopays: uniqueNumbers(plans.map((p: any) => p.pcpCopay)),
    specialistCopays: uniqueNumbers(plans.map((p: any) => p.specialistCopay)),
    hospitalStayCopays: unique(plans.map((p: any) => p.hospitalStayCopay)),
    skilledNursingCopays: unique(plans.map((p: any) => p.skilledNursingCopay)),
    maxOutOfPockets: uniqueNumbers(plans.map((p: any) => p.maxOutOfPocket)),
    medicalDeductibles: uniqueNumbers(plans.map((p: any) => p.medicalDeductible)),
    emergencyRoomCopays: uniqueNumbers(plans.map((p: any) => p.emergencyRoomCopay)),
    ambulanceCopays: uniqueNumbers(plans.map((p: any) => p.ambulanceCopay)),
    outpatientHospitalCopays: uniqueNumbers(plans.map((p: any) => p.outpatientHospitalCopay)),
    drugTier1Copays: uniqueNumbers(plans.map((p: any) => p.drugTier1Copay)),
    drugTier2Copays: uniqueNumbers(plans.map((p: any) => p.drugTier2Copay)),
    drugTier3Copays: uniqueNumbers(plans.map((p: any) => p.drugTier3Copay)),
    drugTier4Copays: uniqueNumbers(plans.map((p: any) => p.drugTier4Copay)),
    drugTier5Copays: uniqueNumbers(plans.map((p: any) => p.drugTier5Copay)),
    drugTier6Copays: uniqueNumbers(plans.map((p: any) => p.drugTier6Copay)),
    drugDeductibles: uniqueNumbers(plans.map((p: any) => p.drugDeductible)),
    otcAllowances: uniqueNumbers(plans.map((p: any) => p.otcAllowance)),
    foodCardAllowances: uniqueNumbers(plans.map((p: any) => p.foodCardAllowance > 0 ? p.foodCardAllowance : (p.ssbciFoodAllowance ?? p.foodCardAllowance))),
    mriCopays: uniqueNumbers(plans.map((p: any) => p.mriCopay)),
    catScanCopays: uniqueNumbers(plans.map((p: any) => p.catScanCopay)),
    partBGivebackAmounts: uniqueNumbers(plans.map((p: any) => p.partBGivebackAmount)),
    dentalBenefits: unique(plans.map((p: any) => p.dentalBenefits)),
    hearingBenefits: unique(plans.map((p: any) => p.hearingBenefits)),
    visionBenefits: unique(plans.map((p: any) => p.visionBenefits)),
    transportationBenefits: unique(plans.map((p: any) => p.transportationBenefit)),
  });
}
