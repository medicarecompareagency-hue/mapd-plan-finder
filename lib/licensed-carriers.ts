// Dale's contracted carrier allowlist — only pull plans from these carriers.
// Stored as CMS `organizationName` strings EXACTLY as they appear in the Plan
// table (case-sensitive). Applied as a hard filter in /api/plans (both GET
// for results and POST for dropdown options).
//
// Coverage mapping (what Dale said → CMS org name):
//   HealthSpring            → Cigna        (HealthSpring was rebranded to Cigna in 2019)
//   UnitedHealthCare / AARP → UnitedHealthcare  (AARP Medicare Advantage is a UHC brand)
//   WellCare                → Wellcare     (Dale opted to drop standalone Ascension Complete)
//   Aetna                   → Aetna Medicare
//   Humana                  → Humana
//   Devoted                 → Devoted Health
//
// Last updated: 2026-04-23.

export const LICENSED_CARRIERS = [
  "Cigna",
  "UnitedHealthcare",
  "Wellcare",
  "Aetna Medicare",
  "Humana",
  "Devoted Health",
] as const;

export type LicensedCarrier = (typeof LICENSED_CARRIERS)[number];
