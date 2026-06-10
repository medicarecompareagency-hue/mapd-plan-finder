// scripts/retry-sb-pdfs-filetype.ts
// Targeted SerpAPI retry for 206 plans missing SB PDFs.
// Uses filetype:pdf queries + carrier-specific site: constraints.
// Run: npx tsx scripts/retry-sb-pdfs-filetype.ts
// Add --apply to upload and link found PDFs (default is dry-run: search only).

import { makePrisma } from './prisma-client';
import { put } from '@vercel/blob';
import * as fs from 'fs';
import * as path from 'path';

const APPLY = process.argv.includes('--apply');
const SERPAPI_KEY = process.env.SERPAPI_API_KEY || '';

const LICENSED_STATES = [
  'AL','AR','FL','GA','IL','IN','KS','KY','LA',
  'MO','MS','OH','OK','SC','TN','TX','VA','WV',
];

// Carrier -> site: constraint for filetype:pdf search
const CARRIER_SITE: Record<string, string> = {
  'Humana':           'site:humana.com',
  'UnitedHealthcare': 'site:uhc.com OR site:uhcmedicaresolutions.com',
  'Wellcare':         'site:wellcare.com',
  'Cigna':            'site:cigna.com',
  'Aetna Medicare':   'site:aetna.com OR site:aetnamedicare.com',
  'Devoted Health':   'site:devoted.com OR site:devotedhealth.com',
};

function siteFor(org: string): string {
  for (const [key, site] of Object.entries(CARRIER_SITE)) {
    if (org.toLowerCase().includes(key.toLowerCase())) return site;
  }
  return '';
}

// SerpAPI Google search — returns organic result URLs
async function serpSearch(query: string): Promise<string[]> {
  if (!SERPAPI_KEY) throw new Error('SERPAPI_API_KEY not set in environment');
  const params = new URLSearchParams({
    api_key: SERPAPI_KEY,
    engine: 'google',
    q: query,
    num: '5',
  });
  const res = await fetch(`https://serpapi.com/search?${params}`);
  if (res.status === 429) throw new Error('SERPAPI 429 — quota exceeded, stop and wait');
  if (!res.ok) throw new Error(`SerpAPI error ${res.status}`);
  const data: any = await res.json();
  return (data.organic_results || []).map((r: any) => r.link).filter(Boolean);
}

// Check if a URL actually serves a PDF (Content-Type: application/pdf)
async function isPdfUrl(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
    if (!res.ok) return false;
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/pdf') || ct.includes('octet-stream');
  } catch {
    return false;
  }
}

// Upload a PDF URL to Vercel Blob and return the blob URL
async function uploadToBlob(pdfUrl: string, planId: string, org: string): Promise<string> {
  const res = await fetch(pdfUrl, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('pdf') && !ct.includes('octet-stream')) {
    throw new Error(`Not a PDF: ${ct}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const slug = `${planId}-${org.replace(/\s+/g, '-').toLowerCase()}.pdf`;
  const blob = await put(`sb-pdfs/${slug}`, buffer, {
    access: 'public',
    contentType: 'application/pdf',
  });
  return blob.url;
}

// Concurrency limiter
async function withConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  const queue = [...items];
  const workers = Array(Math.min(limit, queue.length)).fill(null).map(async () => {
    while (queue.length > 0) {
      const item = queue.shift()!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

(async () => {
  if (!SERPAPI_KEY) {
    console.error('ERROR: SERPAPI_API_KEY not set. Add it to .env.local');
    process.exit(1);
  }

  console.log(`Mode: ${APPLY ? 'APPLY (will upload + link)' : 'DRY-RUN (search only)'}\n`);
  const prisma = makePrisma();

  // Get all 2026 licensed-state plans with no sbPdfUrl
  console.log('Fetching missing plans from DB...');
  const rows = await prisma.plan.findMany({
    where: {
      planYear: 2026,
      state: { in: LICENSED_STATES },
      sbPdfUrl: null,
    },
    select: {
      planId: true,
      planName: true,
      organizationName: true,
      state: true,
    },
    distinct: ['planId'],
  });
  console.log(`Plans missing SB PDF: ${rows.length}\n`);

  const found:    Array<{ planId: string; org: string; pdfUrl: string; blobUrl?: string }> = [];
  const notFound: string[] = [];
  const errors:   Array<{ planId: string; error: string }> = [];

  await withConcurrency(rows, 2, async (plan) => {
    const site = siteFor(plan.organizationName);
    const query = `"${plan.planId}" 2026 "summary of benefits" filetype:pdf${site ? ' ' + site : ''}`;
    try {
      const urls = await serpSearch(query);
      let pdfUrl: string | null = null;
      for (const url of urls) {
        if (await isPdfUrl(url)) {
          pdfUrl = url;
          break;
        }
      }
      if (pdfUrl) {
        console.log(`  FOUND ${plan.planId} (${plan.organizationName}): ${pdfUrl}`);
        found.push({ planId: plan.planId, org: plan.organizationName, pdfUrl });
      } else {
        console.log(`  NOT FOUND ${plan.planId} (${plan.organizationName}) — ${urls.length} results, none were PDFs`);
        notFound.push(plan.planId);
      }
      // Polite pause between requests
      await new Promise(r => setTimeout(r, 1500));
    } catch (err: any) {
      if (err.message.includes('429')) {
        console.error('\nSERPAPI 429 — stopping to avoid burning quota. Rerun later.');
        process.exit(1);
      }
      console.log(`  ERROR ${plan.planId}: ${err.message}`);
      errors.push({ planId: plan.planId, error: err.message });
    }
  });

  console.log(`\n=== SEARCH RESULTS ===`);
  console.log(`Found PDF URLs: ${found.length}`);
  console.log(`Not found:      ${notFound.length}`);
  console.log(`Errors:         ${errors.length}`);

  if (!APPLY || found.length === 0) {
    if (!APPLY) console.log('\nDRY-RUN complete — add --apply to upload and link found PDFs.');
    await prisma.$disconnect();
    return;
  }

  // Upload found PDFs to Vercel Blob and link in DB
  console.log('\nUploading and linking...');
  let uploaded = 0;
  let uploadFailed = 0;

  for (const item of found) {
    try {
      const blobUrl = await uploadToBlob(item.pdfUrl, item.planId, item.org);
      const result = await prisma.plan.updateMany({
        where: { planId: item.planId, planYear: 2026, sbPdfUrl: null },
        data: { sbPdfUrl: blobUrl },
      });
      uploaded++;
      console.log(`  LINKED ${item.planId}: ${result.count} rows → ${blobUrl}`);
    } catch (err: any) {
      uploadFailed++;
      console.log(`  UPLOAD FAILED ${item.planId}: ${err.message}`);
    }
  }

  console.log(`\nUpload complete: ${uploaded} linked, ${uploadFailed} failed`);

  // Final coverage count
  const coverage = await prisma.$queryRaw<[{ total: number; with_sb: number }]>`
    SELECT
      count(DISTINCT "planId")::int AS total,
      count(DISTINCT CASE WHEN "sbPdfUrl" IS NOT NULL THEN "planId" END)::int AS with_sb
    FROM "Plan"
    WHERE "planYear" = 2026
    AND state = ANY(ARRAY['AL','AR','FL','GA','IL','IN','KS','KY','LA','MO','MS','OH','OK','SC','TN','TX','VA','WV'])
  `;
  const { total, with_sb } = coverage[0];
  console.log(`\nFinal SB coverage: ${with_sb} / ${total} plans (${Math.round(with_sb * 100 / total)}%)`);

  await prisma.$disconnect();
})();
