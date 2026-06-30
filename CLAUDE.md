@AGENTS.md

# Persistent memory — latest handoff
Most recent session: **2026-06-30** — full record in `HANDOFF-2026-06-30.md`.

- **Segment-aware SB fix — DONE & deployed.** Multi-segment plans were showing the WRONG segment's Summary of Benefits (CMS publishes one SB per contract-plan-SEGMENT; DB stored one per planId). Added `Plan.segmentId` + `Plan.sbSegmentId`; `/api/plans` `isSbSegmentMismatch()` gate suppresses wrong-segment SBs -> segment-correct medicare.gov fallback. **91/91 affected segments linked to correct per-segment SBs; 0 gated.** Tooling: `scripts/backfill-segment-ids.js`, `scripts/link-segment-sbs.js`. Commits c28bc07, f0e10bd, 5455de5.
  - **The plan/county membership was CORRECT** — do NOT "fix" segment-SB issues by removing plans from counties.
  - **Re-import durability:** a CMS re-import wipes `sbPdfUrl`/`sbSegmentId` and re-introduces the mismatch — must re-run `backfill-segment-ids.js` AND re-apply the per-segment SB links, or the fix is lost.
- **Carried forward (untouched this session):** food/OTC wallet fill-rate backlog (Humana 138 @ 0%, HealthSpring 28 @ 13%, UHC/Wellcare/Devoted tails). Next action: read-only Humana + HealthSpring SB sample-check. Details in `HANDOFF-2026-06-30.md` Part 2.
- DB is **Neon** (older notes say Supabase — stale). `makePrisma()` appends `?pgbouncer=true`.
