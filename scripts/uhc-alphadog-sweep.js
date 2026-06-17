// UHC alphadog sweeper: probe uhc.com/medicare/alphadog/<CODE>_000 for remaining UHC plans
// Alphadog redirects to the actual PDF on content.medicareadvantage.com
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { put } = require('@vercel/blob');
const { makePrisma } = require('./prisma-client');
const { classify, pdftext, idVariants, ingest } = require('./ingest-sb-url');

for (const envFile of ['.env', '.env.local']) {
  const p = path.join(__dirname, '..', envFile);
  try { const c = fs.readFileSync(p, 'utf8'); for (const l of c.split(/\r?\n/)) { const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n\r]*)"?\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; } } catch {}
}

function parseCsv(line) { return (line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)||[]).map(s=>s.replace(/,$/,'').replace(/^"|"$/g,'').replace(/""/g,'"')); }

function getUhcUnresolved() {
  const prog = JSON.parse(fs.readFileSync('sb-rediscovery-progress.json', 'utf8'));
  const rows = fs.readFileSync('sb-unresolved.csv', 'utf8').trim().split(/\r?\n/);
  return rows.slice(1).map(l => { const f = parseCsv(l); return { planId: f[0], org: f[1] }; })
    .filter(p => /unitedhealth|uhc|aarp/i.test(p.org) && prog[p.planId] !== 'GOOD');
}

// Per-contract sweep parameters: [state, types[], prefixes[], docidStart, docidEnd]
// Derived from known URLs + session research
const SWEEP_PARAMS = {
  'H1045': { state: 'FL', types: ['HM','HP','LP'], prefixes: ['PC','UH','AA','GM','WS'], docStart: 332480, docEnd: 332560 },
  'H5420': { state: 'FL', types: ['HM','HP','LP'], prefixes: ['PN','PC','UH','AA'], docStart: 333075, docEnd: 333100 },
  'H4527': { state: 'TX', types: ['HP','HM','LP'], prefixes: ['UH','TX','PC','AA'], docStart: 332880, docEnd: 332920 },
  'H5253': { state: null, types: ['HP','HM','LP','PP'], prefixes: ['UH','PC','CS','AA'], docStart: 333020, docEnd: 333090 },
  'H2406': { state: 'FL', types: ['LP','PP','HP'], prefixes: ['AA','UH','PC','CS'], docStart: 332700, docEnd: 332800 },
  'H2001': { state: 'TN', types: ['HP','LP','PP'], prefixes: ['UH','PC','CH','CS'], docStart: 332600, docEnd: 332800 },
  'H0609': { state: 'TX', types: ['HP','HM','LP'], prefixes: ['UH','PC','TX','AA'], docStart: 332600, docEnd: 332900 },
  'H5435': { state: 'KS', types: ['HM','HP','FP'], prefixes: ['UH','PC','MH','CS'], docStart: 332400, docEnd: 332700 },
  'H2802': { state: 'IN', types: ['HM','HP','LP'], prefixes: ['UH','PC','MH','CS'], docStart: 332600, docEnd: 332900 },
  'H8768': { state: 'IL', types: ['HM','HP','LP'], prefixes: ['UH','PC','CS','GM'], docStart: 332600, docEnd: 332900 },
  'H1659': { state: 'VA', types: ['HP','HM','LP'], prefixes: ['UH','PC','CS','AA'], docStart: 332900, docEnd: 333100 },
  'H0432': { state: 'AL', types: ['HM','HP','LP'], prefixes: ['UH','PC','CS','AA'], docStart: 332600, docEnd: 332900 },
  'H1278': { state: 'TX', types: ['LP','PP','HP'], prefixes: ['AA','UH','PC','CS'], docStart: 332700, docEnd: 332900 },
};

// Also try states from DB if state is null (multi-state contracts)
async function getContractStates(contract, prisma) {
  const rows = await prisma.plan.findMany({
    where: { planYear: 2026, planId: { startsWith: contract + '-' } },
    select: { state: true },
    distinct: ['state'],
    take: 5,
  });
  return [...new Set(rows.map(r => r.state).filter(Boolean))];
}

async function downloadPdf(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, signal: AbortSignal.timeout(20000), redirect: 'follow' });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.slice(0, 5).toString() === '%PDF-' ? buf : null;
  } catch { return null; }
}

async function probeBatch(urls) {
  return Promise.all(urls.map(async url => {
    try {
      const r = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000), redirect: 'follow' });
      return r.ok ? url : null;
    } catch { return null; }
  }));
}

async function sweepContract(contract, params, remainingPlans, prog, prisma) {
  let remaining = [...remainingPlans];
  if (remaining.length === 0) return 0;

  let states = params.state ? [params.state] : await getContractStates(contract, prisma);
  if (states.length === 0) { console.log(`${contract}: no states found`); return 0; }

  console.log(`\n=== ${contract} (${states.join(',')}) ${remaining.length} plans ===`);
  let found = 0;

  for (const state of states) {
    if (remaining.length === 0) break;
    const st = state.toUpperCase();

    for (let docid = params.docStart; docid <= params.docEnd && remaining.length > 0; docid++) {
      const docStr = String(docid).padStart(7, '0');
      const candidates = [];

      // Alphadog URLs
      for (const prefix of params.prefixes) {
        for (const ty of params.types) {
          candidates.push(`https://www.uhc.com/medicare/alphadog/${prefix}${st}26${ty}${docStr}_000`);
        }
      }

      // Probe batch in parallel
      const hits = (await probeBatch(candidates)).filter(Boolean);
      if (hits.length === 0) continue;

      for (const hitUrl of hits) {
        process.stdout.write(`  num=${docStr} url=...${hitUrl.slice(-30)}... `);
        const buf = await downloadPdf(hitUrl);
        if (!buf) { process.stdout.write('not PDF\n'); continue; }
        const txt = pdftext(buf);

        const stillRemaining = [];
        for (const { planId, org } of remaining) {
          const variants = idVariants(planId);
          const hay = txt.replace(/[\s\-|]/g, '').toUpperCase();
          const inPdf = variants.some(v => hay.includes(v.replace(/[\s\-|]/g, '').toUpperCase()));
          if (!inPdf) { stillRemaining.push({ planId, org }); continue; }

          const [v, reason] = classify(planId, buf, txt);
          if (v !== 'GOOD') { process.stdout.write(`\n  ${planId} FAIL: ${reason}`); stillRemaining.push({ planId, org }); continue; }

          const sha = crypto.createHash('sha256').update(buf).digest('hex');
          try {
            const blobUrl = (await put(`sb/2026/${planId}.pdf`, new Blob([buf]), { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/pdf' })).url;
            const p2 = makePrisma();
            const u = await p2.plan.updateMany({ where: { planId }, data: { sbPdfUrl: blobUrl, sbPdfSourceFilename: hitUrl, sbPdfChecksum: sha, sbLastProcessedAt: new Date(), sbDiscoveryConfidence: 0.97 } });
            await p2.$disconnect();
            prog[planId] = 'GOOD';
            fs.appendFileSync('sb-rediscovery-results.csv', [planId, JSON.stringify(org), 'GOOD', JSON.stringify(hitUrl)].join(',') + '\n');
            fs.writeFileSync('sb-rediscovery-progress.json', JSON.stringify(prog));
            process.stdout.write(`\n  GOOD ${planId} (rows ${u.count})\n`);
            found++;
          } catch (e) { process.stdout.write(`\n  BLOB ERR: ${e.message}`); stillRemaining.push({ planId, org }); }
        }
        remaining = stillRemaining;
        if (remaining.length > 0) process.stdout.write(`(${remaining.length} still needed)\n`);
      }
    }
  }

  if (remaining.length > 0) console.log(`  MISS: ${remaining.map(p => p.planId).join(', ')}`);
  return found;
}

(async () => {
  const prisma = makePrisma();
  const plans = getUhcUnresolved();
  const prog = JSON.parse(fs.readFileSync('sb-rediscovery-progress.json', 'utf8'));
  console.log('UHC still unresolved:', plans.length);

  const byContract = {};
  for (const p of plans) {
    const c = p.planId.split('-')[0];
    if (!byContract[c]) byContract[c] = [];
    byContract[c].push(p);
  }

  let totalFound = 0;
  for (const [contract, cPlans] of Object.entries(byContract)) {
    const params = SWEEP_PARAMS[contract];
    if (!params) { console.log(`${contract}: no sweep params, skipping`); continue; }
    const stillNeeded = cPlans.filter(p => prog[p.planId] !== 'GOOD');
    if (stillNeeded.length === 0) continue;
    totalFound += await sweepContract(contract, params, stillNeeded, prog, prisma);
  }

  await prisma.$disconnect();
  const total = Object.values(prog).filter(v => v === 'GOOD').length;
  console.log(`\nDone. Found ${totalFound} new UHC. Total GOOD: ${total}`);
})().catch(e => { console.error(e); process.exit(1); });
