import { Prisma } from "@prisma/client";
import { LICENSED_CARRIERS } from "@/lib/licensed-carriers";

// SNP ranking spec (Dale, 2026-04-27). See SNP-RANKING-SPEC-2026-04-27.md.
// Phase 1: ranking against existing plan-level columns.
// Phase 2: dental/vision numeric columns.
// Phase 3: per-(plan x Medicaid level) benefits via PlanMedicaidBenefit.
const DSNP_LIKE = new Set(["DSNP", "ISNP"]);

export async function GET(request: Request) {
  const { prisma } = await import("@/lib/prisma");
  const { searchParams } = new URL(request.url);

  const where: Prisma.PlanWhereInput = {
    // Always gate results on Dale's 6-carrier allowlist (2026-04-23).
    organizationName: { in: [...LICENSED_CARRIERS] },
  };

  // Location filters
  const state = searchParams.get("state");
  const county = searchParams.get("county");
  if (state) where.state = state;
  if (county) {
    const bare = county.replace(/\s+(County|Parish|Borough|Census Area|Municipality|city)$/i, "").trim();
    where.county = bare !== county ? { in: [county, bare] } : county;
  }

  // Plan Year filter (backlog #5, added 2026-04-22)
  const planYear = searchParams.get("planYear");
  if (planYear) {
    const yearNum = parseInt(planYear, 10);
    if (!Number.isNaN(yearNum)) where.planYear = yearNum;
  }

  // Carrier filter (backlog #4, 2026-04-22)
  const organizationName = searchParams.get("organizationName");
  if (organizationName) where.organizationName = organizationName;

  // Plan type (legacy contract-type string field)
  const planType = searchParams.get("planType");
  if (planType) where.planType = { contains: planType };

  // Plan category taxonomy
  const planCategory = searchParams.get("planCategory");
  if (planCategory) {
    (where as Record<string, unknown>).planCategory = planCategory;
  }
  const snpSubtype = searchParams.get("snpSubtype");
  if (snpSubtype) {
    (where as Record<string, unknown>).snpSubtype = snpSubtype;
  }
  const chronicCondition = searchParams.get("chronicCondition");
  if (chronicCondition) {
    (where as Record<string, unknown>).chronicConditions = { has: chronicCondition };
  }
  const isZeroDollarDsnp = searchParams.get("isZeroDollarDsnp");
  if (isZeroDollarDsnp === "true") {
    (where as Record<string, unknown>).isZeroDollarDsnp = true;
  }

  // String category filters
  const lowIncomeSubsidyLevel = searchParams.get("lowIncomeSubsidyLevel");
  const medicaidLevel = searchParams.get("medicaidLevel");
  if (lowIncomeSubsidyLevel) where.lowIncomeSubsidyLevel = lowIncomeSubsidyLevel;
  if (medicaidLevel) where.medicaidLevel = medicaidLevel;

  // Numeric "at most" filters
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

  // Numeric "at least" filters
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

  // String benefit filters
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
  const plans = await prisma.plan.findMany({ where, take: MAX_RESULTS * 2 });

  // --- Ranking (Phase 1, Dale 2026-04-27) ---
  const isCsnp = planCategory === "CSNP";
  const isDsnpLike = !!(planCategory && DSNP_LIKE.has(planCategory));
  const useDefaultTop5 = !isCsnp && !isDsnpLike;

  function cmp(a: number | null | undefined, b: number | null | undefined, ascending: boolean): number {
    const aNull = a == null;
    const bNull = b == null;
    if (aNull && bNull) return 0;
    if (aNull) return 1;
    if (bNull) return -1;
    return ascending ? (a as number) - (b as number) : (b as number) - (a as number);
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

  // Phase 1 placeholder for "best dental/vision". Returns 0 if plan has a
  // non-trivial benefit, 1 otherwise. Phase 2 replaces with numeric columns.
  function hasBenefitRank(val: unknown): number {
    if (val == null) return 1;
    const s = String(val).trim();
    if (!s) return 1;
    if (/^none$/i.test(s)) return 1;
    return 0;
  }

  let ranked: Array<Record<string, unknown>>;

  if (useDefaultTop5) {
    // Default 6-key
    ranked = (plans as Array<Record<string, unknown>>)
      .slice()
      .sort((a, b) => {
        let c = cmp(a.monthlyPremium as number | null, b.monthlyPremium as number | null, true);
        if (c !== 0) return c;
        c = cmp(a.medicalDeductible as number | null, b.medicalDeductible as number | null, true);
        if (c !== 0) return c;
        const ah = parseHospitalCopayDay1(a.hospitalStayCopay);
        const bh = parseHospitalCopayDay1(b.hospitalStayCopay);
        c = cmp(ah, bh, true);
        if (c !== 0) return c;
        c = cmp(a.specialistCopay as number | null, b.specialistCopay as number | null, true);
        if (c !== 0) return c;
        c = cmp(a.maxOutOfPocket as number | null, b.maxOutOfPocket as number | null, true);
        if (c !== 0) return c;
        return cmp(a.starRating as number | null, b.starRating as number | null, false);
      })
      .slice(0, 5)
      .map((plan, i) => ({ ...plan, rank: i + 1 }));
  } else if (isCsnp) {
    // C-SNP 6-key: premium -> food card -> OTC -> dental -> hosp copay -> vision
    ranked = (plans as Array<Record<string, unknown>>)
      .slice()
      .sort((a, b) => {
        let c = cmp(a.monthlyPremium as number | null, b.monthlyPremium as number | null, true);
        if (c !== 0) return c;
        c = cmp(a.foodCardAllowance as number | null, b.foodCardAllowance as number | null, false);
        if (c !== 0) return c;
        c = cmp(a.otcAllowance as number | null, b.otcAllowance as number | null, false);
        if (c !== 0) return c;
        c = hasBenefitRank(a.dentalBenefits) - hasBenefitRank(b.dentalBenefits);
        if (c !== 0) return c;
        const ah = parseHospitalCopayDay1(a.hospitalStayCopay);
        const bh = parseHospitalCopayDay1(b.hospitalStayCopay);
        c = cmp(ah, bh, true);
        if (c !== 0) return c;
        return hasBenefitRank(a.visionBenefits) - hasBenefitRank(b.visionBenefits);
      })
      .slice(0, 5)
      .map((plan, i) => ({ ...plan, rank: i + 1 }));
  } else {
    // D-SNP / I-SNP 6-key: food card -> OTC -> dental -> vision -> hosp copay -> premium
    // Per-Medicaid-level variance NOT applied (Phase 3).
    ranked = (plans as Array<Record<string, unknown>>)
      .slice()
      .sort((a, b) => {
        let c = cmp(a.foodCardAllowance as number | null, b.foodCardAllowance as number | null, false);
        if (c !== 0) return c;
        c = cmp(a.otcAllowance as number | null, b.otcAllowance as number | null, false);
        if (c !== 0) return c;
        c = hasBenefitRank(a.dentalBenefits) - hasBenefitRank(b.dentalBenefits);
        if (c !== 0) return c;
        c = hasBenefitRank(a.visionBenefits) - hasBenefitRank(b.visionBenefits);
        if (c !== 0) return c;
        const ah = parseHospitalCopayDay1(a.hospitalStayCopay);
        const bh = parseHospitalCopayDay1(b.hospitalStayCopay);
        c = cmp(ah, bh, true);
        if (c !== 0) return c;
        return cmp(a.monthlyPremium as number | null, b.monthlyPremium as number | null, true);
      })
      .slice(0, 5)
      .map((plan, i) => ({ ...plan, rank: i + 1 }));
  }

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
  };
  if (county) {
    const bare = county.replace(/\s+(County|Parish|Borough|Census Area|Municipality|city)$/i, "").trim();
    where.county = bare !== county ? { in: [county, bare] } : county;
  }

  const plans = await prisma.plan.findMany({ where });

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
    planCategories: unique(plans.map((p: any) => p.planCategory)),
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
    foodCardAllowances: uniqueNumbers(plans.map((p: any) => p.foodCardAllowance)),
    mriCopays: uniqueNumbers(plans.map((p: any) => p.mriCopay)),
    catScanCopays: uniqueNumbers(plans.map((p: any) => p.catScanCopay)),
    partBGivebackAmounts: uniqueNumbers(plans.map((p: any) => p.partBGivebackAmount)),
    dentalBenefits: unique(plans.map((p: any) => p.dentalBenefits)),
    hearingBenefits: unique(plans.map((p: any) => p.hearingBenefits)),
    visionBenefits: unique(plans.map((p: any) => p.visionBenefits)),
    transportationBenefits: unique(plans.map((p: any) => p.transportationBenefit)),
  });
}
