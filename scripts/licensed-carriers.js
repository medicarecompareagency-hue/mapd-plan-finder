// Canonical licensed-carrier allowlist for all import/backfill/acquire scripts.
// CMS organizationName values, case-sensitive, exactly as stored in the Plan table.
// Source of truth: lib/licensed-carriers.ts (app-side; also includes Cigna/Cigna Healthcare
// for API filter safety, but those names have 0 plans in the 2026 DB — normalized to HealthSpring).
// Last verified: 2026-06-08 (DB query confirmed 6 distinct org names, no Cigna rows).

const LICENSED_CARRIERS = [
  "HealthSpring",      // 2026 rebrand; all Cigna/Cigna Healthcare rows normalized to this
  "UnitedHealthcare",  // includes AARP Medicare Advantage (UHC brand)
  "Wellcare",
  "Aetna Medicare",
  "Humana",
  "Devoted Health",
];

module.exports = { LICENSED_CARRIERS };
