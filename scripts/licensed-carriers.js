// Canonical licensed-carrier allowlist for all import/backfill/acquire scripts.
// CMS organizationName values, case-sensitive, exactly as stored in the Plan table.
// Source of truth: lib/licensed-carriers.ts (same list, TypeScript version for app code).
// Last verified: 2026-06-04.

const LICENSED_CARRIERS = [
  "HealthSpring",      // 2026 rebrand back from Cigna; CMS data lags ~1 year
  "Cigna",             // pre-2026 CMS spelling (HealthSpring rebrand lag)
  "Cigna Healthcare",  // 2019-era CMS spelling (HealthSpring rebrand lag)
  "UnitedHealthcare",  // includes AARP Medicare Advantage (UHC brand)
  "Wellcare",
  "Aetna Medicare",
  "Humana",
  "Devoted Health",
];

module.exports = { LICENSED_CARRIERS };
