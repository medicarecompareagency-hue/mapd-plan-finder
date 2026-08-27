@AGENTS.md

# Persistent memory — latest handoff
Most recent session: **2026-08-27**. Prior full records: `HANDOFF-2026-07-02.md`, `HANDOFF-2026-06-30.md`.

- **SB-PDF tail — DONE (2026-08-27). 100% licensed-state 2026 SB coverage (58,895/58,895 rows).** The last 69 unresolved plans (19 Humana, 37 UHC, 6 Wellcare, 2 Aetna — incl. the whole Aug-2026 UHC/Wellcare retry list) were found, strict-validated, and linked. **SerpApi was NOT used — both keys in `.env.local` are dead (401 on account endpoint; account lapsed/rotated). Dale must get a fresh key from serpapi.com before any future SerpApi run.** Key-free sources that now work: (1) Humana direct pattern `content.medicareadvantage.com/2026/Humana-{contract}{pbp3}000SB26pdf-2026-SF20251001.pdf`; (2) `www.medicareadvantage.com/plans/{name-slug}-{contract}-{pbp3}-000` pages link each SB; (3) UHC re-posted CDN pattern `UHC_{CS|UH|AA}{ST}26{HP|LP}{docid7}_2026_SB_SF20260204.pdf` (docids cluster per family); (4) `uhc.com/medicare/alphadog/{code}_000` + `uhc.com/communityplan/alphadog/{code}_000` (CS-prefix docs); (5) Wellcare state-affiliate `wellcare.{buckeyehealthplan|homestatehealth|mhsindiana|sunflowerhealthplan}.com/plan-benefit-materials.html`. 5 segmented plans (H1889-2, H3256-4/5/6, H5322-49) got per-segment SBs + `sbSegmentId`. All links via `scripts/ingest-sb-url.js` strict gate; post-link validation 69/69 GOOD, 0 mislinks. Durability: `scripts/data/sb-tail-links-2026-08.json` (74 links) + `scripts/reapply-sb-tail-links.js` (NULL-only), registered FIRST in `reapply-sb-truth.js` FIXERS. `sbOtcPage`/`sbFoodCardPage` for these 69 are still NULL — wallet/page extraction is a separate follow-up. Also: `.env.local` had a mangled UTF-16 tail — rewritten clean UTF-8 (backup `.env.local.bak-encodingfix`). Old pipeline state files (`sb-download-list.json`, `sb-unresolved-plans.json`, `sb-discovery-results.json`) are STALE — do not replay `upload-sb-pdfs.ts` over the full discovery file (it would clobber newer links).
- **SLMB/QI caveat chip — DONE & deployed (2026-07-14).** Amber "SLMB / QI" chip + "not cost-share protected" caveat in the results legend row (`app/plan-search.tsx`), shown only when `isDsnp && searchedDualLevel ∈ NON_COST_SHARE_PROTECTED` (new Set `["SLMB", "QI-1"]`, next to `MEDICAID_COVERS_COST_SHARE` — which was NOT touched). Basis: CMS D-SNP rules, verbatim in Humana H1036-314 2026 SB — only FBDE/QMB/QMB+/SLMB+ are protected; "$0 or $X" split fields bill $X to plain SLMB/QI-1. Display-only; no ranking/DB changes. No QDWI option exists in the dropdown. Smoke-verified locally (Playwright, FL/Escambia/32505): SLMB + QI-1 show, SLMB+/QMB/MAPD hidden; mobile wrap OK. `test-verify` user temp-activated then restored. Commit `7c0d875`, deployed to https://mcaplanfinder.xyz.
- **Hospital-first MAPD ranking — DONE & deployed (2026-07-08).** MAPD (non-SNP) comparator in `app/api/plans/route.ts` reordered to 6 keys: `hospitalFullStayCost` ASC (NULL last) → LIS-adjusted premium → med deductible → specialist → MOOP → star DESC. **No premium cap** — paying-premium plan with lowest full-stay ranks #1 (e.g. AL/Calhoun: H4461-79 $20/mo, $770 full-stay, now #1 over $0-premium plans). New column `Plan.hospitalFullStayCost Float?` = total member copay for one complete inpatient stay, derived from the `hospitalStayCopay` display string (sum rate×days over intervals, or flat per-stay; coins/unparseable → NULL) by `scripts/derive-hospital-fullstay.js` — registered LAST in `reapply-sb-truth.js` FIXERS (re-import wipes it; re-derive must run after any string fixers). 56,471 rows filled; MAPD coverage 100% in 16 states, LA 96.8%, MS 96.4%. MA-Only/D-SNP/C-SNP rankers untouched (verified live). Dropdowns: Contract Type + Carrier "Any"→"All", LIS "Any"→"None" (default; same `value=""` sentinel — no param sent, API path identical). Plan Category keeps "Any" (Dale exempted). `FilterSelect` grew an `emptyLabel` prop. Ranking-only — UI still displays the per-day/per-stay string. Commit `ff118ec`, deployed to https://mcaplanfinder.xyz. Live smoke via `test-verify@mcaplanfinder.xyz` (temp-activated, restored to inactive + original hash after).
- **Tier 6 audit — DONE (2026-07-02).** 295 T6=$0 plans confirmed vs. PBP ("Select Care Drugs"). Zero data fixes. LIS lesser-of bug fixed in `drugTierCellQ` (`app/plan-search.tsx`): prior code showed flat LIS copay; fix applies `min(rawValue, lisV)`. Commit `67346c9`, deployed. Audit record: `scripts/data/tier6-audit-2026-07.json`.
- **Humana Healthy Options sweep — DONE (2026-07-02).** 24 plans newly filled via `fill-humana-healthy-options.js` → `sbVerifiedFoodAmount` (annualized, 1059 county rows). 104 already filled from prior session. 10 confirmed no-wallet (4 Humana Dual Fully Integrated, 6 genuinely no food section). Write target: `sbVerifiedFoodAmount`, NOT `foodCardAllowance` — `effectiveFoodCard()` and `effectiveOtc()` both read it for Humana. Durability: `scripts/reapply-humana-wallet-fills.js` + `scripts/data/humana-wallet-fills-2026.json`, wired into `reapply-sb-truth.js`. No deploy needed (data-only).
- **Humana wallet sample-check — DONE (2026-07-02, read-only).** See above; sweep complete.
- **HealthSpring wallet sample-check — DONE (2026-07-02, read-only).** HealthSpring Flex Card = OTC-only ($225/qtr already in DB as `otcAllowance`). No food/grocery benefit. **$0 food is legitimate — HealthSpring food backlog CLOSED.**
- **Segment-aware SB fix — DONE & deployed (2026-06-30).** `Plan.segmentId` + `Plan.sbSegmentId`; 91/91 segments linked; gate live. Re-import note: must re-run `backfill-segment-ids.js` + re-apply segment SB links after any CMS re-import.
  - **The plan/county membership was CORRECT** — do NOT "fix" segment-SB issues by removing plans from counties.
- **UHC unswept-family sweep — DONE (2026-07-02).** 10/22 plans filled (H0251/H2385/H2445/H2509/H2802/H3256/H5008 families) → `foodCardAllowance` (1050 county rows). 2 no-wallet (H0251-8, H2802-70). 10 not-found: H5008-10/11/16/17, H0251-2/4, H2385-1/3, H2445-2/3. Durability: `scripts/reapply-uhc-wallet-fills.js` + `scripts/data/uhc-wallet-fills-2026-07.json`, wired into `reapply-sb-truth.js`. No deploy (data-only).
- **UHC Final-20 sweep — DONE (2026-07-02).** 8/20 plans filled (H1889/H5322/H6595/H0169/H0421 families) → `foodCardAllowance` (744 county rows). 1 no-wallet (H0421-1 VA). 11 not-found added to retry list. Artifact merged: `scripts/data/uhc-wallet-fills-2026-07.json` (18 total fills). Script: `scripts/fill-uhc-final20.js`. Checkpoint: `scripts/data/uhc-final20-sweep-2026-07.json`. **UHC unswept families CLOSED.**
- **Devoted ssbciIsConditional spot-check — DONE (2026-07-02, read-only).** H6994-4 VA + H7355-9 MS SBs confirm: "available only to chronically ill members" = SSBCI-gated. Flag is CORRECT — no changes. Chip render: red "CHRONIC ONLY" badge + `*` on amount.
- **Wellcare DSNP/CSNP sweep — DONE (2026-07-02).** 4/33 plans filled → `foodCardAllowance` (305 county rows): H0908-1 $100/mo OH, H0908-6 $125/mo OH, H4158-1 $215/mo OH (Buckeye), H9387-4 $95/mo KS. 1 giveback (H0111-4 GA). 24 no-wallet. 4 not-found: H0908-7/8 OH (damaged/unindexed), H1664-5/12 MO (unposted). Durability: `scripts/reapply-wellcare-wallet-fills.js`. **Wellcare CLOSED.**
- **Devoted unswept tail sweep — DONE (2026-07-02).** 16/34 plans filled → `foodCardAllowance` (495 county rows). 18 no-wallet (all "Choice Plus" variants + H7766-15 LA DUAL FULL). 0 not-found. Anchor: H1290-86=$5916/yr. Direct URL pattern via `content.medicareadvantage.com` covered 100%. Write target: `foodCardAllowance` + `ssbciIsConditional=true` only. Durability: `scripts/reapply-devoted-wallet-fills.js` + `scripts/data/devoted-wallet-fills-2026-07.json`, wired into `reapply-sb-truth.js`. No deploy. **Devoted CLOSED. Food/OTC workstream CLOSED.**
- **Final food-floor audit — DONE (2026-07-02, read-only).** 589 DSNP+CSNP planIds: 492 filled (84%), 52 verified-$0 OTC-only, 43 unverified with blockers. Full detail: `scripts/data/food-floor-audit-2026-07.md`. 43 unverified = 9 confirmed-$0 (no retry), 14 not-found (retry Aug 2026), 20 unswept UHC families (H1889/H5322/H6595/H0169/H0421).
- **Food/OTC next:** UHC not-found retry (25 plans) after Aug 2026 re-posting: original 14 (H5008-10/11/16/17, H0251-2/4, H2385-1/3, H2445-2/3, H0908-7/8, H1664-5/12) + 11 new from Final-20 sweep (H1889-8/10/25/31/32, H5322-26/33/38, H6595-3, H0169-2/8). All carriers CLOSED except UHC retry.
## Database: Neon + Prisma (re-verified 2026-08-27)

The app DB is **Neon** (host `ep-gentle-forest-aqk2n9ca-pooler.….neon.tech`, via Vercel Storage). The raw `DATABASE_URL` has no `pgbouncer` flag; `makePrisma()` appends `?pgbouncer=true` itself.

> CLI scripts must use `makePrisma()` from `scripts/prisma-client.js` — never
> instantiate `new PrismaClient()` directly.
> NEVER run `prisma migrate dev` against the production DB (it wipes it). Use
> `prisma db push`.

SUPERSEDED (historical): older notes (e.g. `HANDOFF.md`) describe a Supabase pooler at `aws-1-*.pooler.supabase.com` — the DB moved to Neon; only the `?pgbouncer=true` requirement carried over.

## Search API & ranking — verified against code 2026-08-27

- Results are the top **5 distinct carriers**, not top-10: every ranking branch sorts, then `dedupeByCarrier(sorted, 5)` keeps one best plan per carrier and truncates to 5 (`app/api/plans/route.ts`). 5 results in the UI is by design, not a bug.
- MAPD (non-SNP) default is the hospital-first 6-key order (2026-07-08, `ff118ec`) — see the Hospital-first bullet above for the exact keys. No premium cap; NULL sorts last; the `hospitalFullStayCost` deriver runs LAST in `scripts/reapply-sb-truth.js`.
- SNP / C-SNP ranking is **SHIPPED and live** (first shipped 2026-05-12; current specs 2026-05-26): separate comparators for FULL_DUAL (5-key), PARTIAL_DUAL (7-key), CSNP (7-key), plus MA_ONLY (5-key). All SNP rankers are premium-agnostic — LIS never re-orders SNP results. I-SNP is excluded. Do not ask Dale for this spec — it exists in code.
- A DSNP search with no Medicaid Level selected is intentionally guarded (error message instead of results, `app/plan-search.tsx`) — do not "fix" it.
- LIS param `lisLevel` values are **case-sensitive**: `FULL` / `75` / `50` / `25` (`lib/lisBenchmarks.ts`). Medicaid Level param `beneficiaryDualLevel`: QMB+ / QMB / SLMB+ / FBDE / SLMB / QI-1. Both dropdowns shipped long ago — nothing is "blocked on CMS files".
- Plan table: **58,895 rows, all `planYear` 2026** (counted 2026-08-27, licensed states only). The year column is `planYear` — there is no `year` field.

## SB (Summary of Benefits) PDFs — CLOSED 2026-08-27

Coverage is 100%: every licensed-state 2026 plan row has a validated SB PDF link
(commit `97d6557`, deployed). There is NO permanent tail. Any older figure —
"74.1%", "34,713 / 46,856", "~14 unfindable", "351 remaining" — is STALE.

- SerpApi is DEAD. Both keys return 401. It was not needed; the final 69 plans were
  resolved via direct carrier URL patterns (Humana/Aetna on
  content.medicareadvantage.com, UHC CDN + alphadog doc IDs, Wellcare state-affiliate
  benefit-materials pages).
- NEVER replay the old `acquire -> download -> discover -> upload` pipeline.
  `upload-sb-pdfs.ts` replays the entire stale discovery file and will overwrite SB
  links fixed in later sessions. `sb-download-list.json`,
  `sb-unresolved-plans.json`, and `sb-discovery-results.json` are stale.
- Durability: `scripts/data/sb-tail-links-2026-08.json` +
  `scripts/reapply-sb-tail-links.js` (NULL-only), registered FIRST in
  `scripts/reapply-sb-truth.js`.
- Segmented plans need a per-segment SB with its own `sbSegmentId`. Known:
  H1889-2, H3256-4/5/6, H5322-49. Never blanket-link a plan ID without checking.
- Open followup: the 69 links added 2026-08-27 have NULL `sbOtcPage` /
  `sbFoodCardPage`.

## After ANY CMS re-import — MANDATORY

The importer is delete-and-reload (`deleteMany` + `createMany` per batch in
`scripts/import-cms-data.ts`). It WIPES every SB-derived fix (wallets, copays,
QMB classification, hospital costs, SB links). After any re-import you MUST run:

    node scripts/reapply-sb-truth.js --apply

plus `backfill-segment-ids.js` (see the Segment-aware bullet above). The 2027
import must also run the QMB classifier, or QMB search results will come back
sparse. Do not use `NOT` / `not` on `qmbCostShareProtected` — the gate is
strict (`qmb === true` only).

## Licensed carriers gate

All import and backfill scripts must gate on the **6-name** allowlist in
`scripts/licensed-carriers.js` (canonical org names as stored in the Plan table;
"Cigna"/"Cigna Healthcare" rows were normalized to **"HealthSpring"** — the 2026
DB has zero Cigna-named rows). Licensed states (18) live at
`scripts/licensed-states.js`.
