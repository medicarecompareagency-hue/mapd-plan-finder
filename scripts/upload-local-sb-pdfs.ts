import * as fs from 'fs';
import * as path from 'path';
import { put } from '@vercel/blob';
import { makePrisma } from './prisma-client';

// Load .env.local so BLOB_READ_WRITE_TOKEN is available
(function loadEnvLocal() {
  const envPath = path.join(__dirname, '..', '.env.local');
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"]*)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch (_) {}
})();

const MISS_SB_DIR = 'C:\\Users\\dbuir\\OneDrive\\Desktop\\Miss SB';

// ── filename → [planId, ...] parser ─────────────────────────────────────────
function extractPlanIds(filename: string): string[] {
  const results: string[] = [];
  const base = filename.replace(/\s*\(\d+\)\.\w+$/, ''); // strip " (1)"

  // Aetna format: Y0001_H1608_072_... or Y0001-H1608-072-...
  const aetnaRe = /Y0001[_-]H(\d{4})[_-](\d{1,3})(?!\d)/gi;
  for (const m of base.matchAll(aetnaRe)) {
    const id = `H${m[1]}-${parseInt(m[2], 10)}`;
    if (!results.includes(id)) results.push(id);
  }
  // Also match Aetna format: H####-0## in filename (like H0628-021)
  const aetna2Re = /H(\d{4})[_-]0*(\d{1,3})(?!\d)/gi;
  for (const m of base.matchAll(aetna2Re)) {
    const id = `H${m[1]}-${parseInt(m[2], 10)}`;
    if (!results.includes(id)) results.push(id);
  }
  // Standard: H####-## (1-3 digit plan, may have leading zeros in 3-digit)
  const stdRe = /H(\d{4})[-_](\d{1,3})(?!\d)/gi;
  for (const m of base.matchAll(stdRe)) {
    const id = `H${m[1]}-${parseInt(m[2], 10)}`;
    if (!results.includes(id)) results.push(id);
  }
  // Devoted format: -H####-0## (zero-padded 3-digit plan at end)
  const devotedRe = /-H(\d{4})-(\d{3})-/gi;
  for (const m of base.matchAll(devotedRe)) {
    const id = `H${m[1]}-${parseInt(m[2], 10)}`;
    if (!results.includes(id)) results.push(id);
  }
  return [...new Set(results)];
}

// ── scan Miss SB folder recursively ─────────────────────────────────────────
function scanPdfs(): Map<string, string> {
  // Returns: planId → absolute file path (deduped: prefer no-paren version)
  const byBaseName = new Map<string, string>(); // baseName → filepath
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name));
      } else if (entry.name.toLowerCase().endsWith('.pdf')) {
        const filepath = path.join(dir, entry.name);
        const baseName = entry.name.replace(/\s*\(\d+\)(\.\w+)$/, '$1');
        // Skip test files
        if (entry.name.toLowerCase().startsWith('test_')) continue;
        // Skip unresolvable mystery files
        if (/^\d{4,6}-\d{8,}\.pdf$/i.test(entry.name)) continue;
        if (!byBaseName.has(baseName) || !entry.name.includes('(')) {
          byBaseName.set(baseName, filepath);
        }
      }
    }
  };
  walk(MISS_SB_DIR);

  // Map planId → filepath
  const planMap = new Map<string, string>();
  for (const [baseName, filepath] of byBaseName) {
    const ids = extractPlanIds(baseName);
    for (const id of ids) {
      if (!planMap.has(id)) {
        planMap.set(id, filepath);
      }
    }
  }
  return planMap;
}

async function main() {
  const prisma = makePrisma();
  const planMap = scanPdfs();
  console.log(`Found PDFs for ${planMap.size} plan IDs`);

  // Check which planIds actually exist in DB and need sbPdfUrl
  const planIds = [...planMap.keys()];
  const dbPlans = await prisma.plan.findMany({
    where: { planId: { in: planIds } },
    select: { planId: true, sbPdfUrl: true },
    distinct: ['planId'],
  });

  const needsUpload = dbPlans.filter(p => !p.sbPdfUrl).map(p => p.planId);
  const alreadyHas = dbPlans.filter(p => p.sbPdfUrl).map(p => p.planId);
  const notInDb = planIds.filter(id => !dbPlans.find(p => p.planId === id));

  console.log(`  DB match: ${dbPlans.length} | Need upload: ${needsUpload.length} | Already set: ${alreadyHas.length} | Not in DB: ${notInDb.length}`);
  if (notInDb.length) console.log(`  Not in DB: ${notInDb.join(', ')}`);

  let uploaded = 0, failed = 0, skipped = alreadyHas.length;

  for (const planId of needsUpload) {
    const filepath = planMap.get(planId)!;
    const filename = path.basename(filepath);
    try {
      const fileBuffer = fs.readFileSync(filepath);
      const blob = new Blob([fileBuffer], { type: 'application/pdf' });
      // Use a clean blob path
      const blobPath = `sb-pdfs/${planId}-${filename.replace(/\s/g, '_')}`;
      const result = await put(blobPath, blob, { access: 'public', addRandomSuffix: false });
      const url = result.url;

      // Update all county rows for this planId
      const updated = await prisma.plan.updateMany({
        where: { planId },
        data: { sbPdfUrl: url },
      });
      console.log(`  ✓ ${planId}: uploaded → ${url} (${updated.count} rows)`);
      uploaded++;
    } catch (err) {
      console.error(`  ✗ ${planId}: ${(err as Error).message}`);
      failed++;
    }
  }

  // Also propagate: for any planId that has sbPdfUrl in some rows but null in others
  console.log('\nPropagating sbPdfUrl to null county rows...');
  const withUrl = await prisma.plan.findMany({
    where: { sbPdfUrl: { not: null } },
    select: { planId: true, sbPdfUrl: true },
    distinct: ['planId'],
  });
  let propagated = 0;
  for (const { planId, sbPdfUrl } of withUrl) {
    const result = await prisma.plan.updateMany({
      where: { planId, sbPdfUrl: null },
      data: { sbPdfUrl: sbPdfUrl! },
    });
    if (result.count > 0) {
      propagated += result.count;
    }
  }
  console.log(`Propagated to ${propagated} previously-null rows`);

  // Final coverage
  const totalPlans = await prisma.plan.count({ where: { sbPdfUrl: { not: null } }, select: true });
  const totalAll = await prisma.plan.count();
  // Count distinct planIds with sbPdfUrl
  const coveredIds = await prisma.plan.findMany({
    where: { sbPdfUrl: { not: null } },
    select: { planId: true },
    distinct: ['planId'],
  });
  const allIds = await prisma.plan.findMany({
    select: { planId: true },
    distinct: ['planId'],
  });
  console.log(`\n=== SUMMARY ===`);
  console.log(`Uploaded: ${uploaded} | Skipped (already had URL): ${skipped} | Failed: ${failed}`);
  console.log(`SB coverage: ${coveredIds.length} / ${allIds.length} distinct planIds (${totalPlans} / ${totalAll} rows)`);

  await prisma.$disconnect();
}

main().catch(console.error);
