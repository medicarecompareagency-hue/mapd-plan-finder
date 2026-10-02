// Default plan year for searches (2026-10-02).
//
// A search with no Plan Year picked shows ONLY this year. This keeps
// planYear=2027 rows (loaded ahead of AEP, before their SB fixes, premium
// backfill, QMB classification and star ratings are done) out of everyday
// results. Flip to 2027 when Dale says so — that is the only edit needed.
export const DEFAULT_PLAN_YEAR = 2026;
