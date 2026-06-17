// One-shot: download H5435-1 and H5435-24 from Blob and build discovery JSON for extract-sb-benefits.ts
const fs = require('fs'), path = require('path');
const { makePrisma } = require('./prisma-client');

for (const envFile of ['.env', '.env.local']) {
  const p = path.join(__dirname, '..', envFile);
  try { const c = fs.readFileSync(p, 'utf8'); for (const l of c.split(/\r?\n/)) { const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n\r]*)"?\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; } } catch {}
}

const SB_DIR = path.join(process.cwd(), 'summary-of-benefits-rediscovered');
if (!fs.existsSync(SB_DIR)) fs.mkdirSync(SB_DIR, { recursive: true });

const PLAN_IDS = ['H5435-1', 'H5435-24'];

(async () => {
  const prisma = makePrisma();
  const discovery = [];

  for (const planId of PLAN_IDS) {
    const row = await prisma.plan.findFirst({
      where: { planId, planYear: 2026, sbPdfUrl: { not: null } },
      select: { sbPdfUrl: true },
    });
    if (!row?.sbPdfUrl) { console.log(`SKIP ${planId}: no sbPdfUrl`); continue; }

    const localPath = path.join(SB_DIR, `${planId}.pdf`);
    if (!fs.existsSync(localPath)) {
      console.log(`Downloading ${planId}...`);
      const r = await fetch(row.sbPdfUrl, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) { console.log(`FAIL ${planId}: HTTP ${r.status}`); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(localPath, buf);
      console.log(`  ${buf.length} bytes`);
    } else {
      console.log(`${planId}: already cached`);
    }

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
      organization: 'UnitedHealthcare',
      warnings: [],
    });
  }

  await prisma.$disconnect();

  const outPath = 'sb-h5435-discovery.json';
  fs.writeFileSync(outPath, JSON.stringify(discovery, null, 2));
  console.log(`\nWrote ${outPath} (${discovery.length} entries)`);
  console.log('Next: npx tsx scripts/extract-sb-benefits.ts sb-h5435-discovery.json --update-db');
})().catch(e => { console.error(e); process.exit(1); });
