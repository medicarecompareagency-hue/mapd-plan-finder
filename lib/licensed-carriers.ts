// Dale's contracted carrier allowlist — only pull plans from these carriers.
// Stored as CMS `organizationName` strings EXACTLY as they appear in the Plan
// table (case-sensitive). Applied as a hard filter in /api/plans (both GET
// for results and POST for dropdown options).
//
// Coverage mapping (what Dale said → CMS org name):
//   HealthSpring            → "Cigna Healthcare" (CMS 2026 hasn't relabeled yet)
//                              + "HealthSpring" (future-proof for re-imports)
//   Cigna (legacy)          → "Cigna" (kept for pre-2026 back-compat)
//   UnitedHealthCare / AARP → "UnitedHealthcare"
//   WellCare                → "Wellcare"
//   Aetna                   → "Aetna Medicare"
//   Humana                  → "Humana"
//   Devoted                 → "Devoted Health"
//
// Notes:
// - Cigna sold their MAPD division to HealthSpring effective 2026. CMS data
//   for 2026 still lists those plans under organizationName "Cigna Healthcare"
//   even though the actual products are HealthSpring's (verified 2026-04-27
//   by inspecting H5410 plans — names start with "HealthSpring TotalCare").
//   Once CMS updates the org name, the "HealthSpring" entry below will catch
//   them. Both stay in the list to cover both states of the data.
// - "Cigna" remains for any 2025 or earlier plan years still in the DB.
//
// Last updated: 2026-04-27 (Phase 1.1).

export const LICENSED_CARRIERS = [
  "Cigna",
  "Cigna Healthcare",
  "HealthSpring",
  "UnitedHealthcare",
  "Wellcare",
  "Aetna Medicare",
  "Humana",
  "Devoted Health",
] as const;

export type LicensedCarrier = (typeof LICENSED_CARRIERS)[number];
