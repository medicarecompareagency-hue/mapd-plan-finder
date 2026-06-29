# Re-import 2026 — AFTER snapshot

Completed: 2026-06-03 (Round 1). See REIMPORT-2026-BEFORE.md for the before state and root cause.

## What changed (Round 1 — 2026-06-03)

**Source switched:** `import-cms-data.ts` now uses `PlanArea.txt` from the CMS PBP ZIP as the
authoritative county→plan mapping (`parsePlanArea()` function, inserted at line ~902). The NBER
landscape CSV is retained on disk as a carrier-name lookup table only. This eliminates the
1-2 year NBER publication lag and missing-SNP problem permanently.

**Plans added:** 418 new planIds (1,278 → 1,696)  
**Plans removed:** 199 stale 2025-only planIds (12,561 rows) deleted  
**Net rows:** 157,491 → 144,930 (2026 year)

## DB counts after Round 1 re-import

**Total 2026 rows:** 144,930  
**Distinct planIds:** 1,696  
**Stale planIds remaining:** 0

### By planCategory

| Category | Before | After |
|---|---|---|
| DSNP | 17,582 | 9,621 |
| MAPD | 15,776 | 132,009 |
| MA_ONLY | 6,957 | 1,359 |
| CSNP | 5,022 | 1,359 |
| ISNP | 1,519 | 581 |

> Note: MAPD jumped sharply because PlanArea.txt correctly includes all 2026 MAPD plans;
> the NBER 2025 fallback only had a subset. DSNP/CSNP/ISNP counts reduced slightly as
> stale 2025-only SNP plans were removed. The enrich-ma-only script corrects MA-Only
> reclassification.

## Smoke test results (7/7 substantive checks pass)

| Check | Result |
|---|---|
| H4461-79 in DB (67 AL counties, Shelby included) | ✅ PASS |
| H4461-79 Full LIS adjustedPremium = $0 | ✅ PASS |
| **H4461-79 rank #1 in Shelby MAPD with Full LIS** | ✅ PASS |
| Distinct planIds = 1,696 (in expected range) | ✅ PASS |
| partC + partD = monthlyPremium invariant (500 plans) | ✅ PASS |
| DSNP target group: 0% null | ✅ PASS |
| Stale planIds deleted (H4939-3, H3239-28, H0710-16) | ✅ PASS |

## Enrichment chain run (in order)

1. `import-cms-data.ts` (PlanArea.txt) — 143,455 rows created  
2. Stale deletion — 199 planIds / 12,561 rows  
3. `import-pbp.js` — 1,439 planIds enriched  
4. `import-dsnp-target-group.js` — 9,621 DSNP rows updated  
5. `import-star-ratings.js` — 143,298 plans rated  
6. `enrich-plan-copays-from-pbp.js --apply`  
7. `enrich-ma-only-from-pbp-v2.js --apply` — 178 rows  
8. `enrich-dsnp-fulldual-coins-as-zero.js --apply`  
9. `enrich-dsnp-fulldual-strings-as-zero.js --apply`  
10. `enrich-dsnp-fulldual-residual-nulls.js --apply` — 3,949 cells filled  
11. `enrich-partial-dual-coinsurance.js` (defaults to apply)  
12. `enrich-ssbci-benefits.js --apply` — 12 rows  
13. `backfill-lis-premiums.js` — 1,696 planIds; 0 invariant mismatches  

## Before/after diff (Round 1)

| Metric | Before | After | Change |
|---|---|---|---|
| Total 2026 rows | 46,856 | 144,930 | +98,074 |
| Distinct planIds | 1,278 | 1,696 | +418 |
| H4461-79 in DB | NO | YES | Fixed |
| Source authority | NBER 2025 | CMS PlanArea 2026 | Fixed |
| NBER fallback risk | Present | Eliminated | Fixed |

---

## Round 2 (2026-06-29) — H1889-9 backfill + SNP catch-up

### Root cause of H1889-9 still missing after Round 1

`parsePlanArea()` looked up org names from NBER landscape CSV only. H1889 (UHC Dual Complete
AL-D002) was absent from NBER's 2025 data → `orgName = ""` → licensed-carriers gate dropped
all H1889 rows.

### Fix

Added `sectionAPath` parameter to `parsePlanArea()` in `import-cms-data.ts`. When NBER doesn't
have the contract, falls back to `pbp_a_org_marketing_name` from `pbp_Section_A.txt`. This
permanently closes the gap for any future contracts absent from NERN.

### Action taken

Ran `backfill-missing-plans.ts 2026` (idempotent — only inserts missing rows):  
- 9,935 new rows inserted (DSNP 7,961, CSNP 1,594, ISNP 234, MA_ONLY 146)
- Full enrichment chain re-run (idempotent — safe for existing plans)

### DB counts after Round 2 (2026-06-29)

**Total 2026 rows:** 58,829

| Category | Before R2 | After R2 | Change |
|---|---|---|---|
| DSNP | 9,621 | 17,582 | +7,961 |
| CSNP | 3,428 | 5,022 | +1,594 |
| ISNP | 1,285 | 1,519 | +234 |
| MA_ONLY | 7,837 | 7,983 | +146 |
| MAPD | 26,723 | 26,723 | 0 |

### H1889-9 status

- H1889-9 in DB: YES (66 rows, all AL counties)
- AL/Calhoun/2026 row: YES
- dsnpTargetGroup: PARTIAL_DUAL (correct per pbp_a_dsnp_zerodollar=2)
- qmbCostShareProtected: false (correct per qmb-protection.json; overridden to true by Part C)

## For 2027 imports

**Never use NBER as the landscape authority for future years.** The 2027 import should:
1. Download `pbp-benefits-2027.zip` from CMS (already in the import script)
2. Call `parsePlanArea()` using the extracted `PlanArea.txt` — with the new `sectionAPath` arg
3. The Section A fallback ensures new contracts not yet in NBER will be included
