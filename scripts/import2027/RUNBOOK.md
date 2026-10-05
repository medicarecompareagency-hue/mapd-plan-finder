# 2027 import runbook (as run 2026-10-02)

Everything here is scoped to `planYear = 2027`. 2026 rows were checksummed before and after and did not change.
Run from the repo root. Scripts in this folder are standalone (`node scripts/import2027/<name>.js`).

**If CMS refreshes the 2027 PBP ZIP and you re-import, every step below must be re-run in this order,**
then the SB steps (apply links, `reapply-sb-truth.js`, QMB classifier).

## Result

68,711 rows · 1,921 plan IDs · 2,034 plan-segments · 18 states · 6 carriers.
Matches the CMS CY2027 landscape exactly (plan IDs, county counts, categories, contract types, premiums, MOOP, drug deductible).

| Category | Rows | Plan IDs |
|---|---|---|
| MAPD | 30,474 | 1,079 |
| DSNP | 17,941 | 394 |
| MA_ONLY | 10,343 | 121 |
| CSNP | 7,457 | 295 |
| ISNP | 2,496 | 32 |

## Order

1. **Prep** (`.cms-import-tmp/`): download + unzip `pbp-benefits-2027.zip` to `pbp-2027/`; unzip the CY2027 landscape to `cy2027-landscape/`;
   `node scripts/import2027/mk-ma2027.js` builds `ma2027.csv` (carrier + plan names from the CMS landscape, NOT NBER).
2. **Base import:** `npx tsx scripts/import-cms-data.ts --year 2027 --dry-run`, then without `--dry-run`. Expect 63,656 rows.
   `node scripts/import2027/recon.js` and `verify.js` reconcile against the landscape.
3. **Regional PPOs** (33 plans, 5,055 rows; not in PlanArea.txt): `python3 scripts/import2027/build-regional-planarea.py <file>`,
   then run the importer with that file as its PlanArea input and deletes disabled (rows don't exist yet). On 10-02 this was a
   patched copy of the importer (`planAreaPath` from env, fast path forced). The importer has no flag for this yet.
4. `PBP_DIR=.cms-import-tmp/pbp-2027 PBP_YEAR=2027 node scripts/import-pbp.js`
5. `node scripts/import2027/dsnp-tg-set.js` — same logic as `import-dsnp-target-group.js`, one UPDATE instead of 949.
6. `node scripts/enrich-plan-copays-from-pbp.js --year 2027 --apply` (fill-only)
7. `reclassify-ma-only-from-mrx.js` — **hard-coded `PLAN_YEAR = 2026`**; run with the constant changed to 2027. Result must equal the landscape "MA" count (10,343 rows).
8. `rederive-ambulance-pcp-copay.js` — **hard-coded 2026**, same treatment. REQUIRED: without it 442 plans show a $0 ambulance copay (the range minimum).
   It also nulls the DSNP full-dual $0s, so it must run BEFORE step 10.
9. `fill-hospital-nulls.js` — **hard-coded 2026**, same treatment.
10. `enrich-dsnp-fulldual-coins-as-zero.js`, `...-strings-as-zero.js`, `...-residual-nulls.js` — each `--year 2027 --apply`.
11. `node scripts/enrich-partial-dual-coinsurance.js --year 2027`
12. `node scripts/enrich-ssbci-benefits.js --year 2027 --apply`
13. `node scripts/backfill-segment-ids.js 2027`
14. `node scripts/import2027/premiums2027.js --apply` — replaces `backfill-lis-premiums.js` for 2027. Same derivation, but per plan-SEGMENT
    (12 segmented plans have different premiums per segment; the old script took the first row) and it does not use the 2026 checkpoint file.
15. `node scripts/import2027/ded-fix.js --apply` — Defined Standard plans file no "alt" deductible, so the importer leaves $0; sets the landscape value ($700 in 2027).
16. `node scripts/import2027/plantype-fix.js --apply` — only needed for rows imported before the importer's contract-type map was fixed.
17. `derive-hospital-fullstay.js` — **hard-coded 2026**, same treatment. Re-run after any SB string fixes.
18. QA: `node scripts/import2027/qa-landscape.js` (drug deductible + MOOP vs landscape, 2026 checksum) and `fill-by-cat.js` (filled % by category, 2026 vs 2027).

## Deliberately NOT run

- `enrich-ma-only-from-pbp-v2.js` — overwrites (not fill-only) and uses the ambulance range MINIMUM. MA_ONLY rows were already 100% filled without it.
- `rederive-otc-food-allowances.js` — dry-run showed 0 changes for 2027.
- `backfill-missing-plans.ts` — not needed; the PlanArea import + Section A fallback + `ma2027.csv` brought in every SNP.
- `import-star-ratings.js` — 2027 Star Ratings not published as of 10-02.

## Importer fixes made 10-02 (`scripts/import-cms-data.ts`)

1. EGWP gate added to the createMany path. Before, a live run wrote every 800-series employer-group row (98,944 for 2027) while the dry-run count said they were skipped.
2. `planTypeLabels` in `parsePlanArea()` corrected. It had `"02" -> PPO` and `"04" -> MSA`; CMS codes are 02 = HMOPOS, 04 = Local PPO, 31 = Regional PPO.

## 2026 live-data repairs made 2026-10-02 (approved by Dale)

Script: `scripts/import2027/fix-2026-plantype-deductible.js` (dry-run by default). Before-image of every changed row:
`scripts/import2027/fix-2026-backup-2026-10-02T20-48-29-679Z.json`.

- **Contract Type:** 313 HMO-POS plan IDs (11,061 rows) were labeled `PPO`; now `HMOPOS`. Each was confirmed HMO-POS in the CY2026 landscape.
- **Drug deductible:** 181 plan-segments (4,718 rows) showed $0 where the CY2026 landscape has a real deductible (173 of them $615):
  CSNP 151, ISNP 22, MAPD 8. Set to the landscape value.
- **Left alone on purpose:** 357 DSNP plan-segments (16,345 rows) still show $0 against a landscape deductible. Duals do not pay it.
- A 2026 re-import would bring both errors back unless the fixed importer is used (contract type) and this script is re-run (deductible).
- Not touched: the odd 2026 labels `Local PPO`, `Local HMO`, `Local PPO *` etc. The Contract Type filter is a "contains" match, so picking HMO also returns HMOPOS plans.

## SB links — applied 2026-10-05

`node scripts/sb2027/apply-links.js` (dry-run) / `--verify-blobs` (HEAD every blob) / `--apply`. One set-based UPDATE, 2027 rows only.
Each row gets the SB of its own segment and `sbSegmentId = segmentId`. Idempotent.

- Before applying: `node scripts/sb2027/upload.js` until "remaining 0". On 10-05, 314 Humana SBs were validated but had never been uploaded
  (`blobUrl: null`). Uploads run about 30 files per 2 minutes from Cowork (Humana SBs are ~13 MB each).
- Result: **1,939 of 2,034 plan-segments linked, 64,519 of 68,711 rows.** All 1,939 blobs answer 200 with the manifest byte size;
  47 sampled blobs (all 6 carriers, segmented ones included) re-passed the strict validator. 2026 checksum unchanged.
- Not linked: 93 UnitedHealthcare, Aetna H1610-1 (FIDE, VA), Wellcare H1416-81 (Magnolia Dual Reserve, MS).
- **UHC `too_short_text` cause:** uhc.com serves a 102,407-byte one-page "PDF coming soon..." placeholder for an SB it has not posted yet.
  The validator is right to reject it. 287 of the 380 were live by 10-05. To pick up the rest:
  `node scripts/sb2027/acquire.js --carrier UnitedHealthcare --retry --budget 120 --conc 10`, then `apply-links.js --apply`.
- **Checked the broker portals 2026-10-05 (Dale's logged-in Chrome).** The 93 UHC SBs are not posted anywhere yet:
  the Jarvis Sales Materials Portal (uhc-materials.sbs.shutterfly.com, search "2027 English SB") lists 86 of them, and every one
  downloads as the same 16,718-byte one-page placeholder; the other 7 (H1889-002 seg 1+2, H1889-026, R0759-003, H0710-013, H0710-052,
  H0421-001) have no SB entry at all. A posted SB there is ~1 MB. The portal's document IDs are the same alphadog IDs the public site uses,
  so when UHC posts them the normal `acquire.js --retry` picks them up. Jarvis says 2027 materials are late ("extended benefit finalization").
  Real 2027 "Plan Highlights" PDFs (~11 MB) do exist there for 85 of the 93, and mpp.uhc.com/plans/plan-details.<H####-###-###>.2027.html
  shows full 2027 benefits (incl. a "Special Eligibility" line naming the Medicaid levels each D-SNP takes) for every UHC plan. Both need Dale's login.
  Aetna H1610-1: no SB on aetna.com or Producer World; only a broker plan guide (PG27-VAS01-VA-FIDE-DSNP.pdf, login required).
- **Re-run `apply-links.js --apply` after `backfill-segment-ids.js 2027`** — that script resets `sbSegmentId` to one value per plan.

## reapply-sb-truth.js is 2026-only (checked 2026-10-05)

- All 15 child fixers are hard-coded to `planYear: 2026`. Running the chain does nothing for 2027.
- Its two inline QMB steps, and `apply-qmb-protection.js` / `apply-qmb-overrides.js`, had NO year filter: `--apply` would have written the
  2026 QMB classification onto 2027 rows with the same plan ID. Fixed 10-05: all four writes now carry `planYear: 2026`.
- 2027 needs its own pass: each SB-reading fixer run against 2027 rows and 2027 SBs (dry-run first; several have 2026 thresholds,
  reference plans and artifact files baked in), and `classify-qmb-protection.py` over the 2027 SBs.
- **QMB is a go-live blocker:** the plain-QMB search matches only `qmbCostShareProtected = true`, and every 2027 row is NULL,
  so a 2027 QMB search returns no D-SNPs until the classifier has run.

## QMB classification — applied 2026-10-05

1. `python3 scripts/sb2027/classify-qmb.py --budget 160` — repeat until "left 0" (about 1.2 s per SB; 370 D-SNP SBs = 4 calls).
   Imports the 2026 rules from `classify-qmb-protection.py` and adds 2027-only rules (`post_2027`). Caches SB text in
   `.cms-import-tmp/sb-2027/txt/` and two-column text in `txt2col/`. Writes `scripts/data/qmb-protection-2027.json`, keyed by plan-segment.
2. `python3 scripts/sb2027/merge-uhc-mpp-qmb.py` — fills the UHC D-SNPs that have no SB yet from `scripts/data/uhc-mpp-eligibility-2027.json`
   (UHC agent portal, read 10-05). Never overrides an SB answer. Re-running step 1 after an SB posts replaces the `mpp:` entry.
3. `node scripts/sb2027/apply-qmb.js` (dry-run) / `--apply` — one UPDATE, 2027 rows only, by segment.

Result: 430 D-SNP plan-segments -> **201 show for QMB, 217 hide, 12 unclassified** (17,198 rows written). 2026 checksum unchanged.

2027 SB layouts that broke the 2026 rules, and the fix in `post_2027`:
- **UHC PPO D-SNPs:** rule 2 ("if you have full Medicaid ... otherwise you will pay") fires on the OUT-of-network column even when the
  in-network column gives standalone QMB $0. 3 plans read as hide that are show (KY-Q1, MO-Q2, TX-S001). Fixed from the Medicaid-category bullets.
- **Devoted:** two-column pages break rule 5 (53 uncertain). Fixed by reading the "receive assistance from the <state> Medicaid program as a ..."
  sentence from de-interleaved text. Devoted plan names now say it too: QMB / PLUS = show, FULL = hide, plain DUAL with SLMB/QI = hide.
- **Humana integrated plans:** "this plan may enroll ... (FBDE), ... (QMB+), ... (SLMB+)" has parentheses the rule 3 pattern rejects (6 uncertain).
- **Never read a level from its spelled-out name** when a "+" abbreviation follows: "Qualified Medicare Beneficiary (QMB+)" is not QMB.
  The 2027 rules read the parenthesised abbreviations only.
- 14 plans changed answer from 2026. All were checked against the 2027 SB text and are real plan changes (e.g. Wellcare Dual Liberty dropped
  standalone QMB; Aetna H3239-2 and -10 added it; Humana H5619-75 is now SLMB/QI only).

Unclassified (stay hidden from a plain QMB search): Wellcare Dual Align H0062-11, H0062-12, H4158-1, H4158-4, H5272-1 (integrated plans, SB names no
Medicaid levels); UHC H0421-1, H1889-2 (both segments), H1889-26, R0759-3 (UHC's portal says "not accepting new members starting Jan 1, 2027");
Aetna H1610-1 and Wellcare H1416-81 (no SB).

## Still to do for 2027

Remaining UHC SBs (93) + 2 stragglers (then re-run the QMB steps above), the 2027 SB-fix pass, SB benefit extraction (OTC / food card pages, wallets),
hospital full-stay re-derive, Star Ratings, 2027 LIS figures (`lib/lisDrugCopays2026.ts`, benchmarks), then un-gray 2027 in the dropdown.
