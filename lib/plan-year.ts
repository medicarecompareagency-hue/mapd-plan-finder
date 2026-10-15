// Default plan year for searches.
//
// A search with no Plan Year picked shows ONLY this year. Flipped 2026 -> 2027
// on 2026-10-15 (AEP day 1) on Dale's say-so: 2027 rows have their SB links
// (2,016 / 2,026 plan-segments), premiums, QMB classification, SB benefits and
// 2027 Star Ratings. 2026 stays selectable in the Plan Year dropdown.
// Changing this constant is the only edit needed to move the default year.
export const DEFAULT_PLAN_YEAR = 2027;
