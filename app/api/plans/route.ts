import { Prisma } from "@prisma/client";

export async function GET(request: Request) {
  const { prisma } = await import("@/lib/prisma");
  const { searchParams } = new URL(request.url);

  const where: Prisma.PlanWhereInput = {};

  // Location filters
  const state = searchParams.get("state");
  const county = searchParams.get("county");
  if (state) where.state = state;
  if (county) {
    // The geography API returns "Miami-Dade County" but CMS data stores "Miami-Dade".
    // Try the exact value first; if it has a " County"/" Parish" suffix, also match without it.
    const bare = county.replace(/\s+(County|Parish|Borough|Census Area|Municipality|city)$/i, "").trim();
    where.county = bare !== county ? { in: [county, bare] } : county;
  }
  // Note: zipCode is used for location selection only (to resolve state+county).
  // CMS-imported plans don't have per-zip data, so we filter by state+county instead.

  // Plan type filter (legacy contract-type string field — kept for back-compat)
  const planType = searchParams.get("planType");
  if (planType) where.planType = { contains: planType };

  // Plan category taxonomy (added 2026-04-21 for backlog item #1)
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

  // Numeric "at most" filters — user picks a max value, we return plans at or below
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

  // Numeric "at least" filters — higher is better (allowances, givebacks)
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

  // String benefit filters — "any" means has a non-null value, specific value = exact match
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
      // Exact match for specific copay structure (e.g. "$290/day days 1-7, $0/day days 8-90")
      (where as Record<string, unknown>)[field] = val;
    }
  }

  const MAX_RESULTS = 500;
  const plans = await prisma.plan.findMany({ where, take: MAX_RESULTS * 2 });

  // --- Ranking ---
  // Build a scoring function based on which filters the user selected.
  // Lower costs = better rank. Higher benefits = better rank.
  const activeFilters = Array.from(searchParams.keys());

  function scorePlan(plan: Record<string, unknown>): number {
    let score = 0;

    // Cost fields: lower is better (add to score — lower total = better rank)
    const costFields = [
      "monthlyPremium", "maxOutOfPocket", "medicalDeductible",
      "pcpCopay", "specialistCopay", "emergencyRoomCopay", "ambulanceCopay",
      "outpatientHospitalCopay", "mriCopay", "catScanCopay",
      "drugDeductible", "drugTier1Copay", "drugTier2Copay", "drugTier3Copay",
      "drugTier4Copay", "drugTier5Copay", "drugTier6Copay",
    ];

    // Benefit fields: higher is better (subtract from score)
    const benefitFields = [
      "partBGivebackAmount", "otcAllowance", "foodCardAllowance",
    ];

    for (const f of costFields) {
      if (activeFilters.includes(f)) {
        const v = plan[f];
        score += typeof v === "number" ? v : 0;
      }
    }

    for (const f of benefitFields) {
      if (activeFilters.includes(f)) {
        const v = plan[f];
        score -= typeof v === "number" ? v : 0;
      }
    }

    // String benefits: plans with actual benefits get a bonus
    const stringBenefits = [
      "dentalBenefits", "hearingBenefits", "visionBenefits", "transportationBenefit",
    ];
    for (const f of stringBenefits) {
      if (activeFilters.includes(f)) {
        const v = plan[f] as string | null;
        if (v && v !== "None" && !v.toLowerCase().includes("only")) {
          score -= 500; // comprehensive benefit bonus
        } else if (v && v !== "None") {
          score -= 100; // some benefit bonus
        }
      }
    }

    // If no cost/benefit filters selected, rank by premium + MOOP, but deprioritize
    // plans that lack standard copay data (MSA, PFFS, etc.)
    if (activeFilters.filter((f) => !["state", "county", "zipCode"].includes(f)).length === 0) {
      score = (plan.monthlyPremium as number) + ((plan.maxOutOfPocket as number) || 0) - ((plan.partBGivebackAmount as number) || 0);
      // Plans missing core copay fields get a penalty so data-rich plans rank higher
      const coreFields = ["pcpCopay", "specialistCopay", "emergencyRoomCopay", "maxOutOfPocket"];
      const nullCount = coreFields.filter((f) => plan[f] == null).length;
      score += nullCount * 5000;
    }

    return score;
  }

  const ranked = plans
    .map((plan) => ({ ...plan, _score: scorePlan(plan as unknown as Record<string, unknown>) }))
    .sort((a, b) => a._score - b._score)
    .slice(0, MAX_RESULTS)
    .map(({ _score, ...plan }, i) => ({ ...plan, rank: i + 1 }));

  return Response.json(ranked);
}

export async function POST(request: Request) {
  const { prisma } = await import("@/lib/prisma");
  const body = await request.json();

  // Return distinct values for filter dropdowns, scoped by state (and optionally county).
  // Without a state the query would scan the entire plans table (~186k rows) and hit
  // Vercel's function timeout, so require a state up-front.
  const state: string | undefined = body.state;
  const county: string | undefined = body.county;

  if (!state) {
    return Response.json({
      states: [], counties: [], zipCodes: [], planTypes: [],
      planCategories: [], snpSubtypes: [], chronicConditions: [],
      hasZeroDollarDsnp: false,
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

  const where: Prisma.PlanWhereInput = { state };
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

  // Flatten chronic-condition arrays across all plans in scope to find which
  // CSNP conditions are actually offered in this state/county.
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
