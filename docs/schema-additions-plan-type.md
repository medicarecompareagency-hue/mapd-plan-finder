# Schema additions — Plan Type expansion (backlog item #1)

**Status:** Proposed, not yet applied.
**Goal:** Surface the full CMS plan-type taxonomy in the filter UI (MA-only, MAPD, PDP, DSNP, CSNP, ISNP, MSA, PACE, Cost), plus CSNP-by-condition and ISNP subtype.

Data source for every new field is `pbp_Section_A.txt` — already downloaded under `.cms-import-tmp/`. No new external data required for this backlog item (items #2 and #3 will need additional files).

---

## Guiding principles

1. **Additive-only.** We don't touch `Plan.planType` — it stays as the free-text contract form (`HMO`, `Local PPO`, etc.) so existing queries and the rendered "Type" column in the results table keep working. New fields layer alongside.
2. **Enums, not strings**, for every value with a bounded vocabulary — so filter dropdowns can be built from the enum definition instead of a `SELECT DISTINCT` scan over 186k rows.
3. **Nullable by default**, because the existing 186k rows will be `NULL` for every new column until a re-import populates them. The UI treats `NULL` as "unknown — show anyway".
4. **One migration per backlog item.** This proposal is plan-type-only. LIS (#2) and Medicaid (#3) get their own migrations.

---

## Proposed Prisma schema changes

Add to `prisma/schema.prisma`:

```prisma
// ------------------------------------------------------------
// PLAN TYPE TAXONOMY - added 2026-04-21 for backlog item #1
// ------------------------------------------------------------
enum PlanCategory {
  MA_ONLY   // Medicare Advantage without drug coverage
  MAPD      // Medicare Advantage + Part D
  PDP       // Standalone Prescription Drug Plan
  DSNP      // Dual-Eligible Special Needs Plan
  CSNP      // Chronic Condition Special Needs Plan
  ISNP      // Institutional Special Needs Plan
  MSA       // Medical Savings Account
  PACE      // Program of All-Inclusive Care for the Elderly
  COST      // 1876 Cost plan / HCPP
  MMP       // Medicare-Medicaid Plan (demonstration, sunset after 2025)
  OTHER
}

enum SnpSubtype {
  // ISNP subtypes (from pbp_a_snp_institutional_type)
  ISNP_FACILITY     // FI-SNP — nursing home residents
  ISNP_EQUIVALENT   // IE-SNP — community, nursing-home level of care
  ISNP_HYBRID       // HI-SNP — both populations
  // DSNP Medicaid-tier subtypes (populated later in backlog item #3;
  // added now so the enum is stable and we don't migrate twice)
  DSNP_FBDE         // Full-Benefit Dual Eligible
  DSNP_QMB_PLUS     // Qualified Medicare Beneficiary + full Medicaid
  DSNP_QMB          // QMB only
  DSNP_SLMB_PLUS    // Specified Low-Income Medicare Beneficiary + full Medicaid
  DSNP_SLMB         // SLMB only
  DSNP_QI           // Qualifying Individual
  DSNP_MEDICAID_ONLY  // Full Medicaid, not an MSP tier
}

enum ChronicCondition {
  ALCOHOL_SUD
  AUTOIMMUNE
  CANCER
  CARDIOVASCULAR
  CHRONIC_HEART_FAILURE
  DEMENTIA
  DIABETES
  GASTROINTESTINAL
  CHRONIC_KIDNEY_DISEASE
  HEMATOLOGIC
  HIV_AIDS
  LUNG_DISORDERS
  MENTAL_HEALTH
  NEUROLOGIC
  STROKE
  CHF_AND_CVD
  DIABETES_AND_CVD
  CHF_AND_DIABETES
  DIABETES_CHF_CVD
  STROKE_AND_CVD
  METABOLIC_SYNDROME
  POST_TRANSPLANT
  IMMUNODEFICIENCY
  COGNITIVE_IMPAIRMENT
  FUNCTIONAL_CHALLENGES
  SENSORY_IMPAIRMENT
  THERAPY_MAINTENANCE
  ANXIETY_WITH_COPD
  CKD_AND_TRANSPLANT
  SUD_AND_MH
  OTHER_1
  OTHER_2
  OTHER_3
}
```

And on `model Plan`:

```prisma
  // --- New fields (plan-type expansion) ---
  planCategory       PlanCategory?
  snpSubtype         SnpSubtype?
  chronicConditions  ChronicCondition[]   @default([])
  hasPartD           Boolean?             // from pbp_a_contract_partd_flag
  isZeroDollarDsnp   Boolean?             // from pbp_a_dsnp_zerodollar
  cmsContractType    String?              // raw pbp_a_plan_type code decoded (e.g. "HMO", "Local PPO")
                                           // kept separate from the legacy planType string

  @@index([planCategory])
  @@index([state, county, planCategory])   // powers the filtered-dropdown query path
```

---

## Migration SQL (what Prisma will generate)

Prisma will emit roughly this when you run `npx prisma migrate dev --name add_plan_category`:

```sql
-- Enums
CREATE TYPE "PlanCategory" AS ENUM (
  'MA_ONLY','MAPD','PDP','DSNP','CSNP','ISNP','MSA','PACE','COST','MMP','OTHER');
CREATE TYPE "SnpSubtype" AS ENUM (
  'ISNP_FACILITY','ISNP_EQUIVALENT','ISNP_HYBRID',
  'DSNP_FBDE','DSNP_QMB_PLUS','DSNP_QMB','DSNP_SLMB_PLUS','DSNP_SLMB','DSNP_QI','DSNP_MEDICAID_ONLY');
CREATE TYPE "ChronicCondition" AS ENUM (
  'ALCOHOL_SUD','AUTOIMMUNE','CANCER','CARDIOVASCULAR','CHRONIC_HEART_FAILURE',
  'DEMENTIA','DIABETES','GASTROINTESTINAL','CHRONIC_KIDNEY_DISEASE','HEMATOLOGIC',
  'HIV_AIDS','LUNG_DISORDERS','MENTAL_HEALTH','NEUROLOGIC','STROKE',
  'CHF_AND_CVD','DIABETES_AND_CVD','CHF_AND_DIABETES','DIABETES_CHF_CVD','STROKE_AND_CVD',
  'METABOLIC_SYNDROME','POST_TRANSPLANT','IMMUNODEFICIENCY','COGNITIVE_IMPAIRMENT',
  'FUNCTIONAL_CHALLENGES','SENSORY_IMPAIRMENT','THERAPY_MAINTENANCE','ANXIETY_WITH_COPD',
  'CKD_AND_TRANSPLANT','SUD_AND_MH','OTHER_1','OTHER_2','OTHER_3');

-- Columns
ALTER TABLE "Plan"
  ADD COLUMN "planCategory"      "PlanCategory",
  ADD COLUMN "snpSubtype"        "SnpSubtype",
  ADD COLUMN "chronicConditions" "ChronicCondition"[] NOT NULL DEFAULT ARRAY[]::"ChronicCondition"[],
  ADD COLUMN "hasPartD"          BOOLEAN,
  ADD COLUMN "isZeroDollarDsnp"  BOOLEAN,
  ADD COLUMN "cmsContractType"   TEXT;

-- Indexes
CREATE INDEX "Plan_planCategory_idx" ON "Plan"("planCategory");
CREATE INDEX "Plan_state_county_planCategory_idx" ON "Plan"("state","county","planCategory");
```

Fully additive. All six new columns are nullable (or have a default empty array), so the migration runs without touching existing row data and no backfill lock is required.

---

## After migration — re-import populates the new columns

Backlog item #4 (update `scripts/import-cms-data.ts`) will:
- read `pbp_Section_A.txt` into a new Section-A-benefit-map
- merge per `planKey = hnumber-plan_identifier-segment_id` into the benefit map
- derive `planCategory`, `snpSubtype`, `chronicConditions`, `hasPartD`, `isZeroDollarDsnp`, `cmsContractType` using the rules in `docs/plan-type-catalog.md`
- upsert into the same row the landscape CSV created

Existing rows will pick up the new values on the next full re-import. We can either:
- **Re-import both years** (fastest to get complete data, ~5 min per year based on the current import time)
- **Only re-import 2026** first to verify the mapping is right, then re-import 2025

---

## Apply checklist

1. Dale reviews this doc and approves.
2. Claude edits `prisma/schema.prisma` with the additions above.
3. Dale runs (from `c:\Users\dbuir\mapd-plan-finder`):
   ```
   npx prisma migrate dev --name add_plan_category
   ```
   This uses `DIRECT_URL` (:5432) automatically — per `prisma.config.ts` / env vars.
4. Dale commits the generated migration folder + updated schema.
5. Claude edits `scripts/import-cms-data.ts` to populate the new fields (item #4).
6. Dale runs a re-import locally to verify, then deploys.
