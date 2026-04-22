# Handoff — MAPD Plan Finder

Living document. Keep it current. Anyone (Dale, or a future Claude
session) should be able to read this and pick up exactly where things
stand.

Last updated: 2026-04-21

---

## Current state

- **Production site:** https://mcaplanfinder.xyz (Vercel, aliased)
- **Code backup:** https://github.com/medicarecompareagency-hue/mapd-plan-finder (private)
- **Database:** Supabase Postgres, shared between local dev and prod.
  Connection strings in `.env` (NEVER commit that file).
- **Local project folder:** `c:\Users\dbuir\mapd-plan-finder`
- **Vercel project:** `prj_x38le1itNwuSUj86f1z0gxm8B2ns` (linked via
  `.vercel/project.json`)

Working tree is clean as of this handoff. Everything that was built in
the last session is pushed to both GitHub and Vercel.

---

## What's in the DB right now

| Year | Rows    | Fully classified? |
|------|---------|-------------------|
| 2025 | ~141K   | Yes — 100% coverage |
| 2026 | ~146K   | Yes — 100% coverage |

Every row has `planCategory`, `cmsContractType`, and (where applicable)
`snpSubtype`, `chronicConditions`, `hasPartD`, `isZeroDollarDsnp`.

Category breakdown:
- MAPD: 173,194 (60.3%)
- DSNP: 69,573 (24.2%)
- CSNP: 15,296 (5.3%)
- ISNP: 11,149 (3.9%)
- MSA: 9,082 (3.2%)
- COST: 5,011 (1.8%)
- PACE: 3,014 (1.1%)
- MMP: 800 (0.3%)
- MA_ONLY: 16 (<0.1%)

---

## Deploy / backup workflow

Two independent flows. Do either, both, or neither — they don't depend
on each other.

**Back up code to GitHub** (after making changes):
```powershell
cd c:\Users\dbuir\mapd-plan-finder
git add -A
git commit -m "short description of what changed"
git push
```

**Deploy to production** (push changes to mcaplanfinder.xyz):
```powershell
cd c:\Users\dbuir\mapd-plan-finder
vercel --prod
```

DB changes don't need a deploy — Supabase is shared, so schema changes
and row updates are live the moment they're written.

---

## Backlog

### Item #1 — Plan Type dropdown expansion
**DONE** 2026-04-21. Shipped.

Users can now filter by MAPD / DSNP / CSNP / ISNP / MSA / PACE / COST /
MMP / MA_ONLY, with conditional sub-filters for SNP subtypes, chronic
conditions, and $0 DSNP. See `docs/STATUS-2026-04-21.md` for the full
audit trail.

### Item #2 — LIS (Low-Income Subsidy) dropdown
**BLOCKED** on data file from CMS.

Needs the **PDP benchmark file** that ships LIS-eligibility flags
(Full LIS / Partial 75 / Partial 50 / Partial 25 / No LIS). PDPs can
be derived from `pbp_d_lis_*` fields in the existing PBP ZIP, but
MAPD and DSNP plans need the separate LIS subsidy crosswalk.

To unblock: point Claude at the LIS file on cms.gov (or download it
and drop it in `.cms-import-tmp/`). Same workflow as Item #1 will
follow — catalog, schema additions, importer update, UI, verification.

### Item #3 — Medicaid Level dropdown
**BLOCKED** on data file from CMS.

Needs the **DSNP State Medicaid Agency Contract (SMAC) crosswalk**
file. The SnpSubtype enum already has the DSNP tier values waiting
(DSNP_FBDE, QMB_PLUS, QMB, SLMB_PLUS, SLMB, QI, MEDICAID_ONLY) — they
just aren't populated yet.

To unblock: same as #2. Point Claude at the SMAC file.

---

## Key files / scripts

### Scripts (`scripts/`, run via `npm run <name>` or `npx tsx scripts/<name>`)

- `import-cms-data.ts` — full CMS import (3.5 hours per year). Rarely
  needed now that DB is populated.
- `backfill-missing-plans.ts` — adds SNP/PACE/MSA/COST/MA_ONLY plans
  that NBER landscape doesn't publish. Uses PlanArea.txt as
  authoritative footprint.
- `cleanup-nonshoppable-mapd.ts` — removes MAPD rows whose
  (planId, state, county) isn't in the NBER landscape CSV.
- `update-plan-category.ts` — fast retroactive fill of new Plan Type
  columns on rows imported before those columns existed. ~17 min per
  year (vs 3.5 hrs for a full re-import).
- `fallback-classify.ts` — classifies NULL-category rows from legacy
  `planType` text alone, for plans in NBER landscape but missing from
  `pbp_Section_A.txt`.
- `prepare-pbp.ts` — standalone download + extract of PBP Benefits
  ZIP, no DB ops.
- `verify-plan-category.ts` — read-only sanity check, 15 assertions.
- `seed-admin.ts` — creates the initial admin user.

### Key source files

- `prisma/schema.prisma` — DB schema. New enums: `PlanCategory`,
  `SnpSubtype`, `ChronicCondition`. New Plan columns: `planCategory`,
  `cmsContractType`, `snpSubtype`, `chronicConditions`, `hasPartD`,
  `isZeroDollarDsnp`.
- `app/api/plans/route.ts` — filter API. GET accepts `planCategory`,
  `snpSubtype`, `chronicCondition`, `isZeroDollarDsnp`.
- `app/plan-search.tsx` — main filter UI with Plan Category dropdown.
- `app/plan-detail-modal.tsx` — per-plan detail view.

### Docs (`docs/`)

- `HANDOFF.md` — this file.
- `STATUS-2026-04-21.md` — detailed status from when Item #1 shipped.
- `plan-type-catalog.md` — CMS plan type / SNP subtype code catalog.
- `schema-additions-plan-type.md` — Prisma schema design notes for
  Item #1.

---

## Data safety

NEVER commit to git:
- `.env` (Supabase credentials)
- `.vercel/` (Vercel project link)
- `.cms-import-tmp/` (576MB+ of CMS downloads)
- `node_modules/`

All four are in `.gitignore` already. Don't remove them.

NEVER run without `--dry-run` first, on a fresh session:
- `cleanup-nonshoppable-mapd.ts` (deletes rows)
- `backfill-missing-plans.ts` (inserts rows)

Both support `--dry-run`. Always do the dry run first.

---

## Known quirks

- **NBER landscape lags CMS by 1-2 years.** The `import-cms-data.ts`
  downloader falls back to the prior year if the current isn't
  available and logs a warning. Always run `backfill-missing-plans`
  after `import-cms` to catch the gap.

- **Supabase session pooler hits prepared-statement exhaustion on
  long-running scripts.** All scripts that do bulk writes recycle the
  Prisma client every 50 batches:
  ```typescript
  await prisma.$disconnect();
  prisma = makeClient();
  ```
  Don't remove this pattern — it's what prevents the deterministic
  hang at ~251K rows that bit us on 2026-04-19.

- **~3,486 planIds (across both years) are in NBER but not in
  `pbp_Section_A.txt`.** These are real plans where the carrier
  withdrew and re-filed between the CMS PBP snapshot and the NBER
  snapshot. `fallback-classify.ts` handles them by classifying from
  legacy `planType` text alone. They have `planCategory` and
  `cmsContractType` populated but no `snpSubtype` / chronic conditions
  / $0 DSNP flag (which don't apply to them anyway — they're all
  MAPD / MSA / COST).

---

## How to resume work

If you're a future Claude session picking this up cold:

1. Read this file.
2. Read `/sessions/vibrant-epic-curie/mnt/.claude/CLAUDE.md` for Dale's
   working preferences (end-of-session protocol, tone, git/deploy
   split).
3. Read `docs/STATUS-2026-04-21.md` for the detailed Item #1 audit
   trail if you need technical context on the backfill/cleanup flow.
4. Check the backlog section above. If Dale has brought new data
   files, Item #2 or #3 can start.
5. Don't assume deploy = git push. They're separate (see the workflow
   section).
