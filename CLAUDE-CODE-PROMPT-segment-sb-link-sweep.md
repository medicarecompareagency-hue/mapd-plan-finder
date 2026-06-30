# Claude Code Prompt — Finish the per-segment SB sweep: link the last 13 multi-segment SBs (UHC opaque-docid + Wellcare Centene DAM), re-hosted to Blob

**Run in the `mapd-plan-finder` repo (Windows/PowerShell) with Claude Code. Owner: Dale, a Medicare agent, not a developer. RUN EVERYTHING YOURSELF — no command lists for Dale to paste. Self-contained. App DB = Neon. ONE decision gate at step C. Stop only on a real error or that gate. Report back terse.**

## Why (do not re-litigate)
CMS publishes a separate Summary of Benefits per (contract, plan, **segment**). Segments have different service areas AND different benefits. The DB historically stored ONE SB per `planId`, so a multi-segment plan showed the wrong segment's SB to counties served by its other segments (the bug: H4407-30 Perry [seg 2] was showing the seg-1 Gulf Coast SB, whose service area doesn't even list Perry).

That is already FIXED structurally, and 90% of the links are done:
- **Schema:** `Plan.segmentId` = this county-row's CMS segment (from `.cms-import-tmp/pbp-2026/PlanArea.txt`, populated by `scripts/backfill-segment-ids.js`). `Plan.sbSegmentId` = which segment the currently-stored `sbPdfUrl` represents.
- **Gate:** `/api/plans` `isSbSegmentMismatch()` — when `segmentId !== sbSegmentId`, it nulls `sbPdfUrl` and the UI falls back to a segment-correct medicare.gov link (`plan.sbSegmentMismatch`). So a wrong-segment SB is NEVER shown; the worst case is the fallback.
- **Linking a segment** = set `sbPdfUrl` + `sbSegmentId = segmentId` (+ `sbPdfSourceFilename`) on that segment's county-rows. That makes `segmentId === sbSegmentId`, which OPENS the gate so the hosted SB shows. Reusable tool: `scripts/link-segment-sbs.js` (reads a JSON array `[{planId, seg, url}]`).
- 78 of 91 originally-gated segments are already linked.

**This pass closes the last 13 segments / ~177 county-rows** — the ones whose SBs don't surface via plain keyword search:
- **UHC (9)** — AARP "Essentials/Extras" (+ a couple Complete Care) whose seg-2 SBs live under opaque Optum doc IDs.
- **Wellcare (4)** — hosted on the Centene DAM, not on content.medicareadvantage.com.

Goal: replace the medicare.gov fallback on these 13 with the real per-segment SB, **re-hosted to Vercel Blob** (the project convention for the rest of the corpus). The prior pass linked the easy 78 via direct CDN URLs because the Blob token wasn't available in that environment — re-host those too if you want full consistency, but the 13 below are the priority.

## The 13 targets (RE-DERIVE from the DB — this is the authoritative worklist)
```
Plan where planYear = 2026 AND segmentId IS NOT NULL AND sbSegmentId <> segmentId
  -> group by (planId, segmentId)
```
As of this handoff:

| carrier | planId | seg | state | counties |
|---|---|---|---|---|
| UnitedHealthcare | H1045-48 | 2 | FL | Charlotte, Collier, DeSoto, Glades, Hardee, Hendry, Lee, Manatee, Sarasota (9) |
| UnitedHealthcare | H5253-108 | 2 | IL | Henry, Mercer, Rock Island (3) |
| UnitedHealthcare | H5253-109 | 2 | KY/OH | Boone, Campbell, Grant, Kenton, Pendleton + OH border (24) |
| UnitedHealthcare | H5253-109 | 4 | OH | Champaign, Clark, Darke, Greene, Miami, Montgomery, Preble, Shelby (8) |
| UnitedHealthcare | H5253-111 | 2 | VA | Chesterfield, Hanover, Henrico, Richmond City, Petersburg City + (12) |
| UnitedHealthcare | H5253-112 | 2 | VA | (same Richmond-area 12 as H5253-111 seg2) |
| UnitedHealthcare | H5253-124 | 2 | OH | Allen, Lucas, Wood, Hancock, Sandusky + NW Ohio (22) |
| UnitedHealthcare | H5253-126 | 2 | OH | (same NW Ohio 22 as H5253-124 seg2) |
| UnitedHealthcare | H8768-17 | 2 | IL | Henry, Mercer, Rock Island (3) |
| Wellcare | H1032-244 | 2 | FL | Clay, Duval, Flagler, Nassau, St. Johns (5) |
| Wellcare | H1032-245 | 2 | FL | Clay, Duval, Flagler, Nassau, St. Johns (5) |
| Wellcare | H2491-32 | 2 | LA | Acadia, Caddo, Lafayette, Rapides, St. Landry + (26) |
| Wellcare | H2491-33 | 2 | LA | (same 26 LA as H2491-32 seg2) |

(Several share a service area — e.g. H5253-111/112 seg2, H5253-124/126 seg2, H1032-244/245 seg2, H2491-32/33 seg2 — so the SB you validate for one applies to its twin's benefits but each still gets its OWN contract-plan-segment SB doc.)

## Hard constraints (project law — respect ALL)
- DB is Neon. `makePrisma()` from `scripts/prisma-client.js` ONLY (auto-adds `?pgbouncer=true`; raw `new PrismaClient()` hits Postgres 42P05). NO new columns needed — additive `prisma db push` only if you ever change schema.
- **Verify-first, SEGMENT-correct.** Before linking, open each candidate SB and confirm: (a) plan year 2026, (b) it IS a Summary of Benefits (not EOC/ANOC/FAQ), (c) the header reads `H<contract>-<plan3>-<seg3>`, and (d) **its "Service Area" county list overlaps the DB segment's counties.** Check (d) is the one that proves it's the RIGHT segment — linking a wrong-segment SB is worse than the fallback. Reject on mismatch.
- **Re-host to Vercel Blob** (BLOB_READ_WRITE_TOKEN is in env). Use the existing upload path (`scripts/upload-sb-pdfs.ts` / the streaming uploader pattern). NO raw `Uint8Array -> Blob` in committed scripts.
- **pdfplumber** for SB page parsing.
- OneDrive mount truncates large `Edit`/`Write` — do risky writes via a throwaway Node script. Throttle fetches, checkpoint, resume.
- `vercel --prod` from a SECOND PowerShell window.

## URL patterns already cracked (reuse — do NOT rediscover)
- **UHC alphadog serves the SB PDF directly** (`Content-Type: application/pdf`):
  - AARP: `https://www.uhc.com/medicare/alphadog/<docid>`
  - Community/D-SNP: `https://www.uhc.com/communityplan/alphadog/<docid>` (e.g. H5322-050-002 = `CSGA26HP0333086_001`, already linked).
- **UHC CDN:** `https://content.medicareadvantage.com/2026/UHC-<AA|CS|UH><ST>26<HP|LP><docid>-<seq>-H<contract><plan3><seg3>-SB-<date>-<time>-2026-SF<date>.pdf`. The `<docid>` is opaque PER (plan, segment). For the AARP OH plans the seg-1 docids are known (H5253-124-001 = `AAOH26HP0332994`, H5253-126-001 = `AAOH26HP0332998`, H5253-125-002 = `AAOH26HP0332997`, H5253-144-002 = `AAOH26HP0333012`); the seg-2 docid is a DIFFERENT nearby number — get it from SerpAPI or the plan's `uhc.com/medicare/health-plans/details.html/<id>/<seg>/H5253124002/2026` page, then build the CDN or alphadog URL.
- **Wellcare Centene DAM:** `https://www.wellcare.com/-/media/pdfs/medicare-2026/<st>/sb/<docid>_2026_<ST>_SB_<TYPE>_<num>ENG_M.ashx` (seen live: H9916 HI, H3561 CA, H0351 NV). Also `https://wellcare.<stateplan>.com/content/dam/centene/medicare/pdfs/aep/2026/sb/...`. For H2491 (LA, "Dual Liberty" D-SNP) and H1032 (FL, "Dual Access Sync" D-SNP), find the LA and FL DAM SBs. Wellcare 2026 SBs are NOT on content.medicareadvantage.com — go straight to the DAM.
- (Already done last pass, for reference): **HealthSpring** = `content.medicareadvantage.com/2026/Healthspring_sb-h<contract>-<plan3>-<seg3>_2026_SB_SF20260211.pdf` (universal). **Humana** = `content.medicareadvantage.com/2026/Humana-H<contract><plan3><seg3>SB26pdf-2026-SF20251001.pdf` (universal).

## Method
### A — discover
For each of the 13, query SerpAPI for `"H<c>-<p3>-<s3>" 2026 Summary of Benefits` + the plan marketing name (UHC AARP "Essentials/Extras OH-x"; Wellcare "Dual Liberty"/"Dual Access Sync"). Also try the alphadog / Centene-DAM patterns directly. Collect candidate SB URLs. Throttle + checkpoint to a progress JSON.
### B — verify-first
Fetch each candidate, parse page 1 with pdfplumber. Apply checks (a)-(d) above. Keep only validated matches.
### C — DECISION GATE
Print a table: `planId | seg | candidate URL | year-ok | is-SB | service-area-match | -> Blob URL`. If all 13 validate, proceed. If any don't validate or can't be found, list them as "genuinely unposted / DAM-not-found" and proceed with the rest. Either way print the table before mass-writing.
### D — re-host + link
For each validated SB: download -> upload to Vercel Blob -> write `[{planId, seg, blobUrl}]` to a JSON and run `node scripts/link-segment-sbs.js <json>` (sets `sbPdfUrl` + `sbSegmentId = segmentId` + `sbPdfSourceFilename` on that segment's rows, opening the gate). Idempotent.

## Verify
- `Plan` where `segmentId <> sbSegmentId` count -> 0 (or == the documented still-unposted floor).
- Spot-check 2-3 in the running app: the segment's counties now show the green **"Summary of Benefits"** link (hosted Blob PDF), not **"Segment SB on medicare.gov"**. E.g. search Lafayette Parish LA / H2491-32, or Lucas County OH / H5253-124.
- `npx tsc --noEmit` = 0.

## (Optional) confirm the prior pass's pattern-constructed links
The earlier sweep linked the Humana (19) and HealthSpring H4513 (26) segments by deterministic URL pattern (validated on samples, not each one). A cheap HEAD/200 check over every `Plan.sbPdfUrl` containing `Humana-` or `Healthspring_sb-h4513` would confirm none 404. Re-host any that pass to Blob for consistency. Fold in only if quick.

## Back up + deploy
```
git add -A
git commit -m "Finish per-segment SB sweep: link last 13 multi-segment SBs (UHC alphadog + Wellcare Centene DAM), re-hosted to Blob; opens the segment gate"
git push
```
Then a SECOND PowerShell window: `vercel --prod`.

## Final report to Dale (terse)
- # of the 13 linked vs # genuinely-unposted (the floor, with reasons).
- Any service-area mismatches caught and skipped.
- Spot-check result + deployed URL.
