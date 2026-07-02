@AGENTS.md

# Persistent memory — latest handoff
Most recent session: **2026-07-02** — full record in `HANDOFF-2026-07-02.md`. Prior: `HANDOFF-2026-06-30.md`.

- **Tier 6 audit — DONE (2026-07-02).** 295 T6=$0 plans confirmed vs. PBP ("Select Care Drugs"). Zero data fixes. LIS lesser-of bug fixed in `drugTierCellQ` (`app/plan-search.tsx`): prior code showed flat LIS copay; fix applies `min(rawValue, lisV)`. Commit `67346c9`, deployed. Audit record: `scripts/data/tier6-audit-2026-07.json`.
- **Humana Healthy Options sweep — DONE (2026-07-02).** 24 plans newly filled via `fill-humana-healthy-options.js` → `sbVerifiedFoodAmount` (annualized, 1059 county rows). 104 already filled from prior session. 10 confirmed no-wallet (4 Humana Dual Fully Integrated, 6 genuinely no food section). Write target: `sbVerifiedFoodAmount`, NOT `foodCardAllowance` — `effectiveFoodCard()` and `effectiveOtc()` both read it for Humana. Durability: `scripts/reapply-humana-wallet-fills.js` + `scripts/data/humana-wallet-fills-2026.json`, wired into `reapply-sb-truth.js`. No deploy needed (data-only).
- **Humana wallet sample-check — DONE (2026-07-02, read-only).** See above; sweep complete.
- **HealthSpring wallet sample-check — DONE (2026-07-02, read-only).** HealthSpring Flex Card = OTC-only ($225/qtr already in DB as `otcAllowance`). No food/grocery benefit. **$0 food is legitimate — HealthSpring food backlog CLOSED.**
- **Segment-aware SB fix — DONE & deployed (2026-06-30).** `Plan.segmentId` + `Plan.sbSegmentId`; 91/91 segments linked; gate live. Re-import note: must re-run `backfill-segment-ids.js` + re-apply segment SB links after any CMS re-import.
  - **The plan/county membership was CORRECT** — do NOT "fix" segment-SB issues by removing plans from counties.
- **Food/OTC next priority:** UHC unswept families (~43 plans: H0251, H2385, H2445, H2509, H2802, H3256, H5008), then Wellcare, Devoted tail. Humana CLOSED. HealthSpring CLOSED.
- DB is **Neon** (older notes say Supabase — stale). `makePrisma()` appends `?pgbouncer=true`.
