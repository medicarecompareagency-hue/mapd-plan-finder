// 2026 federal LIS (Extra Help) drug copays. Source: CMS "CY2026 Resource and Cost-Sharing
// Limits for the Low-Income Subsidy" memo, Table 2 (cy2026-lis-resource-limits-memo.pdf).
// Every MSP/dual beneficiary gets FULL (100%) LIS; only the $ amount differs by full-benefit status.
export const LIS_DRUG_COPAY_2026 = {
  FULL_BENEFIT: { generic: 1.6, brand: 4.9 },   // full-benefit dual (typical, income <= 100% FPL)
  NON_FULL:     { generic: 5.1, brand: 12.65 },  // QMB-only / SLMB-only / QI (non-full-benefit)
  OOP_THRESHOLD: 2100,                            // $0 cost-share above this annual OOP
};

// Map the beneficiary dual-level dropdown value -> LIS schedule by full-benefit status.
export const LIS_FULL_BENEFIT_LEVELS = new Set(["QMB+", "SLMB+", "FBDE"]);
export const LIS_NON_FULL_BENEFIT_LEVELS = new Set(["QMB", "SLMB", "QI-1"]);

export function lisScheduleForLevel(dualLevel: string | null | undefined) {
  if (!dualLevel) return null;
  if (LIS_FULL_BENEFIT_LEVELS.has(dualLevel)) return LIS_DRUG_COPAY_2026.FULL_BENEFIT;
  if (LIS_NON_FULL_BENEFIT_LEVELS.has(dualLevel)) return LIS_DRUG_COPAY_2026.NON_FULL;
  return null;
}

// Standard 2026 Part D tier -> drug type. T1-2 generic; T3-5 brand/specialty (LIS = flat copay,
// no coinsurance below catastrophic); T6 select-care/vaccines = $0. Returns dollars or null.
export function lisCopayForTier(tierNum: number, dualLevel: string | null | undefined): number | null {
  const s = lisScheduleForLevel(dualLevel);
  if (!s) return null;
  if (tierNum === 6) return 0;
  if (tierNum <= 2) return s.generic;
  return s.brand;
}
