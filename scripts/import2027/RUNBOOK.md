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
  Aetna H1610-1: not on aetna.com or Producer World, but FOUND later on 10-05 on the public mirror:
  `https://content.medicareadvantage.com/2027/Aetna-H1610_001_DS17_SB2027_M-2027-SB_SF20260918.pdf` (in `sb-url-hints-2027.json`; validated, linked).
  Mirror pattern for Aetna 2027: `Aetna-<SB doc stem>-2027-SB_SF<yyyymmdd>.pdf`; the date is not guessable, probe September dates.
  UHC mirror names carry a generation timestamp, so they cannot be probed; a web search for the plan ID is the only way in.
- **SerpApi:** the one key in `.env.local` (`SERPAPI_API_KEY`) still returns 401 "Invalid API key" (checked 10-05, no searches used).
  Search cannot find the 93 UHC SBs anyway: they are not published. A search did find the Aetna one above.
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

## SerpApi sweep — 2026-10-05 (key replaced by Dale, works again)

`node scripts/sb2027/serp-sweep.js --budget 150 --conc 6` — 2 Google queries per still-missing plan-segment, PDF links on carrier/mirror hosts are
added to `sb-url-hints-2027.json`, then `acquire.js --retry` runs them through the strict validator. Result on 10-05: 94 plan-segments searched
(about 205 searches), 16 returned candidate links, **0 were the right document** (all rejected as another plan's SB; the rejected hints were removed
again). Google cannot find an SB the carrier has not published. Use it for stragglers, not for the UHC backlog.

## Specialist copay from the SB — applied 2026-10-05

`node scripts/sb2027/fix-specialist.js` (dry-run) / `--apply`. 2027 port of `fix-specialist-typediff-zero.js` + `set-uhc-specialist-choice-display.js`
(same `analyze()` / `analyzeChoice()`, verbatim), per plan-segment, local SBs, set-based.
- 153 plan-segments had specialist coinsurance and no copay (25 without an SB). 1 clean "$0 copay" (Wellcare H9630-11, 75 rows -> $0).
- 18 UHC "$0 copay or 20% coinsurance" plans got `specialistDisplay = "$0 or 20%"` (863 rows, display only).
- 2027 trap: UHC C-SNP SBs wrap "$0 / copay or 20% coinsurance" over two lines, which the 2026 analyzer reads as a clean $0. A member-choice match now wins.

## OTC / food card / wallets from the SB — applied 2026-10-05

1. **Extract** with the 2026 extractor, extraction-only (it never touches the DB without `--update-db`):
   build chunk files under `.cms-import-tmp/sb-2027/extract/in/` (30 SBs or 90 MB each; `organization` filled so no DB lookup), then per chunk, from a scratch
   cwd: `ESBUILD_BINARY_PATH=<linux esbuild> DATABASE_URL=postgresql://none:none@127.0.0.1:1/none node node_modules/tsx/dist/cli.mjs scripts/extract-sb-benefits.ts <chunk.json>`
   and move `sb-benefit-extraction-results.json` to `extract/out/`. 1,940 SBs took about 7 minutes in 3 calls. Merged result: `extract/all.json` keyed by plan-segment.
   (Do NOT run it from the repo root: it overwrites the old `sb-benefit-extraction-results.json` there.)
2. `node scripts/sb2027/build-benefits.js` — proposals + review report, no DB writes -> `scripts/data/sb-benefits-2027.json` (every entry carries its SB sentence).
3. `node scripts/sb2027/apply-benefits.js` (dry-run) / `--apply` — one UPDATE, 2027 only, by segment, only the columns each SB supports.

Rules (2026 conventions; the 2026 fixer each one ports is named in `build-benefits.js`):
- BASE: `sbVerifiedOtcAmount` at extractor confidence >= 0.85, `sbVerifiedFoodAmount` at >= 0.80; SSBCI flags only where the PBP flags an SSBCI benefit.
- Aetna D-SNP/C-SNP: "$X monthly ... OTC Wallet will change to the Extra Supports Wallet" -> `foodCardAllowance = X*12`, conditional. Never `sbVerifiedFoodAmount`.
- Aetna other: "Extra Supports Wallet with a $Q quarterly benefit" -> `foodCardAllowance = Q*4`, conditional.
- UHC: benefit-row title decides. "OTC, healthy food, utilities +" (D-SNP) / "OTC and food credit" (C-SNP) = gated food card at the credit amount; "OTC credit" = OTC only.
- Wellcare: "$X monthly preloaded on your Wellcare Spendables card to spend on OTC items ... and if eligible, SSBCI" with Healthy Food in the SSBCI list ->
  food card at the Spendables amount, conditional. **This is a judgment call:** in 2026 only 16 of 50 Wellcare D-SNPs carried a food $ (the rest were treated as
  OTC-only under the "same wallet" rule). The 2027 SB wording is uniform and is the same structure as the Aetna/UHC/Humana wallets Dale approved as food cards.
- Devoted: "Food & Home Card $X per month for qualifying members" -> `sbVerifiedFoodAmount = X*12`, conditional + standalone; SNPs also `foodCardAllowance`.
- Humana: Healthy Options Allowance -> `sbVerifiedOtcAmount = sbVerifiedFoodAmount` (BASE finds 127 of 132 SNPs; a fallback regex catches 5 more).
- HealthSpring: Healthy Grocery Allowance accepted at confidence 0.75 (it equals the PBP-filed amount on every non-segmented plan).
- UHC with no SB: `scripts/data/uhc-mpp-otc-2027.json` (agent portal, read 10-05). Portal vs SB agree on amount, period and food gating on 305 of 305
  plan-segments that have both. 61 food cards + 11 OTC-only filled this way; they are replaced by the SB rule as soon as the SB is staged (re-run steps 1-3 for it).

Result: 1,288 plan-segments, 45,036 rows written. D-SNP/C-SNP plan-segments with a food card: Aetna 122/122, Devoted 165/211, HealthSpring 36/38, Humana 133/143,
UHC 156/157, Wellcare 52/58. SB OTC = PBP OTC on every non-segmented plan where both exist. 2026 checksum unchanged.

**Finding — PBP benefits are not segment-aware.** `import-pbp.js` keys by plan ID and keeps the MAX across segments, so on the 74 segmented 2027 plans
(4,626 rows) every segment carries the richest segment's PBP numbers (OTC, food, and likely copays). Example H4513-109: segment 2's SB says OTC $60/qtr and
grocery $200/qtr; the DB had segment 1's $150 and $300 on both. The SB values written today outrank the PBP columns for OTC and food, so those two are right
per segment now (23 corrections listed in the build report). Other PBP columns on segmented plans are still collapsed. 2026 has the same issue.

**UHC plans closed to new members for 2027** (agent portal): H0421-1, H1889-2 (both segments), H1889-8, H1889-26, H1889-30, H4527-60 segment 2, R0759-3.
**Removed from 2027 on Dale's decision, 2026-10-05:** `node scripts/import2027/remove-closed-uhc-2027.js --apply` — 568 rows, each saved first in
`scripts/import2027/removed-closed-uhc-2027-backup.json`. 2027 is now 68,143 rows · 1,915 plan IDs · 2,026 plan-segments (1,937 with an SB).
**Re-run that script after any 2027 re-import.** The SB manifest and `plans.json` still list these plan-segments, so `apply-links.js`, `apply-qmb.js` and
`apply-benefits.js` will report a few entries with no 2027 row; that is expected.
Other decisions the same day: Wellcare Spendables = chronic-only food card (as applied); Aetna H1610-1 (FIDE, VA) stays in.

Not done from the 2026 list: the MRI/CAT outpatient-hospital audit (display only, needs a fresh 2027 audit), SB page numbers (the extractor returns none),
H4939-4 Humana PathWays NFLOC (allowance amount not read).

## 2027 LIS figures — code change 2026-10-05 (needs a deploy)

The LIS tables are now plan-year aware. A 2026 search gives exactly what it gave before; a 2027 search uses the 2027 figures.

- `lib/lisBenchmarks.ts`: `LIS_BENCHMARKS_2027` (18 states) and `LIS_BENCHMARKS_BY_YEAR`; `lisAdjustedPremium(..., planYear = 2026)`.
  Source: CMS "Regional Rates and Benchmarks 2027" (`regional-rates-and-benchmarks-2027.pdf`). The 2026 table was re-checked against CMS's 2026 file and matches.
- `lib/lisDrugCopays2026.ts`: `LIS_DRUG_COPAY_2027` (full benefit $1.65 / $5.00, others $5.80 / $14.40, out-of-pocket threshold $2,400),
  `lisDrugCopayTable(planYear)`, and an optional `planYear` on `lisScheduleForLevel` / `lisCopayForTier`. Source: CMS CY2027 Rate Announcement, Table V-2.
- `app/api/plans/route.ts` passes `plan.planYear` to `lisAdjustedPremium`. `app/plan-search.tsx` passes it to the tier cells and the banner.
- NOT done: the LIS Qualifier modal still holds the 2026 income / resource limits. CMS had not published the CY2027 resource-limits memo or the 2027 poverty guidelines.

## Star Ratings — script made year-safe 2026-10-05 (2027 ratings not posted yet)

`scripts/import-star-ratings.js` used to read and write EVERY row in the Plan table. Run with a 2027 file it would have overwritten 2026.
It now takes the plan year: `node scripts/import-star-ratings.js 2027` reads `scripts/data/star-ratings-2027-summary.csv`, looks for the
`2027 Overall` column and touches `planYear = 2027` rows only. No argument = 2026.
When CMS posts the 2027 ratings: download `2027-star-ratings-data-tables.zip` from the CMS Part C and D Performance Data page, save its
"Summary Ratings" CSV as `scripts/data/star-ratings-2027-summary.csv`, run the command above. Until then all 68,143 rows have no rating
and ranking key 6 does nothing for 2027.

## MRI / CT cost share — applied 2026-10-05

`python3 scripts/sb2027/mri-from-sb.py` (reads all 1,940 staged SBs, no DB, writes `scripts/data/mri-sb-2027.json`), then
`node scripts/sb2027/fix-mri.js` (dry-run) and `--apply`. This one pair replaces the three 2026 steps
(`rederive-mri-cat-copay.js`, `audit-mri-copay-outliers.js`, `fix-mri-outpatient-from-sb.js`). **Do not run `rederive-mri-cat-copay.js` on 2027**:
it wipes the D-SNP full-dual $0.

Result: 455 plan-segments, 21,879 rows changed; 373 of them (17,864 rows) change what an agent sees. Applied list with the SB sentence
behind each SB-based value: `scripts/data/mri-fixes-2027.json`. After it: 1,855 plan-segments show a copay, 170 a coinsurance, 1 blank.

- **SB outpatient-hospital amount instead of the CMS range top (Dale's 2026-07-06 rule):** 180 Humana plan-segments. CMS files one range for
  all imaging settings; its top ($360, $700, $720, $780) is not the outpatient-hospital copay. The SB says $345 on most.
- **Full-dual D-SNPs to $0:** 40 Humana plan-segments showed $335 / $345 / $780. Their SB says $0 in-network.
- **Coinsurance stored as 0%:** 111 plan-segments (partial-dual D-SNP, C-SNP, I-SNP, 3 MAPD) showed 0% or blank where CMS and the SB say 20%.
  The base import read the low end of the filed range. The 2026 fix for this was never re-run for 2027.
- **Devoted:** 40 plan-segments 40% -> 50% (SB "Outpatient Hospital: 50% coinsurance"). 2 HealthSpring MAPD blank -> $0.

Rules in `fix-mri.js`: CMS value per plan-SEGMENT (copay range top, else coinsurance range top); the SB wins when it states a cost share;
for a D-SNP an SB "$0" is the with-Medicaid amount, so it is stored only on FULL_DUAL plans (as a $0 copay with the % left underneath, same
as 2026), and other D-SNPs keep the CMS-filed amount unless the SB has a "Without Medicaid cost share assistance" column (Devoted).
SB reading is carrier-specific and in-network only. SB and CMS agree on every plan-segment outside the groups above.
Seen, not changed: 2026 still shows $335 on 11 Humana full-dual D-SNPs.

## import-pbp.js columns per plan-segment — applied 2026-10-05

`node scripts/import2027/pbp-by-segment.js` (dry-run) and `--apply`. `import-pbp.js` keeps the highest value across a plan's segments, so every
segment of the 73 segmented plans showed the richest segment's OTC, food card, dental, vision and hearing amounts. This script recomputes
those columns per plan-segment with the same code (`buildAgg` is now exported from `import-pbp.js` and takes a key function; its default
behaviour is unchanged) and corrects a row only if it still holds the plan-level value. Corrected: OTC 27 plan-segments, food card 2,
dental max 68, vision max 51, hearing max 9, OTC period 5, hearing text 11 (3,390 column-rows). The per-segment OTC and food values now
equal the SB values on every segment that has both. **Run it after `import-pbp.js` + `backfill-segment-ids.js` on any re-import.**
The copay columns from the base import (MRI, hospital, specialist, ...) were already per segment. 2026 has the same plan-level issue and was not touched.

## Still to do for 2027

Retry the 88 UHC SBs + Wellcare H1416-81 (then re-run the QMB, benefit and MRI steps above for the new ones), Star Ratings when CMS posts them
(command above), the LIS Qualifier modal's 2027 income / resource limits when CMS publishes them, then un-gray 2027 in the dropdown.
