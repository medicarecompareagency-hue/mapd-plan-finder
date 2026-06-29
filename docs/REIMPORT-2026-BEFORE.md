# Re-import 2026 — BEFORE snapshot

Captured: 2026-06-02, before switching from NBER landscape to CMS-direct PlanArea.txt.

## Root cause of re-import

`ma2026.csv` was byte-for-byte identical to `ma2025.csv` (same MD5). NBER had not published
2026 data when the original import ran; the importer silently fell back to 2025 data.
Audit against CMS-direct PlanArea.txt showed ~1,077 enrollable 2026 MAPD plan IDs missing
and ~256 stale 2025-only plans in the DB.

## DB counts before re-import

**Total 2026 plans:** 46,856

### By planCategory

| Category | Rows |
|---|---|
| DSNP | 17,582 |
| MAPD | 15,776 |
| MA_ONLY | 6,957 |
| CSNP | 5,022 |
| ISNP | 1,519 |

### By state

| State | Rows |
|---|---|
| AL | 1,825 |
| AR | 2,264 |
| FL | 2,232 |
| GA | 6,341 |
| IL | 1,505 |
| IN | 2,159 |
| KS | 1,157 |
| KY | 4,260 |
| LA | 1,484 |
| MO | 3,156 |
| MS | 2,885 |
| OH | 3,221 |
| OK | 1,253 |
| SC | 1,510 |
| TN | 2,572 |
| TX | 4,835 |
| VA | 2,998 |
| WV | 1,199 |

### By carrier

| Carrier | Rows |
|---|---|
| Humana | 18,024 |
| UnitedHealthcare | 12,291 |
| Aetna Medicare | 6,357 |
| Wellcare | 5,842 |
| Devoted Health | 2,883 |
| HealthSpring | 869 |
| Cigna Healthcare | 590 |

**Distinct planIds:** 1,278

## CMS-direct baseline (from prior audit)

- CMS PlanArea.txt licensed-carrier unique planIds: 2,135
- Missing from DB (in CMS, not DB): 1,077 planIds / 470,537 county rows
- Extra in DB (not in CMS 2026): 256 planIds

## Notable gap

H4461-79 (Humana MAPD HMO, $0 premium under Full LIS, served 67 AL counties)
was missing entirely from the DB — it exposed the NBER fallback issue.

## After target

~2,135 unique planIds, all 2026 CMS-approved plans for licensed carriers + states.

---

## Round 2 BEFORE snapshot (2026-06-29, before backfill run)

After the June 3 re-import, H1889-9 (UHC Dual Complete AL-D002, PPO D-SNP) was still absent.
Root cause: H1889 contract absent from NBER 2025 CSV → `parsePlanArea()` returned `orgName=""` for
H1889 rows → licensed-carriers gate dropped them.

Fix: added `sectionAPath` parameter to `parsePlanArea()` in `import-cms-data.ts`; builds a fallback
contract→marketingName map from `pbp_Section_A.txt` so contracts absent from NBER get their
carrier name from Section A. Also ran `backfill-missing-plans.ts 2026` to add 9,935 missing
DSNP/CSNP/ISNP/MA_ONLY plans non-destructively.

**Total rows (all 2026) before Round 2 backfill:** 48,894

| Category | Rows |
|---|---|
| DSNP | 9,621 |
| MAPD | 26,723 |
| MA_ONLY | 7,837 |
| CSNP | 3,428 |
| ISNP | 1,285 |
