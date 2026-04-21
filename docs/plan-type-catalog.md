# CMS Plan-Type & SNP Code Catalog

Source: `PBP_Benefits_2026_dictionary.xlsx` (CMS) and `pbp_Section_A.txt` for plan years 2025 + 2026.
This is the reference used by the import script to map raw CMS codes into our canonical enums.

---

## 1. `pbp_a_plan_type` — contract type (HMO / PPO / PFFS / etc.)

This is the *contract form* of the plan (HMO vs PPO vs PFFS), not the MAPD-vs-DSNP-vs-CSNP category.
Maps to our `ContractType` enum.

| Code | CMS Label | Our enum | 2026 plans | 2025 plans |
| :--: | --- | --- | --: | --: |
| 01 | HMO | `HMO` | 3,056 | 2,876 |
| 02 | HMOPOS | `HMO_POS` | 1,302 | 1,426 |
| 04 | Local PPO | `PPO_LOCAL` | 2,502 | 2,702 |
| 05 | PSO (State License) | `PSO` | 0 | 0 |
| 07 | MSA | `MSA` | 19 | 16 |
| 08 | RFB PFFS | `PFFS` | 0 | 0 |
| 09 | PFFS | `PFFS` | 26 | 24 |
| 18 | 1876 Cost | `COST_1876` | 45 | 53 |
| 19 | HCPP - 1833 Cost | `HCPP_1833` | 0 | 0 |
| 20 | National PACE | `PACE` | 396 | 366 |
| 29 | Medicare Prescription Drug Plan (PDP) | `PDP` | 659 | 756 |
| 30 | Employer/Union Direct Contract PDP | `PDP` | 2 | 2 |
| 31 | Regional PPO | `PPO_REGIONAL` | 74 | 79 |
| 32 | Fallback | `OTHER` | 0 | 0 |
| 40 | Employer/Union Direct Contract PFFS | `PFFS` | 0 | 0 |
| 42 | RFB HMO | `HMO` | 0 | 0 |
| 43 | RFB HMOPOS | `HMO_POS` | 0 | 0 |
| 44 | RFB Local PPO | `PPO_LOCAL` | 0 | 0 |
| 45 | RFB PSO (State License) | `PSO` | 0 | 0 |
| 47 | Employer Direct PPO | `PPO_LOCAL` | 0 | 0 |
| 48 | Medicare-Medicaid Plan (MMP) | `MMP` | 0 | 28 |

(2025 had 28 MMP plans, 2026 has none — the MMP demonstration sunset at end of 2025.)

---

## 2. `pbp_a_special_need_flag` — is this a SNP?

| Code | Meaning | 2026 plans |
| :--: | --- | --: |
| 1 | Yes (SNP) | 1,803 |
| 2 | No | 6,278 |

---

## 3. `pbp_a_special_need_plan_type` — which kind of SNP

| Code | CMS Label | Our category | 2026 | 2025 |
| :--: | --- | --- | --: | --: |
| 1 | Institutional | `ISNP` | 156 | 165 |
| 3 | Dual-Eligible | `DSNP` | 1,085 | 955 |
| 4 | Chronic or Disabling Condition | `CSNP` | 562 | 391 |

(Code 2 is reserved/unused.)

---

## 4. `pbp_a_snp_institutional_type` — ISNP sub-type

Only set when `special_need_plan_type = 1` (ISNP).

| Code | CMS Label | Our enum | 2026 plans |
| :--: | --- | --- | --: |
| 1 | Facility-based Institutional SNP (FI-SNP) | `ISNP_FACILITY` | 61 |
| 2 | Institutional-equivalent SNP (IE-SNP) | `ISNP_EQUIVALENT` | 16 |
| 3 | Hybrid Institutional SNP (HI-SNP) | `ISNP_HYBRID` | 79 |

---

## 5. `pbp_a_dsnp_zerodollar` — zero-dollar premium DSNP flag

Only set when `special_need_plan_type = 3` (DSNP). Used for ranking/filtering "no-cost" DSNPs.

| Code | Meaning | 2026 plans |
| :--: | --- | --: |
| 1 | Yes — zero-dollar premium | 743 |
| 2 | No | 342 |
| (blank) | Not a DSNP | 6,996 |

---

## 6. `pbp_a_snp_cond` — CSNP chronic-condition bit-string

A 33-character (2026) / 23-character (2025) string of `0`s and `1`s. Each position 1-N
corresponds to a CMS-approved chronic condition. Multiple positions can be set.

### 2026 position → condition mapping

| Pos | CSNP condition | Our enum |
| :--: | --- | --- |
| 1 | Chronic alcohol use disorder and other SUDs | `ALCOHOL_SUD` |
| 2 | Autoimmune disorders | `AUTOIMMUNE` |
| 3 | Cancer | `CANCER` |
| 4 | Cardiovascular disorders | `CARDIOVASCULAR` |
| 5 | Chronic heart failure | `CHRONIC_HEART_FAILURE` |
| 6 | Dementia | `DEMENTIA` |
| 7 | Diabetes mellitus | `DIABETES` |
| 8 | Chronic Gastrointestinal Disease (CGD) | `GASTROINTESTINAL` |
| 9 | Chronic kidney disease (CKD) | `CHRONIC_KIDNEY_DISEASE` |
| 10 | Severe Hematologic Disorders | `HEMATOLOGIC` |
| 11 | HIV/AIDS | `HIV_AIDS` |
| 12 | Chronic lung disorders | `LUNG_DISORDERS` |
| 13 | Chronic and disabling mental health conditions | `MENTAL_HEALTH` |
| 14 | Neurologic disorders | `NEUROLOGIC` |
| 15 | Stroke | `STROKE` |
| 16 | Chronic Heart Failure + Cardiovascular Disorders | `CHF_AND_CVD` |
| 17 | Diabetes Mellitus + Cardiovascular Disorders | `DIABETES_AND_CVD` |
| 18 | Chronic Heart Failure + Diabetes | `CHF_AND_DIABETES` |
| 19 | Diabetes Mellitus + CHF + Cardiovascular Disorders | `DIABETES_CHF_CVD` |
| 20 | Stroke + Cardiovascular Disorders | `STROKE_AND_CVD` |
| 21 | Overweight, obesity, and metabolic syndrome | `METABOLIC_SYNDROME` |
| 22 | Post-organ Transplantation Care | `POST_TRANSPLANT` |
| 23 | Immunodeficiency and Immunosuppressive Disorders | `IMMUNODEFICIENCY` |
| 24 | Conditions associated with cognitive impairment | `COGNITIVE_IMPAIRMENT` |
| 25 | Conditions with functional challenges | `FUNCTIONAL_CHALLENGES` |
| 26 | Vision/hearing/taste/touch/smell impairments | `SENSORY_IMPAIRMENT` |
| 27 | Continued therapy for maintenance of function | `THERAPY_MAINTENANCE` |
| 28 | Anxiety associated with COPD | `ANXIETY_WITH_COPD` |
| 29 | CKD + Post-(renal) Organ Transplantation | `CKD_AND_TRANSPLANT` |
| 30 | SUDs + Chronic Mental Health Disorders | `SUD_AND_MH` |
| 31 | Other 1 | `OTHER_1` |
| 32 | Other 2 | `OTHER_2` |
| 33 | Other 3 | `OTHER_3` |

**2026 distribution (most common CSNP conditions):**
- Position 19 — Diabetes + CHF + CVD (the modern "diabetes" CSNP bucket): **477 plans**
- Position 9 — Chronic kidney disease: 34
- Position 12 — Chronic lung disorders: 31
- Position 17 — Diabetes + CVD: 5
- Mixed alcohol/cancer/cardiovascular bundle: 4

### 2025 position offset note
The 2025 bit-string is 23 characters, not 33 — positions 24–33 (newer compound conditions and SUD/MH bundles) didn't exist yet. Positions 1–23 share the same meaning across years, so import code can decode by year.

---

## 7. `pbp_a_contract_partd_flag` — does this contract have Part D

| Code | Meaning | 2026 |
| :--: | --- | --: |
| 1 | Yes (MAPD or PDP) | 8,046 |
| 2 | No (MA-only) | 35 |

---

## Derived `PlanCategory` resolution rules

Given the seven raw fields above, the import script derives a single canonical `PlanCategory`:

```
if special_need_flag == "1":
    if special_need_plan_type == "3": planCategory = DSNP
    elif special_need_plan_type == "4": planCategory = CSNP
    elif special_need_plan_type == "1": planCategory = ISNP
elif plan_type in ("29", "30"):       planCategory = PDP
elif plan_type in ("18", "19"):       planCategory = COST
elif plan_type == "20":               planCategory = PACE
elif plan_type == "07":               planCategory = MSA
elif contract_partd_flag == "1":      planCategory = MAPD
else:                                 planCategory = MA_ONLY
```

`hasPartD = (contract_partd_flag == "1")`
`isZeroDollarDsnp = (dsnp_zerodollar == "1")`
`snpSubtype` (when ISNP) = mapped from `snp_institutional_type`
`chronicConditions[]` (when CSNP) = decoded from `snp_cond` bit string

---

## Known gaps for items 2 & 3 (LIS / Medicaid)

DSNP **Medicaid level** sub-types (FBDE / QMB+ / QMB / SLMB+ / SLMB / QI / Medicaid-only)
are NOT in the PBP files. They live in the CMS DSNP State Medicaid Agency Contracts (SMAC)
crosswalk, which is published per state and contract. That's the data source for backlog item #3.

LIS tier eligibility is similarly external — derived from the CMS PDP Region/Benchmark file,
not PBP. That's the data source for backlog item #2.
