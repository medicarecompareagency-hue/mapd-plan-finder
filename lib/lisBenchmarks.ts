// 2026 LIS / Extra Help regional benchmark amounts ($/month) for Dale's 18
// licensed states.  Source: CMS "2026 Low Income Premium Subsidy Amounts."
// Most of Dale's states are single-state PDP regions, so state → benchmark
// is a direct lookup with no county disambiguation needed.
export const LIS_BENCHMARKS_2026: Record<string, number> = {
  AL: 27.74,
  AR:  8.93,
  FL:  4.82,
  GA: 25.42,
  IL: 15.20,
  IN: 38.44,
  KS: 55.20,
  KY: 38.44,
  LA: 32.89,
  MO: 43.03,
  MS: 23.84,
  OH: 31.38,
  OK: 28.24,
  SC: 35.66,
  TN: 27.74,
  TX:  4.82,
  VA: 24.56,
  WV: 32.71,
};

export type LisLevel = "FULL" | "75" | "50" | "25";

export const LIS_SUBSIDY_PCT: Record<LisLevel, number> = {
  FULL: 1.00,
  "75": 0.75,
  "50": 0.50,
  "25": 0.25,
};

// Compute the member's total adjusted premium under a given LIS level.
// partC and partD are in $/month; result is $/month floored at partC.
export function lisAdjustedPremium(
  partC: number,
  partD: number,
  state: string,
  lisLevel: LisLevel | null,
): number {
  if (!lisLevel || partD === 0) return partC + partD;
  const benchmark = LIS_BENCHMARKS_2026[state] ?? 0;
  const subsidy = LIS_SUBSIDY_PCT[lisLevel] * benchmark;
  return partC + Math.max(0, partD - subsidy);
}
