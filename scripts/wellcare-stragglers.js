// Fix Wellcare stragglers that were missed due to wrong state or out-of-range docnums
// Uses per-plan state lookup and extended docnum range
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { put } = require('@vercel/blob');
const { makePrisma } = require('./prisma-client');
const { classify, pdftext, idVariants } = require('./ingest-sb-url');

for (const envFile of ['.env', '.env.local']) {
  const p = path.join(__dirname, '..', envFile);
  try { const c = fs.readFileSync(p, 'utf8'); for (const l of c.split(/\r?\n/)) { const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n\r]*)"?\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; } } catch {}
}

function parseCsv(line) { return (line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)||[]).map(s=>s.replace(/,$/,'').replace(/^"|"$/g,'').replace(/""/g,'"')); }
function getWellcareUnresolved() {
  const prog = JSON.parse(fs.readFileSync('sb-rediscovery-progress.json', 'utf8'));
  const rows = fs.readFileSync('sb-unresolved.csv', 'utf8').trim().split(/\r?\n/);
  return rows.slice(1).map(l => { const f = parseCsv(l); return { planId: f[0], org: f[1] }; })
    .filter(p => /wellcare|centene|ohana|trillium|health net|fidelis/i.test(p.org) && prog[p.planId] !== 'GOOD');
}

function buildUrls(contract, state, num) {
  const h = contract.toLowerCase(), st = state.toLowerCase(), ST = state.toUpperCase();
  const TYPES = ['hmapd', 'dsnp', 'hmo', 'hmopos', 'ppo', 'pffs', 'lppo', 'cmapd'];
  const urls = [];
  for (const ty of TYPES) {
    urls.push(`https://www.wellcare.com/-/media/pdfs/medicare-2026/sb/${h}_2026_${st}_sb_${ty}_${num}eng_m.ashx`);
    if (ST === 'OK') urls.push(`https://www.wellcareok.com/content/dam/centene/medicare/pdfs/aep/2026/sb/${h.toUpperCase()}_2026_OK_SB_${ty.toUpperCase()}_${num}ENG_M.pdf`);
  }
  return [...new Set(urls)];
}

async function probeBatch(urls) {
  return Promise.all(urls.map(url =>
    fetch(url, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000), redirect: 'follow' })
      .then(r => r.ok ? url : null).catch(() => null)
  ));
}

async function downloadPdf(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, signal: AbortSignal.timeout(30000), redirect: 'follow' });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.slice(0, 5).toString() === '%PDF-' ? buf : null;
  } catch { return null; }
}

// Extended range: 4626000-4628000 for stragglers
const DOC_START = 4626000;
const DOC_END   = 4628000;

(async () => {
  const prisma = makePrisma();
  const plans = getWellcareUnresolved();
  const prog = JSON.parse(fs.readFileSync('sb-rediscovery-progress.json', 'utf8'));
  console.log('Wellcare stragglers to fix:', plans.length);

  let totalFound = 0;

  for (const { planId, org } of plans) {
    if (prog[planId] === 'GOOD') continue;
    const contract = planId.split('-')[0];

    // Get THIS PLAN's state (not the contract state)
    const dbRows = await prisma.plan.findMany({
      where: { planYear: 2026, planId },
      select: { state: true },
      take: 1,
    });
    const state = dbRows[0]?.state;
    if (!state) { console.log(`SKIP ${planId}: no state`); continue; }

    console.log(`\nSearching ${planId} (${state})...`);
    let found = false;

    for (let num = DOC_START; num <= DOC_END && !found; num++) {
      const urls = buildUrls(contract, state, num);
      const hits = (await probeBatch(urls)).filter(Boolean);
      if (hits.length === 0) continue;

      for (const hitUrl of hits) {
        process.stdout.write(`  num=${num} url=...${hitUrl.slice(-50)}... `);
        const buf = await downloadPdf(hitUrl);
        if (!buf) { process.stdout.write('not PDF\n'); continue; }
        const txt = pdftext(buf);

        const variants = idVariants(planId);
        const hay = txt.replace(/[\s\-|]/g, '').toUpperCase();
        const inPdf = variants.some(v => hay.includes(v.replace(/[\s\-|]/g, '').toUpperCase()));
        if (!inPdf) { process.stdout.write('planid_missing\n'); continue; }

        const [v, reason] = classify(planId, buf, txt);
        if (v !== 'GOOD') { process.stdout.write(`FAIL: ${reason}\n`); continue; }

        const sha = crypto.createHash('sha256').update(buf).digest('hex');
        try {
          const blobUrl = (await put(`sb/2026/${planId}.pdf`, new Blob([buf]), { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/pdf' })).url;
          const p2 = makePrisma();
          const u = await p2.plan.updateMany({ where: { planId }, data: { sbPdfUrl: blobUrl, sbPdfSourceFilename: hitUrl, sbPdfChecksum: sha, sbLastProcessedAt: new Date(), sbDiscoveryConfidence: 0.97 } });
          await p2.$disconnect();
          prog[planId] = 'GOOD';
          fs.appendFileSync('sb-rediscovery-results.csv', [planId, JSON.stringify(org), 'GOOD', JSON.stringify(hitUrl)].join(',') + '\n');
          fs.writeFileSync('sb-rediscovery-progress.json', JSON.stringify(prog));
          console.log(`\n  GOOD ${planId} (rows ${u.count})`);
          found = true;
          totalFound++;
        } catch (e) { process.stdout.write(`BLOB ERR: ${e.message}\n`); }
      }
    }
    if (!found) console.log(`  MISS ${planId}`);
  }

  await prisma.$disconnect();
  const total = Object.values(prog).filter(v => v === 'GOOD').length;
  console.log(`\nDone. Found ${totalFound} new. Total GOOD: ${total}`);
})().catch(e => { console.error(e); process.exit(1); });
