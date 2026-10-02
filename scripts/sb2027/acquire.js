// scripts/sb2027/acquire.js — 2027 Summary-of-Benefits acquisition (STAGING ONLY — no DB writes).
//
//   node scripts/sb2027/acquire.js --carrier "HealthSpring" [--budget 150] [--conc 6] [--retry] [--only H0439-2]
//
// For each 2027 plan-segment in .cms-import-tmp/sb-2027/plans.json (built by build-plan-list.js):
//   resolver(carrier) -> candidate URLs -> download -> STRICT validate (plan ID + "Summary of Benefits" + 2027)
//   -> upload to Vercel Blob at sb/2027/<planId>[-s<seg>].pdf -> record in scripts/data/sb-links-2027.json.
// Resumable: finished keys are skipped; failures are recorded in .cms-import-tmp/sb-2027/state.json
// and skipped unless --retry. Stops cleanly when the time budget is used (run again to continue).
// The manifest is applied to planYear=2027 rows AFTER the CMS import by scripts/sb2027/apply-links.js.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { put } = require('@vercel/blob');
const { classify } = require('./validate');
const resolvers = require('./resolvers');
const ROOT = path.join(__dirname, '..', '..');
for (const envFile of ['.env', '.env.local']) {
  try { for (const l of fs.readFileSync(path.join(ROOT, envFile), 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n\r]*)"?\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; } } catch {}
}
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes('--' + n);
const CARRIER = arg('carrier'), BUDGET = parseInt(arg('budget', '150'), 10) * 1000, CONC = parseInt(arg('conc', '6'), 10);
const ONLY = arg('only'), RETRY = has('retry'), NOUPLOAD = has('no-upload');
const WORK = path.join(ROOT, '.cms-import-tmp', 'sb-2027');
const PLANS = path.join(WORK, 'plans.json'), STATE = path.join(WORK, 'state.json'), PDFDIR = path.join(WORK, 'pdf');
const MANIFEST = path.join(ROOT, 'scripts', 'data', 'sb-links-2027.json');
fs.mkdirSync(PDFDIR, { recursive: true });
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const writeJson = (p, o) => { const t = p + '.tmp' + process.pid; fs.writeFileSync(t, JSON.stringify(o, null, 1)); fs.renameSync(t, p); };
// Merge-safe save: several carriers may run at once, so never write a stale whole-file copy.
// Under a mkdir lock: re-read from disk, apply only THIS run's changes, write back.
const LOCK = path.join(require('os').tmpdir(), 'sb2027.lock');   // NOT inside the repo mount: deletes are blocked there, so a lock dir could never be released
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function withLock(fn) {
  for (let i = 0; i < 600; i++) { try { fs.mkdirSync(LOCK); break; } catch { try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 4000) fs.rmdirSync(LOCK); } catch {} sleepMs(100); } }
  try { return fn(); } finally { try { fs.rmdirSync(LOCK); } catch {} }
}
const myGood = {}, myBad = {};
function saveAll() {
  withLock(() => {
    const m = readJson(MANIFEST, {}), st = readJson(STATE, {});
    for (const [k, v] of Object.entries(myGood)) { m[k] = v; delete st[k]; }
    for (const [k, v] of Object.entries(myBad)) if (!m[k] || !myGood[k]) { if (!myGood[k]) st[k] = v; }
    writeJson(MANIFEST, m); writeJson(STATE, st);
    Object.assign(manifest, m);
  });
}
const plans = readJson(PLANS, []);
const manifest = readJson(MANIFEST, {});
const state = readJson(STATE, {});
const hints = readJson(path.join(ROOT, 'scripts', 'data', 'sb-url-hints-2027.json'), {});
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
async function fetchBuf(url) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 45000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/pdf,*/*' }, redirect: 'follow', signal: ctl.signal });
    if (!r.ok) return { err: 'http_' + r.status };
    return { buf: Buffer.from(await r.arrayBuffer()), finalUrl: r.url };
  } catch (e) { return { err: 'fetch_' + (e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.code || e.message)) }; }
  finally { clearTimeout(t); }
}
const blobName = (e) => 'sb/2027/' + e.planId + (e.seg !== '0' ? '-s' + e.seg : '') + '.pdf';
async function doOne(e) {
  const resolver = resolvers[e.carrier];
  if (!resolver) return { ok: false, reason: 'no_resolver' };
  let cands;
  try { cands = await resolver(e, { fetchBuf, UA }); } catch (er) { return { ok: false, reason: 'resolver_error(' + er.message + ')' }; }
  cands = [...(hints[e.key] || []), ...(cands || [])];   // hand-found / sweep-found URLs first (still strict-validated)
  if (!cands || !cands.length) return { ok: false, reason: 'no_candidates' };
  const reasons = [];
  for (const url of cands) {
    const r = await fetchBuf(url);
    if (r.err) { reasons.push(r.err); continue; }
    const v = classify(e, r.buf, 2027);
    if (!v.ok) { reasons.push(v.reason); continue; }
    const sha = crypto.createHash('sha256').update(r.buf).digest('hex');
    fs.writeFileSync(path.join(PDFDIR, e.key + '.pdf'), r.buf);
    let blobUrl = null;
    if (!NOUPLOAD) {
      try { blobUrl = (await put(blobName(e), new Blob([r.buf]), { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/pdf' })).url; }
      catch (er) { return { ok: false, reason: 'blob_upload(' + er.message.slice(0, 80) + ')' }; }
    }
    return { ok: true, rec: { planId: e.planId, contract: e.contract, plan3: e.plan3, seg: e.seg, carrier: e.carrier, sourceUrl: url, blobUrl, sha256: sha, bytes: r.buf.length, segVerified: v.segVerified, validatedAt: new Date().toISOString() } };
  }
  return { ok: false, reason: [...new Set(reasons)].join(',') || 'all_candidates_failed' };
}
(async () => {
  const t0 = Date.now();
  let todo = plans.filter(e => (!CARRIER || e.carrier === CARRIER) && (!ONLY || e.planId === ONLY));
  todo = todo.filter(e => !manifest[e.key] && (RETRY || ONLY || !state[e.key]));
  console.log(`worklist ${todo.length} (carrier=${CARRIER || 'ALL'}, retry=${RETRY})`);
  let i = 0, good = 0, bad = 0, stopped = false;
  async function worker() {
    while (i < todo.length) {
      if (Date.now() - t0 > BUDGET) { stopped = true; return; }
      const e = todo[i++];
      const r = await doOne(e);
      if (r.ok) { manifest[e.key] = r.rec; myGood[e.key] = r.rec; delete state[e.key]; good++; }
      else { state[e.key] = { reason: r.reason, tries: ((state[e.key] || {}).tries || 0) + 1, at: new Date().toISOString() }; myBad[e.key] = state[e.key]; bad++; if (ONLY) console.log('BAD', e.key, r.reason); }
      if ((good + bad) % 10 === 0) { saveAll(); console.log(`  progress: good ${good} bad ${bad} of ${todo.length}`); }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  saveAll();
  const left = todo.length - good - bad;
  console.log(`done this run: GOOD ${good}, BAD ${bad}, not reached ${left}${stopped ? ' (time budget hit — run again)' : ''}`);
  const tot = plans.filter(e => !CARRIER || e.carrier === CARRIER);
  console.log(`coverage ${CARRIER || 'ALL'}: ${tot.filter(e => manifest[e.key]).length}/${tot.length} plan-segments staged`);
  const rs = {}; for (const e of tot) if (!manifest[e.key] && state[e.key]) rs[state[e.key].reason] = (rs[state[e.key].reason] || 0) + 1;
  if (Object.keys(rs).length) console.log('open failures by reason:', JSON.stringify(rs));
})().catch(e => { console.error(e); process.exit(1); });
