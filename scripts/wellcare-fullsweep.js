// Wellcare per-plan full sweep: for each contract, probe all docnums, download matches, check all remaining plans
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

function buildUrlsForContract(contract, state, num) {
  const st = state.toLowerCase(), ST = state.toUpperCase(), h = contract.toLowerCase();
  const TYPES = ['hmapd', 'dsnp', 'ppo', 'hmo', 'pffs', 'lppo', 'cmapd', 'hmopos'];
  const urls = [];
  for (const ty of TYPES) {
    urls.push(`https://www.wellcare.com/-/media/pdfs/medicare-2026/sb/${h}_2026_${st}_sb_${ty}_${num}eng_m.ashx`);
    if (ST === 'TX') urls.push(`https://wellcare.superiorhealthplan.com/content/dam/centene/medicare/pdfs/aep/2026/sb/${h.toUpperCase()}_2026_TX_SB_${ty.toUpperCase()}_${num}ENG_M.pdf`);
    if (ST === 'OK') urls.push(`https://www.wellcareok.com/content/dam/centene/medicare/pdfs/aep/2026/sb/${h.toUpperCase()}_2026_OK_SB_${ty.toUpperCase()}_${num}ENG_M.pdf`);
    if (ST === 'NE') urls.push(`https://www.wellcarene.com/-/media/pdfs/medicare-2026/sb/${h}_2026_ne_sb_${ty}_${num}eng_m.ashx`);
    if (ST === 'IN') urls.push(`https://wellcare.mhsindiana.com/content/dam/centene/medicare/pdfs/aep/2026/sb/${h.toUpperCase()}_2026_IN_SB_${ty.toUpperCase()}_${num}ENG_M.pdf`);
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
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'application/pdf,*/*' }, signal: AbortSignal.timeout(30000), redirect: 'follow' });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.slice(0,5).toString().startsWith('%PDF-')) return null;
    return buf;
  } catch { return null; }
}

async function sweepContract(contract, state, remainingPlans, prog) {
  let remaining = [...remainingPlans];
  let found = 0;
  process.stdout.write(`\n=== ${contract} (${state}) ${remaining.length} plans ===\n`);

  for (let num = 4626664; num <= 4626940 && remaining.length > 0; num++) {
    const urls = buildUrlsForContract(contract, state, num);

    // Probe all URL variants for this docnum in parallel
    const results = await probeBatch(urls);
    const hitUrl = results.find(u => u !== null);
    if (!hitUrl) {
      if ((num - 4626664) % 50 === 49) process.stdout.write(`  [${num}]\n`);
      continue;
    }

    process.stdout.write(`  num=${num} hit=${hitUrl.slice(-60)}... `);
    const buf = await downloadPdf(hitUrl);
    if (!buf) { process.stdout.write('download fail\n'); continue; }
    const txt = pdftext(buf);

    // Check each remaining plan against this PDF
    const stillRemaining = [];
    for (const { planId, org } of remaining) {
      const variants = idVariants(planId);
      const hay = txt.replace(/[\s\-|]/g, '').toUpperCase();
      const inPdf = variants.some(v => hay.includes(v.replace(/[\s\-|]/g, '').toUpperCase()));
      if (!inPdf) { stillRemaining.push({ planId, org }); continue; }

      const [v, reason] = classify(planId, buf, txt);
      if (v !== 'GOOD') { process.stdout.write(`\n    ${planId} FAIL: ${reason}`); stillRemaining.push({ planId, org }); continue; }

      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      try {
        const blobUrl = (await put(`sb/2026/${planId}.pdf`, new Blob([buf]), { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/pdf' })).url;
        const p2 = makePrisma();
        const u = await p2.plan.updateMany({ where: { planId }, data: { sbPdfUrl: blobUrl, sbPdfSourceFilename: hitUrl, sbPdfChecksum: sha, sbLastProcessedAt: new Date(), sbDiscoveryConfidence: 0.97 } });
        await p2.$disconnect();
        prog[planId] = 'GOOD';
        fs.appendFileSync('sb-rediscovery-results.csv', [planId, JSON.stringify(org), 'GOOD', JSON.stringify(hitUrl)].join(',') + '\n');
        fs.writeFileSync('sb-rediscovery-progress.json', JSON.stringify(prog));
        process.stdout.write(`\n    GOOD ${planId} (rows ${u.count})`);
        found++;
      } catch (e) { process.stdout.write(`\n    BLOB ERR ${planId}: ${e.message}`); stillRemaining.push({ planId, org }); }
    }
    remaining = stillRemaining;
    if (remaining.length > 0) process.stdout.write(`\n  (${remaining.length} still needed)\n`);
  }

  if (remaining.length > 0) console.log(`\n  MISS: ${remaining.map(p=>p.planId).join(', ')}`);
  return found;
}

(async () => {
  const prisma = makePrisma();
  const plans = getWellcareUnresolved();
  const prog = JSON.parse(fs.readFileSync('sb-rediscovery-progress.json', 'utf8'));
  console.log('Wellcare unresolved:', plans.length, 'plans');

  // Group by contract, look up state
  const byContract = {};
  for (const p of plans) {
    const contract = p.planId.split('-')[0];
    if (!byContract[contract]) byContract[contract] = { plans: [], state: null };
    byContract[contract].plans.push(p);
  }
  for (const [contract, info] of Object.entries(byContract)) {
    const rows = await prisma.plan.findMany({ where: { planYear: 2026, planId: { startsWith: contract + '-' } }, select: { state: true }, take: 1 });
    info.state = rows[0]?.state || null;
  }
  await prisma.$disconnect();

  let totalFound = 0;
  for (const [contract, { plans: cPlans, state }] of Object.entries(byContract)) {
    if (!state) { console.log(`SKIP ${contract}: state unknown`); continue; }
    const stillNeeded = cPlans.filter(p => prog[p.planId] !== 'GOOD');
    if (stillNeeded.length === 0) continue;
    totalFound += await sweepContract(contract, state, stillNeeded, prog);
  }

  const total = Object.values(prog).filter(v => v === 'GOOD').length;
  console.log(`\nDone. Found ${totalFound} new. Total GOOD: ${total}`);
})().catch(e => { console.error(e); process.exit(1); });
