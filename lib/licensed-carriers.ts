// Dale's contracted carrier allowlist — only pull plans from these carriers.
// Stored as CMS `organizationName` strings EXACTLY as they appear in the Plan
// table (case-sensitive). Applied as a hard filter in /api/plans (both GET
// for results and POST for dropdown options).
//
// Coverage mapping (what Dale said → CMS org name):
//   HealthSpring            → Cigna / Cigna Healthcare  (HealthSpring rebranded
//                              to Cigna in 2019; CMS now uses both spellings.
//                              "Cigna Healthcare" added 2026-05-06 to capture
//                              ~756 rows that were silently filtered before.)
//   UnitedHealthCare / AARP → UnitedHealthcare  (AARP Medicare Advantage is a UHC brand)
//   WellCare                → Wellcare     (Dale opted to drop Allwell + all
//                              other Wellcare sub-brands on 2026-05-06)
//   Aetna                   → Aetna Medicare  (Aetna Medicare FIDE excluded
//                              per Dale 2026-05-06)
//   Humana                  → Humana
//   Devoted                 → Devoted Health
//
// Last updated: 2026-05-06.

export const LICENSED_CARRIERS = [
  "Cigna",
  "Cigna Healthcare",
  "UnitedHealthcare",
  "Wellcare",
  "Aetna Medicare",
  "Humana",
  "Devoted Health",
] as const;

export type LicensedCarrier = (typeof LICENSED_CARRIERS)[number];
