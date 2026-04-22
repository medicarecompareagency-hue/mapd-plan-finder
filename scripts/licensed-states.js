// scripts/licensed-states.js
// Canonical list of 2-letter state codes where Dale's agency is licensed.
// Used by cleanup-nonlicensed-states.js and (future) CMS landscape import
// script to gate which state data we keep or ingest.
//
// IMPORTANT: When Dale gains a new state license, update this list AND
// re-run the CMS landscape import for that state (not just the cleanup).

module.exports = {
  LICENSED_STATES: [
    "AL", "AR", "FL", "GA", "IL", "IN", "KS", "KY",
    "LA", "MO", "MS", "OH", "OK", "SC", "TN", "TX",
    "VA", "WV",
  ],
};
