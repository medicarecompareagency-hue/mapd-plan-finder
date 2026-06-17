// Probe content.medicareadvantage.com with newer URL format (SF20260204)
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { put } = require('@vercel/blob');
const { classify, pdftext, idVariants } = require('./ingest-sb-url');
const { makePrisma } = require('./prisma-client');

for (const envFile of ['.env', '.env.local']) {
  const p = path.join(__dirname, '..', envFile);
  try { const c = fs.readFileSync(p, 'utf8'); for (const l of c.split(/\r?\n/)) { const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n\r]*)"?\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; } } catch {}
}

async function downloadPdf(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/pdf,*/*' }, signal: AbortSignal.timeout(20000), redirect: 'follow' });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.slice(0, 5).toString() === '%PDF-' ? buf : null;
  } catch { return null; }
}

async function tryPlanAtDocids(planId, prefix, docStart, docEnd, suffix='SF20260204', base='https://content.medicareadvantage.com/2026/UHC_') {
  const prog = JSON.parse(fs.readFileSync('sb-rediscovery-progress.json','utf8'));
  if (prog[planId] === 'GOOD') { console.log(planId, 'already GOOD'); return true; }

  for (let docid = docStart; docid <= docEnd; docid++) {
    const docStr = String(docid).padStart(7, '0');
    const url = `${base}${prefix}${docStr}_2026_SB_${suffix}.pdf`;
    const buf = await downloadPdf(url);
    if (!buf) { process.stdout.write('.'); continue; }
    const txt = pdftext(buf);
    const hay = txt.replace(/[\s\-|]/g,'').toUpperCase();
    const inPdf = idVariants(planId).some(v => hay.includes(v.replace(/[\s\-|]/g,'').toUpperCase()));
    if (!inPdf) { process.stdout.write(`\n  ${docStr} PDF but wrong plan`); continue; }
    const [v, reason] = classify(planId, buf, txt);
    if (v !== 'GOOD') { process.stdout.write(`\n  FAIL ${planId} at ${docStr}: ${reason}`); continue; }
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const blobUrl = (await put(`sb/2026/${planId}.pdf`, new Blob([buf]), { access:'public', addRandomSuffix:false, allowOverwrite:true, contentType:'application/pdf' })).url;
    const prisma = makePrisma();
    const u = await prisma.plan.updateMany({ where:{planId}, data:{ sbPdfUrl:blobUrl, sbPdfSourceFilename:url, sbPdfChecksum:sha, sbLastProcessedAt:new Date(), sbDiscoveryConfidence:0.97 }});
    await prisma.$disconnect();
    prog[planId] = 'GOOD';
    fs.writeFileSync('sb-rediscovery-progress.json', JSON.stringify(prog));
    fs.appendFileSync('sb-rediscovery-results.csv', [planId, '"UnitedHealthcare"', 'GOOD', JSON.stringify(url)].join(',') + '\n');
    process.stdout.write(`\n  GOOD ${planId} docid=${docStr} (rows ${u.count})\n`);
    return true;
  }
  console.log(`\n  MISS ${planId} in ${prefix} ${docStart}-${docEnd}`);
  return false;
}

(async () => {
  console.log('Probing H5253-127/128 (KY plans, AAKY prefix, near 332973-333010)');
  await tryPlanAtDocids('H5253-127', 'AAKY26HP', 332973, 333010);
  await tryPlanAtDocids('H5253-128', 'AAKY26HP', 332973, 333010);
  // Also try AAEX prefix for KY-5 "Extras"
  await tryPlanAtDocids('H5253-128', 'AAEX26HP', 332973, 333010);

  console.log('\nProbing H2406-069 (ST-2 PPO, AAEX26LP, near 332723-332770)');
  await tryPlanAtDocids('H2406-69', 'AAEX26LP', 332723, 332770);

  console.log('\nProbing H2001-96/97/98 (VA AARP PPO, AAVA26LP)');
  await tryPlanAtDocids('H2001-96', 'AAVA26LP', 332700, 332850);
  await tryPlanAtDocids('H2001-97', 'AAVA26LP', 332700, 332850);
  await tryPlanAtDocids('H2001-98', 'AAVA26LP', 332700, 332850);

  console.log('\nProbing H1659-2 (VA-0001 PPO, UHVA26LP)');
  await tryPlanAtDocids('H1659-2', 'UHVA26LP', 332600, 332800);

  console.log('\nProbing H5435-1/24 (KS PFFS, UHEX26FF/AAEX26FF)');
  await tryPlanAtDocids('H5435-1', 'UHEX26FF', 332400, 332700);
  await tryPlanAtDocids('H5435-24', 'UHEX26FF', 332400, 332700);
  await tryPlanAtDocids('H5435-1', 'AAEX26FF', 332400, 332700);
  await tryPlanAtDocids('H5435-24', 'AAEX26FF', 332400, 332700);

  console.log('\nProbing H1278-25/26 (TX AARP PPO, AATX26LP)');
  await tryPlanAtDocids('H1278-25', 'AATX26LP', 332540, 332610);
  await tryPlanAtDocids('H1278-26', 'AATX26LP', 332540, 332610);

  console.log('\nProbing H5253-180 (IA-5 CSNP, UHEX26HP)');
  await tryPlanAtDocids('H5253-180', 'UHEX26HP', 332800, 332870);

  const prog = JSON.parse(fs.readFileSync('sb-rediscovery-progress.json','utf8'));
  console.log('\nTotal GOOD:', Object.values(prog).filter(v=>v==='GOOD').length);
})().catch(e => { console.error(e); process.exit(1); });
