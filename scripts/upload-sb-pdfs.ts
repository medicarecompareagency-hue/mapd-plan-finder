import "./load-env";
import fs from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { put } from "@vercel/blob";

const DRY_RUN = process.argv.includes("--dry-run");

type StorageBackend = "vercel" | "supabase";
function resolveStorageBackend(): StorageBackend {
  const flag = process.argv.find((a) => a.startsWith("--storage="));
  const value = (flag?.split("=")[1] ?? process.env.SB_STORAGE_BACKEND ?? "vercel").toLowerCase();
  if (value === "supabase") return "supabase";
  if (value === "vercel" || value === "blob") return "vercel";
  throw new Error(`Unknown storage backend: ${value}. Use --storage=vercel or --storage=supabase.`);
}
const STORAGE: StorageBackend = resolveStorageBackend();

const BUCKET = process.env.SB_BUCKET || "summary-of-benefits";
const PUBLIC_URL_BASE = process.env.SB_STORAGE_PUBLIC_URL_BASE;

// Supabase config (only required when --storage=supabase and not dry-run)
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Vercel Blob config (only required when --storage=vercel and not dry-run)
const BLOB_READ_WRITE_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

if (!DRY_RUN) {
  if (STORAGE === "vercel" && !BLOB_READ_WRITE_TOKEN) {
    throw new Error(
      "Missing BLOB_READ_WRITE_TOKEN env var for Vercel Blob uploads. " +
        "Connect a Blob store to this project (Vercel Storage → Blob), then `vercel env pull`. " +
        "Pass --dry-run to skip credential checks."
    );
  }
  if (STORAGE === "supabase" && (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)) {
    throw new Error(
      "Missing Supabase env vars (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) for --storage=supabase. " +
        "Pass --dry-run to skip credential checks."
    );
  }
}

const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DIRECT_URL || process.env.DATABASE_URL },
  },
});

interface DiscoveryResult {
  file: string;
  planIds: string[];
  year: number | null;
  yearConfidence?: number;
}

function normalizePlanId(value: string): string {
  const match = value.toUpperCase().match(/\b([A-Z]\d{4})[-_ ]?0*(\d{1,3})\b/);
  if (!match) return value.toUpperCase().trim();
  return `${match[1]}-${Number(match[2])}`;
}

function encodeStoragePath(destination: string): string {
  return destination.split("/").map(encodeURIComponent).join("/");
}

function placeholderUrl(destination: string): string {
  const encodedPath = encodeStoragePath(destination);
  if (PUBLIC_URL_BASE) return `${PUBLIC_URL_BASE.replace(/\/$/, "")}/${encodedPath}`;
  if (STORAGE === "supabase" && SUPABASE_URL) {
    return `${SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object/public/${BUCKET}/${encodedPath}`;
  }
  return `placeholder://${BUCKET}/${encodedPath}`;
}

async function uploadVercelBlob(filePath: string, destination: string): Promise<string> {
  const bytes = await fs.promises.readFile(filePath);
  const blob = await put(destination, bytes, {
    access: "public",
    contentType: "application/pdf",
    token: BLOB_READ_WRITE_TOKEN!,
    addRandomSuffix: false,
    allowOverwrite: true,
  });
  return blob.url;
}

async function uploadSupabase(filePath: string, destination: string): Promise<string> {
  const host = SUPABASE_URL as string;
  const key = SUPABASE_SERVICE_ROLE_KEY as string;
  const bytes = await fs.promises.readFile(filePath);

  const res = await fetch(
    `${host}/storage/v1/object/${BUCKET}/${encodeStoragePath(destination)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        apikey: key,
        "Content-Type": "application/pdf",
        "x-upsert": "true",
      },
      body: bytes,
    },
  );

  if (!res.ok) {
    throw new Error(`Supabase upload failed: ${res.status} ${await res.text()}`);
  }

  const encodedPath = encodeStoragePath(destination);
  if (PUBLIC_URL_BASE) return `${PUBLIC_URL_BASE.replace(/\/$/, "")}/${encodedPath}`;
  return `${host.replace(/\/$/, "")}/storage/v1/object/public/${BUCKET}/${encodedPath}`;
}

async function uploadFile(filePath: string, destination: string): Promise<string> {
  if (STORAGE === "vercel") return uploadVercelBlob(filePath, destination);
  return uploadSupabase(filePath, destination);
}

async function updatePlanUrl(item: DiscoveryResult, planId: string, filename: string, url: string, dryRun: boolean) {
  if (!item.year) {
    console.warn(`Skipping DB update for ${filename}: discovery year is missing`);
    return;
  }

  const normalizedPlanId = normalizePlanId(planId);
  const data = {
    sbPdfUrl: url,
    sbPdfSourceFilename: filename,
    sbDiscoveryConfidence: item.yearConfidence ?? undefined,
    sbLastProcessedAt: new Date(),
  };

  console.log(`${dryRun ? "Would update" : "Updating"} ${normalizedPlanId} ${item.year} sbPdfUrl -> ${url}`);

  if (!dryRun) {
    await prisma.plan.updateMany({
      where: { planId: normalizedPlanId, planYear: item.year },
      data,
    });
  }
}

async function main() {
  const discoveryPath = process.argv.slice(2).find((arg) => !arg.startsWith("--")) || "./sb-discovery-results.json";
  const skipDb = process.argv.includes("--no-db");

  console.log(`Storage backend: ${STORAGE}${DRY_RUN ? " (dry-run)" : ""}`);

  const discovery: DiscoveryResult[] = JSON.parse(
    await fs.promises.readFile(discoveryPath, "utf8"),
  );

  // Cache URLs per unique (year, filename) so each PDF is uploaded once.
  // All matching planIds get pointed at the same shared blob URL.
  const uploadedUrl = new Map<string, string>();
  let uniqueUploaded = 0;
  let totalRowUpdates = 0;

  for (const item of discovery) {
    const filename = path.basename(item.file);
    const yearKey = item.year || "unknown";
    const destination = `${yearKey}/sb-pdfs/${filename}`;
    const cacheKey = `${yearKey}::${filename}`;

    let url = uploadedUrl.get(cacheKey);
    if (!url) {
      console.log(`${DRY_RUN ? "Would upload" : "Uploading"} ${filename} -> ${destination}`);
      url = DRY_RUN ? placeholderUrl(destination) : await uploadFile(item.file, destination);
      uploadedUrl.set(cacheKey, url);
      uniqueUploaded++;
    } else {
      console.log(`Reusing existing blob URL for ${filename}`);
    }

    for (const planId of item.planIds) {
      if (!skipDb) {
        await updatePlanUrl(item, planId, filename, url, DRY_RUN);
        totalRowUpdates++;
      }
    }
  }

  console.log(`Upload complete: ${uniqueUploaded} unique PDF blob${uniqueUploaded === 1 ? "" : "s"} ${DRY_RUN ? "would be" : ""} written; ${totalRowUpdates} plan row updateMany call${totalRowUpdates === 1 ? "" : "s"} ${DRY_RUN ? "would run" : "executed"}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
}).finally(async () => {
  await prisma.$disconnect();
});
