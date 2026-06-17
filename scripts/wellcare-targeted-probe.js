// Targeted probe for remaining Wellcare stragglers with extended type codes
// H3975-2 (KY PPO Patriot Giveback) = type:pmao
// H3975-4 (KY PPO D-SNP) = type:pdsnp
// H7518-2 (MO PPO Patriot Giveback) = type:pmao
// H2491-30 (LA HMO/HMO-POS) = wider docnum range
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { put } = require('@vercel/blob');
const { makePrisma } = require('./prisma-client');
const { classify, pdftext, idVariants } = require('./ingest-sb-url');

for (const envFile of ['.env', '.env.local']) {
  const p = path.join(__dirname, '..', envFile);
  try { const c = fs.readFileSync(p, 'utf8'); for (const l of c.split(/\r?\n/)) { const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n\r]*)"?\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; } } catch {}
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

async function ingestWellcare(planId, state, types, docStart, docEnd) {
  const prog = JSON.parse(fs.readFileSync('sb-rediscovery-progress.json', 'utf8'));
  if (prog[planId] === 'GOOD') { console.log(planId, 'already GOOD'); return true; }

  const contract = planId.split('-')[0].toLowerCase();
  const st = state.toLowerCase();

  for (let num = docStart; num <= docEnd; num++) {
    const urls = types.map(ty =>
      `https://www.wellcare.com/-/media/pdfs/medicare-2026/sb/${contract}_2026_${st}_sb_${ty}_${num}eng_m.ashx`
    );
    const hits = (await probeBatch(urls)).filter(Boolean);
    if (hits.length === 0) continue;

    for (const hitUrl of hits) {
      process.stdout.write(`  num=${num} ${hitUrl.match(/sb_(\w+)_/)?.[1]} `);
      const buf = await downloadPdf(hitUrl);
      if (!buf) { process.stdout.write('not PDF\n'); continue; }
      const txt = pdftext(buf);
      const hay = txt.replace(/[\s\-|]/g, '').toUpperCase();
      const inPdf = idVariants(planId).some(v => hay.includes(v.replace(/[\s\-|]/g, '').toUpperCase()));
      if (!inPdf) { process.stdout.write('planid_missing\n'); continue; }
      const [v, reason] = classify(planId, buf, txt);
      if (v !== 'GOOD') { process.stdout.write(`FAIL:${reason}\n`); continue; }
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      const blobUrl = (await put(`sb/2026/${planId}.pdf`, new Blob([buf]), { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/pdf' })).url;
      const prisma = makePrisma();
      const u = await prisma.plan.updateMany({ where: { planId }, data: { sbPdfUrl: blobUrl, sbPdfSourceFilename: hitUrl, sbPdfChecksum: sha, sbLastProcessedAt: new Date(), sbDiscoveryConfidence: 0.97 } });
      await prisma.$disconnect();
      const prog2 = JSON.parse(fs.readFileSync('sb-rediscovery-progress.json', 'utf8'));
      prog2[planId] = 'GOOD';
      fs.writeFileSync('sb-rediscovery-progress.json', JSON.stringify(prog2));
      fs.appendFileSync('sb-rediscovery-results.csv', [planId, '"Wellcare"', 'GOOD', JSON.stringify(hitUrl)].join(',') + '\n');
      console.log(`\n  GOOD ${planId} (rows ${u.count})`);
      return true;
    }
  }
  console.log(`  MISS ${planId}`);
  return false;
}

(async () => {
  const prisma = makePrisma();

  // H3975-2: KY PPO Patriot Giveback = pmao type
  console.log('\nSearching H3975-2 (KY PPO Patriot Giveback, pmao)...');
  await ingestWellcare('H3975-2', 'KY', ['pmao'], 4626650, 4628500);

  // H3975-4: KY PPO D-SNP = pdsnp type
  console.log('\nSearching H3975-4 (KY PPO D-SNP, pdsnp)...');
  await ingestWellcare('H3975-4', 'KY', ['pdsnp'], 4626650, 4628500);

  // H7518-2: MO PPO Patriot Giveback = pmao type
  console.log('\nSearching H7518-2 (MO PPO Patriot Giveback, pmao)...');
  await ingestWellcare('H7518-2', 'MO', ['pmao'], 4626650, 4628500);

  // H2491-30: LA HMO - try all types in a wider range (4626000-4628500 already tried hmapd/dsnp)
  // Try types that might have been missed, and a wider range
  console.log('\nSearching H2491-30 (LA HMO, wider range + extra types)...');
  await ingestWellcare('H2491-30', 'LA', ['hmo', 'hmopos', 'hmapd', 'dsnp', 'pdsnp', 'pmao', 'ppos', 'lppo'], 4626000, 4630000);

  await prisma.$disconnect();
  const prog = JSON.parse(fs.readFileSync('sb-rediscovery-progress.json', 'utf8'));
  console.log('\nTotal GOOD:', Object.values(prog).filter(v => v === 'GOOD').length);
})().catch(e => { console.error(e); process.exit(1); });
