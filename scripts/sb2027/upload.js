// scripts/sb2027/upload.js — upload staged-but-not-uploaded 2027 SB PDFs to Vercel Blob.
//   node scripts/sb2027/upload.js [--budget 150] [--conc 3] [--carrier Humana]
// acquire.js --no-upload validates and caches PDFs locally (.cms-import-tmp/sb-2027/pdf/<key>.pdf) and records
// blobUrl:null. This pass uploads those files (sha256-checked against the manifest) to sb/2027/ and fills blobUrl.
// Resumable and merge-safe (re-reads the manifest under the same lock as acquire.js).
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { put } = require('@vercel/blob');
const ROOT = path.join(__dirname, '..', '..');
for (const envFile of ['.env', '.env.local']) {
  try { for (const l of fs.readFileSync(path.join(ROOT, envFile), 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n\r]*)"?\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; } } catch {}
}
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const BUDGET = parseInt(arg('budget', '150'), 10) * 1000, CONC = parseInt(arg('conc', '3'), 10), CARRIER = arg('carrier');
const WORK = path.join(ROOT, '.cms-import-tmp', 'sb-2027'), PDFDIR = path.join(WORK, 'pdf'), LOCK = path.join(require('os').tmpdir(), 'sb2027.lock');
const MANIFEST = path.join(ROOT, 'scripts', 'data', 'sb-links-2027.json');
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function withLock(fn) {
  for (let i = 0; i < 600; i++) { try { fs.mkdirSync(LOCK); break; } catch { try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 4000) fs.rmdirSync(LOCK); } catch {} sleepMs(100); } }
  try { return fn(); } finally { try { fs.rmdirSync(LOCK); } catch {} }
}
const mine = {};
function save() { withLock(() => { const m = readJson(MANIFEST, {}); for (const [k, u] of Object.entries(mine)) if (m[k]) m[k].blobUrl = u; const t = MANIFEST + '.tmp' + process.pid; fs.writeFileSync(t, JSON.stringify(m, null, 1)); fs.renameSync(t, MANIFEST); }); }
(async () => {
  const t0 = Date.now(); const m = readJson(MANIFEST, {});
  const todo = Object.entries(m).filter(([k, v]) => !v.blobUrl && (!CARRIER || v.carrier === CARRIER));
  console.log('to upload:', todo.length);
  let i = 0, ok = 0, bad = 0;
  async function worker() {
    while (i < todo.length && Date.now() - t0 < BUDGET) {
      const [k, v] = todo[i++]; const f = path.join(PDFDIR, k + '.pdf');
      try {
        const buf = fs.readFileSync(f);
        if (crypto.createHash('sha256').update(buf).digest('hex') !== v.sha256) throw new Error('sha_mismatch');
        const name = 'sb/2027/' + v.planId + (v.seg !== '0' ? '-s' + v.seg : '') + '.pdf';
        mine[k] = (await put(name, new Blob([buf]), { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/pdf' })).url; ok++;
      } catch (e) { bad++; console.log('FAIL', k, String(e.message).slice(0, 100)); }
      if ((ok + bad) % 10 === 0) { save(); console.log(`  progress: uploaded ${ok}, failed ${bad}, of ${todo.length}`); }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  save();
  console.log(`uploaded ${ok}, failed ${bad}, remaining ${todo.length - ok}`);
})().catch(e => { console.error(e); process.exit(1); });
