/**
 * Fix 7 plans whose SB PDFs were corrupted (shared broken xref).
 * Steps:
 *   1. Clear corrupted SB fields from DB
 *   2. Upload fresh PDFs to blob (one unique URL per plan)
 *   3. Write targeted discovery JSON, run extract-sb-benefits.ts
 *   4. Export missing-SB list to OneDrive
 *   5. Print verification table
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { put } from '@vercel/blob';
import { makePrisma } from './prisma-client';

// Load .env and .env.local so both DATABASE_URL and BLOB_READ_WRITE_TOKEN are available.
for (const envFile of ['.env', '.env.local']) {
  const p = path.join(__dirname, '..', envFile);
  try {
    const content = fs.readFileSync(p, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"]*)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch (_) { /* file absent */ }
}

const STAGING = 'C:\\Users\\dbuir\\OneDrive\\Desktop\\Miss SB';

const PLANS = [
  { planId: 'H0439-8',   file: path.join(STAGING, 'HealthSpring', 'H0439-008.pdf') },
  { planId: 'H0439-20',  file: path.join(STAGING, 'HealthSpring', 'H0439-020.pdf') },
  { planId: 'H4513-36',  file: path.join(STAGING, 'HealthSpring', 'H4513-036.pdf') },
  { planId: 'H4513-45',  file: path.join(STAGING, 'HealthSpring', 'H4513-045.pdf') },
  { planId: 'H4513-90',  file: path.join(STAGING, 'HealthSpring', 'H4513-090.pdf') },
  { planId: 'H7849-153', file: path.join(STAGING, 'HealthSpring', 'H7849-153.pdf') },
  { planId: 'H1036-214', file: path.join(STAGING, 'Humana',      'H1036-214.pdf') },
];

async function main() {
  const prisma = makePrisma();

  // ── 1. Clear corrupted SB data ─────────────────────────────────────────────
  console.log('\n=== 1. Clearing corrupted SB data ===');
  for (const { planId } of PLANS) {
    const r = await prisma.plan.updateMany({
      where: { planId },
      data: {
        sbPdfUrl: null,
        sbPdfChecksum: null,
        sbPdfSourceFilename: null,
        sbVerifiedOtcAmount: null,
        sbVerifiedFoodAmount: null,
        sbVerifiedOtcPeriod: null,
        sbVerifiedFoodPeriod: null,
        sbLastProcessedAt: null,
        sbDiscoveryConfidence: null,
        ssbciIsConditional: false,
        ssbciIsStandalone: false,
        ssbciConditionNote: null,
      },
    });
    console.log(`  cleared ${planId}: ${r.count} rows`);
  }

  // ── 2. Upload fresh PDFs to blob ───────────────────────────────────────────
  console.log('\n=== 2. Uploading fresh PDFs to blob ===');
  const urlMap = new Map<string, string>();
  for (const { planId, file } of PLANS) {
    if (!fs.existsSync(file)) {
      throw new Error(`Staged PDF not found: ${file}`);
    }
    const filename = path.basename(file);
    const buffer = fs.readFileSync(file);
    const blob = new Blob([buffer], { type: 'application/pdf' });
    const blobPath = `sb-pdfs/${planId}-${filename.replace(/\s/g, '_')}`;
    const result = await put(blobPath, blob, { access: 'public', addRandomSuffix: false });
    const url = result.url;
    urlMap.set(planId, url);
    const r = await prisma.plan.updateMany({ where: { planId }, data: { sbPdfUrl: url } });
    console.log(`  ✓ ${planId}: ...${url.slice(-30)} (${r.count} rows)`);
  }

  // Verify all 7 have distinct URLs
  const urls = [...urlMap.values()];
  const uniqueUrls = new Set(urls);
  if (uniqueUrls.size !== urls.length) {
    console.warn(`  ⚠ WARNING: ${urls.length - uniqueUrls.size} duplicate URLs detected!`);
  } else {
    console.log(`  ✓ All 7 blob URLs are distinct`);
  }

  // ── 3. Write discovery JSON and run extraction ─────────────────────────────
  console.log('\n=== 3. Creating discovery JSON ===');
  const discovery = PLANS.map(({ planId, file }) => ({
    file,
    planIds: [planId],
    year: 2026,
    yearSource: 'download-list',
    yearConfidence: 0.95,
    filenameYear: null,
    downloadListYear: 2026,
    documentTitleYear: null,
    textFallbackYear: null,
    textYears: [2026],
    warnings: [],
  }));
  const discoveryPath = path.join(process.cwd(), 'sb-discovery-7-corrupted.json');
  fs.writeFileSync(discoveryPath, JSON.stringify(discovery, null, 2));
  console.log(`  wrote ${discoveryPath}`);

  console.log('\n=== 4. Running SB extraction ===');
  execSync(
    `npx tsx scripts/extract-sb-benefits.ts sb-discovery-7-corrupted.json --update-db`,
    { stdio: 'inherit', cwd: process.cwd() },
  );

  // ── 4. Export missing-SB list ──────────────────────────────────────────────
  console.log('\n=== 5. Exporting missing-SB list ===');

  // Distinct plan-level rows for 2026
  const plans2026 = await prisma.plan.findMany({
    where: { planYear: 2026 },
    select: {
      planId: true,
      planName: true,
      organizationName: true,
      sbPdfUrl: true,
      sbLastProcessedAt: true,
      sbVerifiedOtcAmount: true,
      sbVerifiedFoodAmount: true,
    },
    distinct: ['planId'],
    orderBy: { planId: 'asc' },
  });

  // Filter out EGWP (plan number >= 800)
  function planNumber(planId: string): number {
    const m = planId.match(/H\d{4}-(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }
  const sellable = plans2026.filter(p => planNumber(p.planId) < 800);

  // Aggregate states for missing planIds
  const missingIds = sellable
    .filter(p => !p.sbPdfUrl || !p.sbLastProcessedAt || (!p.sbVerifiedOtcAmount && !p.sbVerifiedFoodAmount))
    .map(p => p.planId);

  const stateRows = await prisma.plan.findMany({
    where: { planId: { in: missingIds } },
    select: { planId: true, state: true },
  });
  const stateAgg = new Map<string, Set<string>>();
  for (const { planId, state } of stateRows) {
    if (state) {
      if (!stateAgg.has(planId)) stateAgg.set(planId, new Set());
      stateAgg.get(planId)!.add(state);
    }
  }

  const csvRows: string[] = ['planId,planName,carrier,states,reason'];
  for (const p of sellable) {
    let reason: string | null = null;
    if (!p.sbPdfUrl) {
      reason = 'no_pdf';
    } else if (!p.sbLastProcessedAt) {
      reason = 'corrupted';
    } else if (!p.sbVerifiedOtcAmount && !p.sbVerifiedFoodAmount) {
      reason = 'extract_failed';
    }
    if (!reason) continue;

    const states = [...(stateAgg.get(p.planId) ?? [])].sort().join('|');
    const name = (p.planName ?? '').replace(/"/g, "'");
    const carrier = (p.organizationName ?? '').replace(/"/g, "'");
    csvRows.push(`${p.planId},"${name}","${carrier}","${states}",${reason}`);
  }

  const csvPath = 'C:\\Users\\dbuir\\OneDrive\\Documents\\Claude\\Projects\\MAPD Plan Finder\\missing-sb-plans-2026-06-11.csv';
  fs.writeFileSync(csvPath, csvRows.join('\r\n') + '\r\n');
  const missingCount = csvRows.length - 1;
  console.log(`  wrote ${csvPath} (${missingCount} missing plans)`);

  const byReason: Record<string, number> = {};
  for (const row of csvRows.slice(1)) {
    const reason = row.split(',').pop()!;
    byReason[reason] = (byReason[reason] ?? 0) + 1;
  }
  for (const [reason, count] of Object.entries(byReason)) {
    console.log(`    ${reason}: ${count}`);
  }

  // ── 5. Verification table ──────────────────────────────────────────────────
  console.log('\n=== 6. Verification ===');
  const verified = await prisma.plan.findMany({
    where: { planId: { in: PLANS.map(p => p.planId) } },
    select: {
      planId: true,
      sbPdfUrl: true,
      sbVerifiedOtcAmount: true,
      sbVerifiedOtcPeriod: true,
      sbVerifiedFoodAmount: true,
      sbVerifiedFoodPeriod: true,
      ssbciIsConditional: true,
    },
    distinct: ['planId'],
    orderBy: { planId: 'asc' },
  });

  console.log('\nplanId        | blob URL (last 20 chars) | OTC                | Food               | SSBCI');
  console.log('-------------|------------------------|--------------------|--------------------|------');
  for (const p of verified) {
    const url = p.sbPdfUrl ? `...${p.sbPdfUrl.slice(-20)}` : 'MISSING';
    const otc = p.sbVerifiedOtcAmount != null
      ? `$${p.sbVerifiedOtcAmount}/${p.sbVerifiedOtcPeriod ?? '?'}`
      : 'n/a';
    const food = p.sbVerifiedFoodAmount != null
      ? `$${p.sbVerifiedFoodAmount}/${p.sbVerifiedFoodPeriod ?? '?'}`
      : 'n/a';
    const gated = p.ssbciIsConditional ? 'gated' : 'no';
    console.log(
      `${p.planId.padEnd(13)} | ${url.padEnd(24)} | ${otc.padEnd(18)} | ${food.padEnd(18)} | ${gated}`
    );
  }

  console.log(`\nTotal missing-SB plans: ${missingCount}`);
  console.log('\nDone.');
  await prisma.$disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
