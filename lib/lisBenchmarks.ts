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

// 2027 LIS / Extra Help regional benchmark amounts ($/month), same 18 states.
// Source: CMS "Regional Rates and Benchmarks 2027" (regional-rates-and-benchmarks-2027.pdf,
// table "2027 Low Income Premium Subsidy Amounts", released with the July 28, 2026 announcement).
// Same 34 PDP regions as 2026; the 2026 table above was re-checked against CMS's 2026 file on 2026-10-05.
export const LIS_BENCHMARKS_2027: Record<string, number> = {
  AL: 13.65,
  AR:  6.28,
  FL:  7.28,
  GA:  6.29,
  IL:  7.61,
  IN: 17.02,
  KS: 35.48,
  KY: 17.02,
  LA: 17.03,
  MO: 18.38,
  MS:  6.28,
  OH: 21.05,
  OK: 11.03,
  SC:  7.28,
  TN: 13.65,
  TX:  6.27,
  VA:  6.28,
  WV: 12.80,
};

// Benchmark table per plan year. A plan year with no table yet falls back to 2026.
export const LIS_BENCHMARKS_BY_YEAR: Record<number, Record<string, number>> = {
  2026: LIS_BENCHMARKS_2026,
  2027: LIS_BENCHMARKS_2027,
};

export type LisLevel = "FULL" | "75" | "50" | "25";

export const LIS_SUBSIDY_PCT: Record<LisLevel, number> = {
  FULL: 1.00,
  "75": 0.75,
  "50": 0.50,
  "25": 0.25,
};

// Compute the member's total adjusted premium under a given LIS level.
// planYear picks the benchmark table (the plan row's own year), default 2026.
// partC and partD are in $/month; result is $/month floored at partC.
export function lisAdjustedPremium(
  partC: number,
  partD: number,
  state: string,
  lisLevel: LisLevel | null,
  planYear: number | null = 2026,
): number {
  if (!lisLevel || partD === 0) return partC + partD;
  const table = LIS_BENCHMARKS_BY_YEAR[planYear ?? 2026] ?? LIS_BENCHMARKS_2026;
  const benchmark = table[state] ?? 0;
  const subsidy = LIS_SUBSIDY_PCT[lisLevel] * benchmark;
  return partC + Math.max(0, partD - subsidy);
}
