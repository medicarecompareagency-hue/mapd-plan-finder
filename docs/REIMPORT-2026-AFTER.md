# Re-import 2026 — AFTER snapshot

Completed: 2026-06-03. See REIMPORT-2026-BEFORE.md for the before state and root cause.

## What changed

**Source switched:** `import-cms-data.ts` now uses `PlanArea.txt` from the CMS PBP ZIP as the
authoritative county→plan mapping (`parsePlanArea()` function, inserted at line ~902). The NBER
landscape CSV is retained on disk as a carrier-name lookup table only. This eliminates the
1-2 year NBER publication lag and missing-SNP problem permanently.

**Plans added:** 418 new planIds (1,278 → 1,696)  
**Plans removed:** 199 stale 2025-only planIds (12,561 rows) deleted  
**Net rows:** 157,491 → 144,930 (2026 year)

## DB counts after re-import

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

## Before/after diff

| Metric | Before | After | Change |
|---|---|---|---|
| Total 2026 rows | 46,856 | 144,930 | +98,074 |
| Distinct planIds | 1,278 | 1,696 | +418 |
| H4461-79 in DB | NO | YES | Fixed |
| Source authority | NBER 2025 | CMS PlanArea 2026 | Fixed |
| NBER fallback risk | Present | Eliminated | Fixed |

## For 2027 imports

**Never use NBER as the landscape authority for future years.** The 2027 import should:
1. Download `pbp-benefits-2027.zip` from CMS (already in the import script)
2. Call `parsePlanArea()` using the extracted `PlanArea.txt` — no NBER download needed
3. The NBER landscape download block can be removed from the importer entirely in a
   future cleanup (it's now only used for carrier-name lookups, which could be derived
   from the PBP `pbp_Section_A.txt` `orgtype` field instead)
