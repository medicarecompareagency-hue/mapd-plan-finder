// Upload SB PDFs directly from sb-download-list.json to Vercel Blob,
// then write the Blob URL to plan.sbPdfUrl for all matching rows.
// Resumable: skips plans that already have sbPdfUrl set.
// Run: npx tsx scripts/upload-from-download-list.ts
import "./load-env";
import fs from "fs";
import path from "path";
import { put } from "@vercel/blob";
import { makePrisma } from "./prisma-client.js";

const DRY_RUN = process.argv.includes("--dry-run");
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const INPUT = process.argv.find((a) => !a.startsWith("-") && a.endsWith(".json")) ?? "./sb-download-list.json";
const MIN_CONFIDENCE = parseFloat(process.env.MIN_CONFIDENCE ?? "0.78");

if (!DRY_RUN && !BLOB_TOKEN) throw new Error("Missing BLOB_READ_WRITE_TOKEN");

interface DownloadItem {
  planId: string;
  planYear: number;
  organizationName: string;
  url: string;
  confidence: number;
  filename?: string;
  states?: string[];
}

function normalizePlanId(value: string): string {
  const m = value.toUpperCase().match(/\b([A-Z]\d{4})[-_ ]?0*(\d{1,3})\b/);
  if (!m) return value.toUpperCase().trim();
  return `${m[1]}-${Number(m[2])}`;
}

function slugPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

async function fetchPdfBytes(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("pdf") && !url.toLowerCase().includes(".pdf")) {
    throw new Error(`Not a PDF (content-type: ${ct})`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const prisma = makePrisma();
  const items: DownloadItem[] = JSON.parse(await fs.promises.readFile(path.resolve(INPUT), "utf8"));
  console.log(`Loaded ${items.length} items from ${INPUT} (min_confidence=${MIN_CONFIDENCE})`);

  // Dedupe by planId+year — keep highest-confidence entry
  const best = new Map<string, DownloadItem>();
  for (const item of items) {
    if (item.confidence < MIN_CONFIDENCE) continue;
    const key = `${normalizePlanId(item.planId)}|${item.planYear}`;
    const prev = best.get(key);
    if (!prev || item.confidence > prev.confidence) best.set(key, item);
  }
  console.log(`Unique planId+year combos above threshold: ${best.size}`);

  // Check which plans already have sbPdfUrl (skip them — resumable)
  const alreadyLinked = new Set<string>();
  const allPlanIds = [...best.keys()].map((k) => k.split("|")[0]);
  const existingRows = await prisma.plan.findMany({
    where: { planId: { in: allPlanIds }, planYear: 2026, sbPdfUrl: { not: null } },
    select: { planId: true },
  });
  for (const r of existingRows) alreadyLinked.add(r.planId);
  console.log(`Already linked: ${alreadyLinked.size}, to process: ${best.size - alreadyLinked.size}`);

  let uploaded = 0, skipped = 0, failed = 0;
  const failures: Array<{ planId: string; error: string }> = [];

  for (const [key, item] of best.entries()) {
    const planId = normalizePlanId(item.planId);
    if (alreadyLinked.has(planId)) { skipped++; continue; }

    const fname = item.filename
      ?? `sb-${item.planYear}-${planId.replace("-", "_")}-${slugPart(item.organizationName)}.pdf`;
    const destination = `${item.planYear}/sb-pdfs/${fname}`;

    try {
      let blobUrl: string;
      if (DRY_RUN) {
        blobUrl = `https://dry-run.blob/${destination}`;
        console.log(`[dry-run] Would upload ${planId} → ${destination}`);
      } else {
        const bytes = await fetchPdfBytes(item.url);
        const blob = await put(destination, bytes, {
          access: "public",
          contentType: "application/pdf",
          token: BLOB_TOKEN!,
          addRandomSuffix: false,
          allowOverwrite: true,
        });
        blobUrl = blob.url;
        console.log(`Uploaded ${planId} → ${blobUrl.slice(0, 80)}`);
      }

      if (!DRY_RUN) {
        await prisma.plan.updateMany({
          where: { planId, planYear: item.planYear },
          data: { sbPdfUrl: blobUrl, sbDiscoveryConfidence: item.confidence, sbLastProcessedAt: new Date() },
        });
      }
      uploaded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`FAILED ${planId}: ${msg}`);
      failures.push({ planId, error: msg });
      failed++;
    }
  }

  console.log(`\n=== Done ===`);
  console.log(`Uploaded+linked: ${uploaded}`);
  console.log(`Skipped (already had URL): ${skipped}`);
  console.log(`Failed: ${failed}`);
  if (failures.length) {
    console.log("Failures:");
    for (const f of failures) console.log(`  ${f.planId}: ${f.error}`);
  }

  await prisma.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
