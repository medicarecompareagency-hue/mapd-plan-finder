// Dale's contracted carrier allowlist — only pull plans from these carriers.
// Stored as CMS `organizationName` strings EXACTLY as they appear in the Plan
// table (case-sensitive). Applied as a hard filter in /api/plans (both GET
// for results and POST for dropdown options).
//
// HealthSpring brand history:
//   - Pre-2019: HealthSpring (independent carrier)
//   - 2019: rebranded to Cigna
//   - 2026: rebranded back to HealthSpring (official per Dale)
//   CMS PBP data lags rebrand events by ~1 year. As of 2026-05-06 the 2026
//   PBP zip still publishes the carrier under "Cigna" or "Cigna Healthcare"
//   in some files. We allow all three spellings here and normalize the DB
//   to "HealthSpring" via scripts/normalize-healthspring-name.js.
//
// Coverage mapping (what Dale said → CMS org name(s)):
//   HealthSpring (current)   → HealthSpring / Cigna / Cigna Healthcare
//   UnitedHealthCare / AARP  → UnitedHealthcare
//   WellCare                 → Wellcare       (Allwell + sub-brands excluded)
//   Aetna                    → Aetna Medicare (FIDE excluded)
//   Humana                   → Humana
//   Devoted                  → Devoted Health
//
// Last updated: 2026-05-06.

export const LICENSED_CARRIERS = [
  "HealthSpring",
  "Cigna",
  "Cigna Healthcare",
  "UnitedHealthcare",
  "Wellcare",
  "Aetna Medicare",
  "Humana",
  "Devoted Health",
] as const;

export type LicensedCarrier = (typeof LICENSED_CARRIERS)[number];
