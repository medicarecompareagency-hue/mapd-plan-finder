# SB PDF Pipeline — Handoff

Last touched: 2026-05-14. Branch: `sb-pdf-pipeline`. Do not assume anything below is still true after merging or after time passes — verify with the commands at the bottom.

## TL;DR

- Production is back on **Supabase** after a same-day attempt + rollback.
- Today's swap to Neon succeeded technically (deploy READY, SB PDF links worked, OTC verified amounts surfaced) but **regressed product features**: no DSNP/CSNP plans in results, blank Medicaid Level dropdown, missing PCP/dental/hospital copay enrichment. Customers would have seen a thinner product than before. Rolled back to Supabase the same session.
- Old SB PDF pipeline work is still intact on Neon: 21,468 plans imported, 353 SB PDFs in Vercel Blob, 7,386 plan-county rows tagged with `sbPdfUrl`, 3,075 with `sbVerifiedOtcAmount`. None of this surfaces in prod until parity issues are resolved and prod is re-pointed at Neon.

## Today's swap timeline (2026-05-14)

| Event | Outcome |
|---|---|
| Wired Neon `DATABASE_URL` + `DIRECT_URL` on Vercel (prod + preview) | Deploy READY in 33 s |
| Swap-test AL/Autauga | ✅ H4513-46 rank #1 with `sbPdfUrl` → Vercel Blob PDF (200 OK, 200 KB) |
| Customer browser test FL/Miami-Dade | ❌ Top results lost DSNP plans entirely; Medicaid Level dropdown empty; UI looked thinner than pre-swap |
| Rollback to Supabase | ✅ Deploy READY in 33 s. `Florida@26` login restored. DSNP plans back. `medicaidLevel` populated again (`Coordination Only`, `FIDE`, `HIDE` in filter dropdown) |

## Outstanding work — required before any second swap attempt

1. **Fix the CMS import classifier so DSNP/CSNP plans get properly tagged.** Currently [scripts/import-cms-data.ts](scripts/import-cms-data.ts) classifies everything as `MAPD` or `MA_ONLY` — Neon has 0 DSNP rows out of 21,468. Look at the older Supabase-era enrichment scripts ([scripts/import-dsnp-target-group.js](scripts/import-dsnp-target-group.js), [scripts/enrich-dsnp-fulldual-*.js](scripts/)) — those were doing the planCategory assignment via a separate post-import step that hasn't been run against Neon.
2. **Re-import CMS to Neon with full plan-category coverage.** After fixing #1, drop existing Plan rows for 2026, re-run import. Expect ~21k MAPD + thousands of DSNP/CSNP + ~6k MA_ONLY based on Supabase's distribution.
3. **Backfill `medicaidLevel` on Neon.** Currently NULL for all 21,468 rows. Supabase prod has it populated with values like "Coordination Only", "FIDE (Fully Integrated Dual Eligible)", "HIDE (Highly Integrated Dual Eligible)" — those drive the DSNP filter dropdown.
4. **Run the `enrich-*` scripts against Neon to restore the rest of the enrichment.** [scripts/enrich-ma-only-from-pbp.js](scripts/), [scripts/enrich-plan-copays-from-pbp.js](scripts/), [scripts/enrich-ssbci-benefits.js](scripts/), [scripts/enrich-dsnp-fulldual-coins-as-zero.js](scripts/), etc. Supabase has these all populated; Neon doesn't. Without them PCP copays, dental amounts, hospital copays, transportation, and SSBCI fields stay blank.
5. **Re-run the SB pipeline against the newly-imported DSNP plans.** Cost estimate: a few hundred more SerpAPI calls (target carriers' DSNP variants). Easily fits the Developer plan budget (3,888 left of 5,000 this month).
6. **Patch [scripts/extract-sb-benefits.ts](scripts/extract-sb-benefits.ts) for combined OTC+Food+Utilities allowance phrasing.** Confirmed irrelevant for the 357 MAPD/MA_ONLY PDFs we already have (scanned all of them, 0 had combined phrasing). Becomes load-bearing once DSNP SB PDFs land — that's where "$X allowance combined for OTC, Healthy Food, and Utilities" lives.
7. **Build a parity check script before any second swap.** Required output: row counts by `planCategory`, distinct `medicaidLevel` values, distinct `planType` values, distinct organizations, and filter-dropdown contents (POST `/api/plans` with no state) between Supabase and Neon. Hard rule: parity check must pass before flipping `DATABASE_URL` again.

## Lessons learned (don't repeat)

- **Test data parity BEFORE swapping prod.** Today we tested the SB PDF flow worked on the new DB, but never checked that the OLD prod features still worked on the new DB. The bug found in customer browser testing (missing DSNP, blank Medicaid Level) was visible from a single FL/Miami-Dade query against Neon — would have caught it pre-swap with one curl.
- **Seed admin password into the target DB BEFORE the swap.** Neon's admin row had the seed default `Admin2024!`, not the Supabase-era `Florida@26` the customer was using. The swap forces a password reset window unless the prod-equivalent password is preloaded. Future plan: clone the User row from Supabase (or capture the bcrypt hash) and write it into Neon directly so login is seamless on day-of-swap.
- **Capture the old `DATABASE_URL` OUTSIDE Vercel before deletion.** Sensitive env vars don't decrypt via `vercel env pull` — the pulled file shows `DATABASE_URL=""`. Once you delete the sensitive var via API, the value is gone unless you wrote it down. Rollback today only worked because you had the Supabase URL in another window. Make this a checklist item.

## SB PDF pipeline state (on Neon, dormant in prod)

| Area | Value |
|---|---|
| Vercel Blob storage used | 398.68 MiB / 1 GB |
| Unique SB PDFs uploaded | 353 (at `2026/sb-pdfs/<filename>.pdf` — shared path scheme, deduped) |
| Plan-county rows with `sbPdfUrl` | 7,386 (covering 355 distinct planIds out of 384 target) |
| Plan-county rows with `sbVerifiedOtcAmount` | 3,075 (across 143 planIds) |
| Plan-county rows with `sbVerifiedFoodAmount` | 24 — almost no MAPD plans offer separate Food Card; the Food benefit lives in DSNP plans we don't have |
| Unresolved (`sb-unresolved-plans.json`) | 5 UnitedHealthcare AARP variants, all sub-threshold confidence |

## Working pipeline (on Neon)

| Area | Status |
|---|---|
| Neon DB connected (Vercel Storage, store `neon-cinereous-ocean`) | ✓ |
| Prisma schema synced to Neon (`prisma db push`) | ✓ — Plan, GeoLocation, User, PasswordReset, Search + enums |
| CMS 2026 import to Neon | ✓ 21,468 plans (fast-path) — but no DSNP/CSNP, no medicaidLevel, no enrichment |
| Admin user seeded into Neon | ✓ password `Admin2024!` (NOT `Florida@26`) |
| `npm run acquire-sb-pdfs` | ✓ full 384-target run completed (1,112 SerpAPI calls; 379/384 resolved) |
| `npm run download-sb-pdfs` | ✓ |
| `npm run discover-sb-pdfs` | ✓ |
| `npm run upload-sb-pdfs` (Vercel Blob, shared-path scheme) | ✓ |
| `npm run upload-sb-pdfs -- --dry-run` (no creds needed) | ✓ |
| `npx tsx scripts/extract-sb-benefits.ts --update-db` | ✓ |
| Shared env loader for scripts (`.env.local` + `.env`) | ✓ [scripts/load-env.ts](scripts/load-env.ts) |
| Cleanup script for old per-planId blobs | ✓ [scripts/cleanup-old-sb-blobs.ts](scripts/cleanup-old-sb-blobs.ts) |
| Frontend SB-badge link | ✓ deployed in prod; falls back to medicare.gov when `sbPdfUrl` is null |

## Where things live

### Env files

| File | What's in it | Loaded by |
|---|---|---|
| `.env` (gitignored) | `DATABASE_URL` (Neon pooled), `DIRECT_URL` (Neon unpooled), `SERPAPI_API_KEY`, `ADMIN_PASSWORD`, `SESSION_SECRET`, `SMTP_*`, `APP_URL` | Prisma auto-loads; scripts via [scripts/load-env.ts](scripts/load-env.ts) |
| `.env.local` (gitignored) | `BLOB_READ_WRITE_TOKEN`, 18 `NEON_*` vars, `VERCEL_OIDC_TOKEN`, `CMS_DATA_YEAR`, `NEXTAUTH_URL`, `SMTP_*` | Scripts that `import "./load-env"` |
| `.env.prod.backup` (gitignored) | Captured from prod before today's swap. **Note:** `DATABASE_URL=""` empty because sensitive vars don't decrypt. Useful only for non-sensitive var states. |

Precedence (top wins): shell-exported → `.env.local` → `.env`.

### Vercel Storage stores

- **Neon Postgres** — store id `store_SX7Ihm9lEnOLUr4q`, name `neon-cinereous-ocean`, connected to project with prefix `NEON`. Currently dormant in prod (rolled back to Supabase). 21,468 plans + SB pipeline data live here.
- **Vercel Blob** — provides `BLOB_READ_WRITE_TOKEN`. Public host: `https://cqqxtzauqu7qz7ey.public.blob.vercel-storage.com/`. 353 PDFs live here.

### Vercel env vars (production, as of rollback)

- `DATABASE_URL` (sensitive) → **Supabase pooler** at `aws-1-us-west-2.pooler.supabase.com:6543`
- No `DIRECT_URL`. **Schema still references `directUrl = env("DIRECT_URL")`** in `prisma/schema.prisma` — runtime queries work without it, but `prisma migrate` / `prisma db push` against prod will fail until either DIRECT_URL is set or the schema line removed.
- 18 `NEON_*` vars (left in place; harmless).

### Intermediate files

- `sb-download-list.json` — output of `acquire-sb-pdfs`, input to `download-sb-pdfs`.
- `sb-unresolved-plans.json` — plans `acquire-sb-pdfs` couldn't find URLs for (5 entries).
- `sb-discovery-results.json` — output of `discover-sb-pdfs`, input to `upload-sb-pdfs` (353 entries).
- `sb-benefit-extraction-results.json` — output of `extract-sb-benefits` (353 entries).
- `summary-of-benefits/` (gitignored) — downloaded PDFs on disk.

All gitignored, all `.vercelignore`'d.

## Test plans (uploaded PDFs available on Neon; dormant in prod)

After re-pointing to Neon, these will surface in the top 5 with `sbPdfUrl` populated. Until then, all `sbPdfUrl` show null in prod and the UI falls back to medicare.gov.

| State | County | planId | Carrier |
|---|---|---|---|
| AL | Autauga | H4513-46 | HealthSpring |
| AL | Baldwin | H4513-46 | HealthSpring |
| AL | Barbour | H5521-91 | Aetna Medicare |
| AL | Bibb | H4513-46 | HealthSpring |
| AL | Blount | H4513-46 | HealthSpring |

(78.9% of all licensed-state counties have at least one top-5 plan with `sbPdfUrl` — the dataset is broadly testable once active.)

## Gotchas

- **PowerShell variable interpolation:** `node -e "...p.$disconnect()..."` becomes `p.()` because PowerShell eats `$disconnect`. Use single quotes around the script body, or escape with backtick.
- **Neon port 6543 vs 5432:** Pooler (6543) is for runtime queries. DDL ops (`prisma db push`) need the direct connection on 5432. `DIRECT_URL` in local `.env` already points there.
- **Vercel function 10s timeout (production):** `/api/plans` POST without a `state` filter would scan the full Plan table. Guarded already.
- **`upload-sb-pdfs --storage=supabase` still exists** but is not the default; default is Vercel Blob. Requires `BLOB_READ_WRITE_TOKEN`.
- **Adopt the env loader in new scripts:** `import "./load-env";` as the FIRST import. Without it, `.env.local` vars are invisible.
- **Schema references `DIRECT_URL`** (`prisma/schema.prisma:11`). When prod has no DIRECT_URL set, runtime is fine but `prisma migrate` fails.
- **Sensitive Vercel env vars don't decrypt via CLI/API.** `vercel env pull` returns `KEY=""` for them. Don't rely on this for backup of secret values.

## Commands cheat sheet

```bash
# Verify DB connection
npx prisma db pull

# Reset / re-push schema (Neon)
npx prisma db push

# Plan count
node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.plan.count().then(c=>console.log('Plans:',c)).finally(()=>p.\$disconnect())"

# Re-import CMS (fast-path if year is empty)
npx tsx scripts/import-cms-data.ts --year 2026

# SB pipeline (uses SerpAPI quota — Developer plan, ~3,888 left this month)
npm run acquire-sb-pdfs
npm run download-sb-pdfs
npm run discover-sb-pdfs
npm run upload-sb-pdfs

# Pull fresh env from Vercel after changes in dashboard
vercel env pull .env.local --environment=development --yes
```

## SerpAPI budget

- Plan: **Developer ($75/mo, 5,000 searches)**.
- Used this month: **1,112** (smoke + full 384-plan acquire run).
- Remaining: **~3,888**.
- Full DSNP re-acquire after fixing #1-2 will likely cost an additional few hundred to ~1,000 calls. Fits comfortably.
