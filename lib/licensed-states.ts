// lib/licensed-states.ts
// Canonical list of 2-letter state codes where Dale's agency is licensed.
// Used by the client to filter the state dropdown in app/plan-search.tsx.
//
// Keep in sync with scripts/licensed-states.js (the Node/CommonJS version
// used by CLI scripts like cleanup-nonlicensed-states.js).
//
// When Dale gains a new state license: update BOTH files.

export const LICENSED_STATES = [
  "AL", "AR", "FL", "GA", "IL", "IN", "KS", "KY",
  "LA", "MO", "MS", "OH", "OK", "SC", "TN", "TX",
  "VA", "WV",
] as const;
