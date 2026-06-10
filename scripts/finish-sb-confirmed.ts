// scripts/finish-sb-confirmed.ts
// Uploads the 3-4 SerpAPI-confirmed SB PDFs and checks H7787 SB sharing.
// Run: npx tsx scripts/finish-sb-confirmed.ts
// Add --apply to write to DB (default is dry-run).

import './load-env';
import { makePrisma } from './prisma-client';
import { put } from '@vercel/blob';

const APPLY = process.argv.includes('--apply');

// Exact URLs from the SerpAPI filetype:pdf dry-run on 2026-06-08
const CONFIRMED: Array<{ planId: string; org: string; url: string }> = [
  {
    planId: 'H4506-10',
    org: 'Wellcare',
    url: 'https://www.wellcare.com/-/media/pdfs/medicare-2026/sb/h4506_2026_tx_sb_hmapd_4626869eng_m.ashx',
  },
  {
    planId: 'H4506-30',
    org: 'Wellcare',
    url: 'https://www.wellcare.com/-/media/pdfs/medicare-2026/sb/h4506_2026_tx_sb_hmapd_4626869eng_m.ashx',
  },
  {
    planId: 'H5410-59',
    org: 'HealthSpring',
    url: 'https://content.medicareadvantage.com/2026/Cigna-H5410-26-1677901491-M-Summary-of-Benefits-HealthSpring-Preferred-HMO-H5410-059-SB-2026-SF20250923.pdf',
  },
  {
    planId: 'H5525-4',
    org: 'Humana',
    url: 'https://assets.humana.com/is/content/humana/SB079188EN26pdf',
  },
];

async function isPdf(url: string): Promise<{ ok: boolean; status: number; ct: string }> {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
    const ct = res.headers.get('content-type') || '';
    return { ok: res.ok && (ct.includes('pdf') || ct.includes('octet-stream')), status: res.status, ct };
  } catch (e: any) {
    return { ok: false, status: 0, ct: e.message };
  }
}

async function uploadToBlob(url: string, planId: string, org: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const slug = `${planId}-${org.replace(/\s+/g, '-').toLowerCase()}-2026.pdf`;
  const blob = await put(`sb-pdfs/confirmed/${slug}`, buffer, {
    access: 'public',
    contentType: 'application/pdf',
  });
  return blob.url;
}

(async () => {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}\n`);
  const prisma = makePrisma();

  // ── Part 1: Verify and upload confirmed SB URLs ──────────────────────────
  console.log('=== Part 1: Verifying confirmed SB URLs ===');
  const verified: typeof CONFIRMED = [];

  for (const item of CONFIRMED) {
    const check = await isPdf(item.url);
    if (check.ok) {
      console.log(`  VERIFIED ${item.planId}: ${item.url}`);
      verified.push(item);
    } else {
      console.log(`  FAILED   ${item.planId}: HTTP ${check.status} ct="${check.ct}" — skipping`);
    }
  }

  console.log(`\nVerified: ${verified.length} / ${CONFIRMED.length}`);

  if (APPLY && verified.length > 0) {
    console.log('\nUploading...');
    for (const item of verified) {
      try {
        const blobUrl = await uploadToBlob(item.url, item.planId, item.org);
        const result = await prisma.plan.updateMany({
          where: { planId: item.planId, planYear: 2026, sbPdfUrl: null },
          data: { sbPdfUrl: blobUrl },
        });
        console.log(`  LINKED ${item.planId}: ${result.count} rows → ${blobUrl}`);
      } catch (e: any) {
        console.log(`  UPLOAD ERROR ${item.planId}: ${e.message}`);
      }
    }
  }

  // ── Part 2: H7787 SB sharing check ──────────────────────────────────────
  console.log('\n=== Part 2: H7787 SB sharing check ===');

  const h7787All = await prisma.plan.findMany({
    where: { planYear: 2026, planId: { startsWith: 'H7787-' } },
    select: { planId: true, planName: true, organizationName: true, state: true, sbPdfUrl: true },
    distinct: ['planId'],
  });

  const h7787WithSb  = h7787All.filter(p => p.sbPdfUrl);
  const h7787Missing = h7787All.filter(p => !p.sbPdfUrl);

  console.log(`H7787 plans total: ${h7787All.length}`);
  console.log(`H7787 with SB PDF: ${h7787WithSb.length}`);
  console.log(`H7787 missing SB:  ${h7787Missing.length}`);

  if (h7787WithSb.length > 0 && h7787Missing.length > 0) {
    const sharedUrl = h7787WithSb[0].sbPdfUrl!;
    console.log(`\nShared SB URL candidate: ${sharedUrl}`);
    console.log('Plans that would receive this shared URL:');
    for (const p of h7787Missing) {
      console.log(`  ${p.planId} (${p.planName}, ${p.state})`);
    }

    if (APPLY) {
      console.log('\nPropagating shared SB URL to H7787 missing plans...');
      const result = await prisma.plan.updateMany({
        where: {
          planId: { in: h7787Missing.map(p => p.planId) },
          planYear: 2026,
          sbPdfUrl: null,
        },
        data: { sbPdfUrl: sharedUrl },
      });
      console.log(`Propagated to ${result.count} rows`);
    } else {
      console.log('\nDRY-RUN: add --apply to propagate the shared URL');
    }
  } else if (h7787WithSb.length === 0) {
    console.log('No H7787 plans have an SB URL to share — cannot propagate.');
  } else {
    console.log('All H7787 plans already have SB URLs.');
  }

  // ── Part 3: Final coverage ──────────────────────────────────────────────
  console.log('\n=== Final SB Coverage ===');
  const coverage = await prisma.$queryRaw<[{ total: number; with_sb: number }]>`
    SELECT
      count(DISTINCT "planId")::int AS total,
      count(DISTINCT CASE WHEN "sbPdfUrl" IS NOT NULL THEN "planId" END)::int AS with_sb
    FROM "Plan"
    WHERE "planYear" = 2026
    AND state = ANY(ARRAY['AL','AR','FL','GA','IL','IN','KS','KY','LA','MO','MS','OH','OK','SC','TN','TX','VA','WV'])
  `;
  const { total, with_sb } = coverage[0];
  console.log(`${with_sb} / ${total} plans have SB PDFs (${Math.round(with_sb * 100 / total)}%)`);
  console.log(`Still missing: ${total - with_sb} — UHC/Wellcare/Humana require manual download`);

  await prisma.$disconnect();
})();
