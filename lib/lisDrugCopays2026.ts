// 2026 federal LIS (Extra Help) drug copays. Source: CMS "CY2026 Resource and Cost-Sharing
// Limits for the Low-Income Subsidy" memo, Table 2 (cy2026-lis-resource-limits-memo.pdf).
// Every MSP/dual beneficiary gets FULL (100%) LIS; only the $ amount differs by full-benefit status.
export const LIS_DRUG_COPAY_2026 = {
  FULL_BENEFIT: { generic: 1.6, brand: 4.9 },   // full-benefit dual (typical, income <= 100% FPL)
  NON_FULL:     { generic: 5.1, brand: 12.65 },  // QMB-only / SLMB-only / QI (non-full-benefit)
  OOP_THRESHOLD: 2100,                            // $0 cost-share above this annual OOP
};

// 2027 federal LIS drug copays. Source: CMS CY2027 Rate Announcement (April 6, 2026), Table V-2
// "Updated Part D Benefit Parameters" (2027-announcement.pdf): FBDE up to 100% FPL $1.65 / $5.00;
// category code 1 (QMB/SLMB/QI non-FBDE, and FBDE 100-150% FPL) $5.80 / $14.40; OOP threshold $2,400.
export const LIS_DRUG_COPAY_2027 = {
  FULL_BENEFIT: { generic: 1.65, brand: 5.0 },
  NON_FULL:     { generic: 5.8, brand: 14.4 },
  OOP_THRESHOLD: 2400,
};

// Schedule per plan year. A plan year with no table yet falls back to 2026.
const LIS_DRUG_COPAY_BY_YEAR: Record<number, typeof LIS_DRUG_COPAY_2026> = {
  2026: LIS_DRUG_COPAY_2026,
  2027: LIS_DRUG_COPAY_2027,
};
export function lisDrugCopayTable(planYear?: number | null) {
  return LIS_DRUG_COPAY_BY_YEAR[planYear ?? 2026] ?? LIS_DRUG_COPAY_2026;
}

// Map the beneficiary dual-level dropdown value -> LIS schedule by full-benefit status.
export const LIS_FULL_BENEFIT_LEVELS = new Set(["QMB+", "SLMB+", "FBDE"]);
export const LIS_NON_FULL_BENEFIT_LEVELS = new Set(["QMB", "SLMB", "QI-1"]);

export function lisScheduleForLevel(dualLevel: string | null | undefined, planYear?: number | null) {
  if (!dualLevel) return null;
  const table = lisDrugCopayTable(planYear);
  if (LIS_FULL_BENEFIT_LEVELS.has(dualLevel)) return table.FULL_BENEFIT;
  if (LIS_NON_FULL_BENEFIT_LEVELS.has(dualLevel)) return table.NON_FULL;
  return null;
}

// Standard Part D tier -> drug type (same mapping every year; planYear picks the copay schedule, default 2026). T1-2 generic; T3-5 brand/specialty (LIS = flat copay,
// no coinsurance below catastrophic); T6 select-care/vaccines = $0. Returns dollars or null.
export function lisCopayForTier(tierNum: number, dualLevel: string | null | undefined, planYear?: number | null): number | null {
  const s = lisScheduleForLevel(dualLevel, planYear);
  if (!s) return null;
  if (tierNum === 6) return 0;
  if (tierNum <= 2) return s.generic;
  return s.brand;
}
