// =============================================================================
// BROWSER-INJECTION SNIPPET — NOT a node script.
// Paste this into the JS console of an authenticated medicare.gov tab.
// =============================================================================
// Lives in repo at scripts/browser/loop-v2-medicaid-level.js for reference.
//
// Prereqs in the same tab (set up by the v1 kickoff snippet):
//   - window.DSNP_PLANS      = [[planId, contract, plan, segment], ...]
//   - window.DSNP_RESULTS    = { planId -> "FIDE"|"HIDE"|"CO"|"AIP"|null|{__error} }
//
// What this does: re-runs only plans whose DSNP_RESULTS entry is missing or marks
// an error/exception. Uses 1500ms throttle (vs v1's 800ms). Detects 'Failed to
// fetch' (silent 503/rate-limit) and backs off — 15s after each fail, 2 min
// after 3 consecutive fails. Up to 3 attempts per plan.
//
// Why the v1 retry didn't catch the rate limit: v1 only retried on HTTP 503/429
// status codes, but medicare.gov's edge proxy returns the rate limit as a
// network-level failure that surfaces in fetch() as a thrown TypeError, not a
// status code. v2 catches both paths.
// =============================================================================


window.DSNP_RUNNER_V2 = (async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const NEEDS_RETRY = (v) => v === undefined || (v && typeof v === 'object' && v.__error);

  const todo = window.DSNP_PLANS.filter(([planId]) => NEEDS_RETRY(window.DSNP_RESULTS[planId]));
  window.DSNP_PROGRESS_V2 = {
    done: 0,
    total: todo.length,
    errors: [],
    status: 'starting',
    last_planId: null,
    started_at: Date.now(),
    last_status: null,
    consecutive_failures: 0,
  };

  let consecutiveFails = 0;

  for (const [planId, contract, plan, segment] of todo) {
    let success = false;
    let lastStatus = null;
    let lastError = null;

    // Up to 3 attempts per plan, with backoff on Failed-to-fetch
    for (let attempt = 0; attempt < 3 && !success; attempt++) {
      try {
        const r = await fetch(`/api/v1/data/plan-compare/plan/2026/${contract}/${plan}/${segment}`, {
          credentials: 'same-origin',
          headers: { 'Fe-Ver': '2.69.0', 'Accept': 'application/json' }
        });
        lastStatus = r.status;
        if (r.status === 503 || r.status === 429) {
          // soft throttle — long sleep then retry this plan
          await sleep(60000);
          continue;
        }
        if (r.ok) {
          const j = await r.json();
          window.DSNP_RESULTS[planId] = j.plan_card ? (j.plan_card.dsnp_integration_level || null) : null;
          success = true;
          consecutiveFails = 0;
        } else {
          // 4xx — record and move on
          window.DSNP_RESULTS[planId] = { __error: r.status };
          break;
        }
      } catch (e) {
        lastError = String(e);
        consecutiveFails++;
        // Failed-to-fetch = rate limit. Long pause then verify.
        if (consecutiveFails >= 3) {
          window.DSNP_PROGRESS_V2.status = 'rate_limited_pausing';
          await sleep(120000); // 2 min
          consecutiveFails = 0;
        } else {
          await sleep(15000); // 15 sec
        }
      }
    }

    if (!success && !window.DSNP_RESULTS[planId]) {
      window.DSNP_RESULTS[planId] = { __error: 'exception_after_retries' };
      window.DSNP_PROGRESS_V2.errors.push({ planId, lastStatus, lastError, t: Date.now() });
    }

    window.DSNP_PROGRESS_V2.done++;
    window.DSNP_PROGRESS_V2.last_planId = planId;
    window.DSNP_PROGRESS_V2.last_status = lastStatus;
    window.DSNP_PROGRESS_V2.consecutive_failures = consecutiveFails;
    window.DSNP_PROGRESS_V2.status = 'running';
    await sleep(1500);
  }

  window.DSNP_PROGRESS_V2.status = 'done';
  window.DSNP_PROGRESS_V2.finished_at = Date.now();
})();

({ kicked_off_v2: true, todo_count: window.DSNP_PROGRESS_V2.total })
