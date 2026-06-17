// Download rediscovered SB PDFs from Blob and build discovery JSON for extract-sb-benefits.ts
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { makePrisma } = require('./prisma-client');

for (const envFile of ['.env', '.env.local']) {
  const p = path.join(__dirname, '..', envFile);
  try { const c = fs.readFileSync(p, 'utf8'); for (const l of c.split(/\r?\n/)) { const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n\r]*)"?\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; } } catch {}
}

function parseCsv(l) { return (l.match(/("([^"]|"")*"|[^,]*)(,|$)/g)||[]).map(s=>s.replace(/,$/,'').replace(/^"|"$/g,'').replace(/""/g,'"')); }

const SB_DIR = path.join(process.cwd(), 'summary-of-benefits-rediscovered');
if (!fs.existsSync(SB_DIR)) fs.mkdirSync(SB_DIR, { recursive: true });

async function downloadPdf(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

(async () => {
  // Read plans from sb-rediscovery-results.csv
  const csv = fs.readFileSync('sb-rediscovery-results.csv', 'utf8').trim().split(/\r?\n/);
  const header = csv[0].split(',');
  const iId = header.indexOf('planId'), iVerdict = header.indexOf('verdict'), iOrg = header.indexOf('org');
  const goodPlans = csv.slice(1).map(parseCsv)
    .filter(f => f[iVerdict] === 'GOOD')
    .map(f => ({ planId: f[iId], org: f[iOrg] || '' }));

  console.log('Good plans to prep:', goodPlans.length);

  const prisma = makePrisma();
  const discovery = [];
  let downloaded = 0, skipped = 0, failed = 0;

  for (const { planId, org } of goodPlans) {
    const localPath = path.join(SB_DIR, `${planId}.pdf`);

    // Get URL from DB
    const row = await prisma.plan.findFirst({
      where: { planId, planYear: 2026, sbPdfUrl: { not: null } },
      select: { sbPdfUrl: true },
    });
    if (!row?.sbPdfUrl) { console.log(`SKIP ${planId}: no sbPdfUrl in DB`); skipped++; continue; }

    // Download if not already present
    if (!fs.existsSync(localPath)) {
      try {
        process.stdout.write(`Downloading ${planId}...`);
        const buf = await downloadPdf(row.sbPdfUrl);
        fs.writeFileSync(localPath, buf);
        process.stdout.write(` ${buf.length} bytes\n`);
        downloaded++;
      } catch (e) {
        console.log(`\nFAIL ${planId}: ${e.message}`);
        failed++;
        continue;
      }
    } else {
      skipped++;
    }

    // Add discovery entry
    const carrier = (org || '').split(/\s+/)[0] || null;
    discovery.push({
      file: localPath,
      planIds: [planId],
      year: 2026,
      yearSource: 'text-fallback',
      yearConfidence: 0.97,
      filenameYear: null,
      downloadListYear: null,
      documentTitleYear: 2026,
      textFallbackYear: 2026,
      textYears: [2026],
      organization: carrier,
      warnings: [],
    });
  }

  await prisma.$disconnect();

  const outPath = 'sb-rediscovery-discovery.json';
  fs.writeFileSync(outPath, JSON.stringify(discovery, null, 2));
  console.log(`\nDone: ${downloaded} downloaded, ${skipped} skipped, ${failed} failed`);
  console.log(`Discovery JSON: ${outPath} (${discovery.length} entries)`);
  console.log('\nNext: npx tsx scripts/extract-sb-benefits.ts sb-rediscovery-discovery.json --update-db');
})().catch(e => { console.error(e); process.exit(1); });
