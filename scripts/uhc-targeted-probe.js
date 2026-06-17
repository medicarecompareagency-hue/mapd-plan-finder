// Targeted UHC probe: use alphadog URL (no date-time needed) with known DOCID ranges
// Based on known DOCIDs from web search findings
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { put } = require('@vercel/blob');
const { makePrisma } = require('./prisma-client');
const { classify, pdftext, idVariants } = require('./ingest-sb-url');

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

// Contract → sorted list of plans (by state/type/docid-range)
// Format: { plans: [planId...], candidates: [{prefix, docidStart, docidEnd}] }
// Known from web search results + DB state lookups
const CONTRACT_PROBES = {
  // H2406 FL AARP PPO (multi-state)
  // Known: plan 17 FL @0332714, plan 18 FL @0332715, plan 34 NC @0332717, plan 46 PA @0332728, plan 66 IN @0332741
  'H2406': [
    { prefix: 'AAIN26LP', docStart: 332716, docEnd: 332742 }, // IN plans 37, 56
    { prefix: 'AAIL26LP', docStart: 332714, docEnd: 332780 }, // IL plan 69 (range guess)
    { prefix: 'AAFL26LP', docStart: 332714, docEnd: 332720 }, // FL plans (in case 37/56 are FL)
    { prefix: 'AAEX26LP', docStart: 332716, docEnd: 332742 }, // Extras variant
  ],
  // H5253 multi-state (VA, KY, IL, TN, OH)
  // Known: plan 196 VA @UHVA26HP0333055; other plans NC @AANC26HP0332974
  'H5253': [
    { prefix: 'UHVA26HP', docStart: 333045, docEnd: 333070 }, // VA plans 89, 120
    { prefix: 'UHKY26HP', docStart: 333045, docEnd: 333080 }, // KY plans 127, 128
    { prefix: 'AAKY26HP', docStart: 333045, docEnd: 333080 }, // KY AARP variant
    { prefix: 'AAVA26HP', docStart: 333045, docEnd: 333070 }, // VA AARP variant
    { prefix: 'AAIL26HP', docStart: 333045, docEnd: 333080 }, // IL plan 180
    { prefix: 'UHIL26HP', docStart: 333045, docEnd: 333080 }, // IL UH variant
    { prefix: 'CAIL26HP', docStart: 333045, docEnd: 333080 }, // IL CS variant
    { prefix: 'CSVA26HP', docStart: 333045, docEnd: 333070 }, // VA CS variant
  ],
  // H8768 multi-state AARP PPO (IL, OK)
  // Known: plan 9 OK @AAOK26LP0333120, plan 11 IL @AAIL26LP0333122
  'H8768': [
    { prefix: 'AAOK26LP', docStart: 333118, docEnd: 333122 }, // OK plan 8
    { prefix: 'AAIL26LP', docStart: 333120, docEnd: 333130 }, // IL plan 17
    { prefix: 'AAEX26LP', docStart: 333118, docEnd: 333130 }, // EX variant
  ],
  // H5435 KS (PFFS/MA-only)
  // Unknown DOCIDs - try typical UHC KS range
  'H5435': [
    { prefix: 'UHKS26HP', docStart: 332400, docEnd: 332700 },
    { prefix: 'PCKS26HP', docStart: 332400, docEnd: 332700 },
    { prefix: 'UHKS26HM', docStart: 332400, docEnd: 332700 },
    { prefix: 'PCKS26HM', docStart: 332400, docEnd: 332700 },
    { prefix: 'UHKS26FP', docStart: 332400, docEnd: 332700 }, // PFFS
    { prefix: 'AAKS26LP', docStart: 332400, docEnd: 332700 },
  ],
  // H1659 VA (MAPD)
  // Known: H5253-196 VA @UHVA26HP0333055
  'H1659': [
    { prefix: 'UHVA26HP', docStart: 332900, docEnd: 333100 },
    { prefix: 'AAVA26HP', docStart: 332900, docEnd: 333100 },
    { prefix: 'PCVA26HP', docStart: 332900, docEnd: 333100 },
    { prefix: 'CSVA26HP', docStart: 332900, docEnd: 333100 },
  ],
  // H0432 AL (DSNP)
  'H0432': [
    { prefix: 'CSAL26HP', docStart: 332750, docEnd: 332850 }, // CS prefix (like H2802-44 AL)
    { prefix: 'UHAL26HP', docStart: 332750, docEnd: 332850 },
    { prefix: 'PCAL26HP', docStart: 332750, docEnd: 332850 },
  ],
  // H0609 TX DSNP
  'H0609': [
    { prefix: 'CSTX26HP', docStart: 332600, docEnd: 332900 },
    { prefix: 'UHTX26HP', docStart: 332600, docEnd: 332900 },
    { prefix: 'PCTX26HP', docStart: 332600, docEnd: 332900 },
  ],
  // H2001 VA multi-state
  'H2001': [
    { prefix: 'UHVA26HP', docStart: 332600, docEnd: 332850 },
    { prefix: 'AAVA26LP', docStart: 332600, docEnd: 332850 },
    { prefix: 'PCVA26HP', docStart: 332600, docEnd: 332850 },
    { prefix: 'UHVA26LP', docStart: 332600, docEnd: 332850 },
  ],
  // H1045 FL remaining (38, 57, 61, 64)
  // Known: plan 37 @PCFL26HM0332518, plan 39 @UHFL26HP0332520
  'H1045': [
    { prefix: 'PCFL26HM', docStart: 332519, docEnd: 332520 }, // plan 38 between 37 and 39
    { prefix: 'UHFL26HP', docStart: 332519, docEnd: 332520 }, // plan 38 HMO-POS/DSNP
    { prefix: 'PCFL26HP', docStart: 332530, docEnd: 332537 }, // plans 57, 61, 64
    { prefix: 'UHFL26HP', docStart: 332530, docEnd: 332537 }, // plans 57, 61, 64
    { prefix: 'AAFL26HP', docStart: 332519, docEnd: 332537 }, // AARP variant
  ],
  // H4527 TX remaining (15, 40)
  // Known: plan 41 TX @UHTX26HP0332899
  'H4527': [
    { prefix: 'UHTX26HP', docStart: 332880, docEnd: 332898 }, // plans 15, 40 before plan 41
    { prefix: 'PCTX26HP', docStart: 332880, docEnd: 332898 },
    { prefix: 'CSTX26HP', docStart: 332880, docEnd: 332900 },
  ],
  // H5420 FL remaining (6, 15, 16)
  // Known: plan 1 @PNFL26HM0333087
  'H5420': [
    { prefix: 'PNFL26HM', docStart: 333080, docEnd: 333090 }, // plans 6, 15, 16
    { prefix: 'UHFL26HP', docStart: 333080, docEnd: 333095 },
    { prefix: 'PCFL26HP', docStart: 333080, docEnd: 333095 },
    { prefix: 'CSFLDSNP', docStart: 333080, docEnd: 333095 },
    { prefix: 'CSFL26HP', docStart: 333080, docEnd: 333095 },
  ],
  // H1278 TX AARP PPO (plans 25, 26)
  'H1278': [
    { prefix: 'AATX26LP', docStart: 332700, docEnd: 332900 },
    { prefix: 'AAEX26LP', docStart: 332700, docEnd: 332900 },
    { prefix: 'UHTX26LP', docStart: 332700, docEnd: 332900 },
  ],
};

async function probeBatch(urls) {
  return Promise.all(urls.map(url =>
    fetch(url, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000), redirect: 'follow' })
      .then(r => r.ok ? url : null).catch(() => null)
  ));
}
async function downloadPdf(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'application/pdf,*/*' }, signal: AbortSignal.timeout(25000), redirect: 'follow' });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.slice(0, 5).toString() === '%PDF-' ? buf : null;
  } catch { return null; }
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
    const probeList = CONTRACT_PROBES[contract];
    if (!probeList) { console.log(`${contract}: no probe config`); continue; }

    let remaining = cPlans.filter(p => prog[p.planId] !== 'GOOD');
    if (remaining.length === 0) continue;
    console.log(`\n=== ${contract}: ${remaining.length} plans ===`);

    for (const { prefix, docStart, docEnd } of probeList) {
      if (remaining.length === 0) break;

      for (let docid = docStart; docid <= docEnd && remaining.length > 0; docid++) {
        const docStr = String(docid).padStart(7, '0');
        const alphadogUrl = `https://www.uhc.com/medicare/alphadog/${prefix}${docStr}_000`;

        const hits = (await probeBatch([alphadogUrl])).filter(Boolean);
        if (hits.length === 0) continue;

        process.stdout.write(`  docid=${docStr} prefix=${prefix} hit! `);
        const buf = await downloadPdf(hits[0]);
        if (!buf) { process.stdout.write('not PDF\n'); continue; }
        const txt = pdftext(buf);

        const stillRemaining = [];
        for (const { planId, org } of remaining) {
          const hay = txt.replace(/[\s\-|]/g, '').toUpperCase();
          const inPdf = idVariants(planId).some(v => hay.includes(v.replace(/[\s\-|]/g, '').toUpperCase()));
          if (!inPdf) { stillRemaining.push({ planId, org }); continue; }

          const [v, reason] = classify(planId, buf, txt);
          if (v !== 'GOOD') { process.stdout.write(`\n  ${planId} FAIL: ${reason}`); stillRemaining.push({ planId, org }); continue; }

          const sha = crypto.createHash('sha256').update(buf).digest('hex');
          try {
            const blobUrl = (await put(`sb/2026/${planId}.pdf`, new Blob([buf]), { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/pdf' })).url;
            const p2 = makePrisma();
            const u = await p2.plan.updateMany({ where: { planId }, data: { sbPdfUrl: blobUrl, sbPdfSourceFilename: alphadogUrl, sbPdfChecksum: sha, sbLastProcessedAt: new Date(), sbDiscoveryConfidence: 0.97 } });
            await p2.$disconnect();
            prog[planId] = 'GOOD';
            fs.appendFileSync('sb-rediscovery-results.csv', [planId, JSON.stringify(org), 'GOOD', JSON.stringify(alphadogUrl)].join(',') + '\n');
            fs.writeFileSync('sb-rediscovery-progress.json', JSON.stringify(prog));
            process.stdout.write(`\n  GOOD ${planId} (rows ${u.count})\n`);
            totalFound++;
          } catch (e) { process.stdout.write(`\n  BLOB ERR: ${e.message}`); stillRemaining.push({ planId, org }); }
        }
        remaining = stillRemaining;
        if (remaining.length > 0 && hits.length > 0) process.stdout.write(`(${remaining.length} still needed)\n`);
      }
    }
    if (remaining.length > 0) console.log(`\n  MISS: ${remaining.map(p => p.planId).join(', ')}`);
  }

  await prisma.$disconnect();
  const total = Object.values(prog).filter(v => v === 'GOOD').length;
  console.log(`\nDone. Found ${totalFound} new. Total GOOD: ${total}`);
})().catch(e => { console.error(e); process.exit(1); });
