// scripts/sb2027/serp-sweep.js — look for 2027 SBs the carrier resolvers could not find, via SerpApi (Google).
//
//   node scripts/sb2027/serp-sweep.js [--budget 120] [--conc 5] [--only H1416-081-0] [--redo]
//
// For every plan-segment still failing in .cms-import-tmp/sb-2027/state.json: run 2 Google queries, keep PDF links on
// carrier / mirror hosts, and add them to scripts/data/sb-url-hints-2027.json. It downloads nothing and writes no DB rows:
// `acquire.js --retry` then tries each hint through the STRICT validator. Resumable (progress in sb-2027/serp.json).
// Key: SERPAPI_API_KEY in .env.local. About 2 searches per plan-segment.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
for (const envFile of ['.env', '.env.local']) {
  try { for (const l of fs.readFileSync(path.join(ROOT, envFile), 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n\r]*)"?\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; } } catch {}
}
const KEY = process.env.SERPAPI_API_KEY || process.env.SERPAPI_KEY;
if (!KEY) { console.error('SERPAPI_API_KEY missing from .env.local'); process.exit(2); }
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const BUDGET = parseInt(arg('budget', '120'), 10) * 1000, CONC = parseInt(arg('conc', '5'), 10), ONLY = arg('only'), REDO = process.argv.includes('--redo');
const WORK = path.join(ROOT, '.cms-import-tmp', 'sb-2027');
const HINTS = path.join(ROOT, 'scripts', 'data', 'sb-url-hints-2027.json'), PROG = path.join(WORK, 'serp.json');
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const ALLOW = /(^|\.)(content\.medicareadvantage\.com|healthspring\.com|aetna\.com|aetnabetterhealth\.com|devoted\.com|wellcare\.com|[a-z]+healthplan\.com|absolutetotalcare\.com|mhsindiana\.com|homestatehealth\.com|arhealthwellness\.com|ilmeridian\.com|uhc\.com|aarpmedicareplans\.com|uhccommunityplan\.com|humana\.com|contentserver\.destinationrx\.com)$/i;
const host = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
let searches = 0;
async function serp(q) {
  searches++;
  const r = await fetch('https://serpapi.com/search.json?engine=google&num=10&q=' + encodeURIComponent(q) + '&api_key=' + KEY, { signal: AbortSignal.timeout(40000) });
  if (!r.ok) throw new Error('serpapi_' + r.status);
  const j = await r.json();
  return (j.organic_results || []).map((o) => ({ link: o.link, title: o.title || '' })).filter((o) => o.link);
}
(async () => {
  const t0 = Date.now();
  const plans = readJson(path.join(WORK, 'plans.json'), []), state = readJson(path.join(WORK, 'state.json'), {});
  const hints = readJson(HINTS, {}), prog = readJson(PROG, {});
  const todo = plans.filter((e) => state[e.key] && (!ONLY || e.key === ONLY) && (REDO || ONLY || !prog[e.key]));
  console.log(`to search: ${todo.length} plan-segments`);
  let i = 0, withHits = 0;
  async function worker() {
    while (i < todo.length && Date.now() - t0 < BUDGET) {
      const e = todo[i++];
      const s3 = String(e.seg).padStart(3, '0'), dash = e.contract + '-' + e.plan3, run = e.contract + e.plan3 + s3;
      const qs = ['"' + dash + '" 2027 "Summary of Benefits" filetype:pdf', '"' + run + '" OR "' + e.contract + '_' + e.plan3 + '" 2027 SB filetype:pdf'];
      const found = [], seen = [];
      try {
        for (const q of qs) {
          for (const o of await serp(q)) {
            seen.push(o.link);
            const u = o.link, isDoc = /\.(pdf|ashx)($|\?)/i.test(u) || /\/alphadog\//i.test(u);
            if (!isDoc || !ALLOW.test(host(u))) continue;
            if (!/2027|[^0-9]27[^0-9]|SB27|_27_/i.test(u + ' ' + o.title)) continue;   // skip links that are plainly another year
            if (!found.includes(u)) found.push(u);
          }
        }
        prog[e.key] = { at: new Date().toISOString(), found, seen: seen.length };
      } catch (er) { prog[e.key] = undefined; console.log('ERR', e.key, er.message); continue; }
      if (found.length) { withHits++; hints[e.key] = [...new Set([...(hints[e.key] || []), ...found])]; console.log('HIT', e.key, found.join(' , ')); }
      if (i % 10 === 0) { fs.writeFileSync(PROG, JSON.stringify(prog, null, 1)); fs.writeFileSync(HINTS, JSON.stringify(hints, null, 1)); }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  fs.writeFileSync(PROG, JSON.stringify(prog, null, 1)); fs.writeFileSync(HINTS, JSON.stringify(hints, null, 1));
  const left = plans.filter((e) => state[e.key] && !prog[e.key]).length;
  console.log(`searches used ${searches}; plan-segments with candidate links this run: ${withHits}; not yet searched: ${left}`);
})().catch((e) => { console.error(e); process.exit(1); });
