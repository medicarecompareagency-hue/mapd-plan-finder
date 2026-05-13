import fs from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BUCKET = process.env.SB_BUCKET || "summary-of-benefits";
const PUBLIC_URL_BASE = process.env.SB_STORAGE_PUBLIC_URL_BASE;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing Supabase env vars");
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

function publicUrl(destination: string): string {
  const encodedPath = encodeStoragePath(destination);
  if (PUBLIC_URL_BASE) return `${PUBLIC_URL_BASE.replace(/\/$/, "")}/${encodedPath}`;
  return `${SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object/public/${BUCKET}/${encodedPath}`;
}

async function uploadFile(filePath: string, destination: string): Promise<string> {
  const bytes = await fs.promises.readFile(filePath);

  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeStoragePath(destination)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        "Content-Type": "application/pdf",
        "x-upsert": "true",
      },
      body: bytes,
    },
  );

  if (!res.ok) {
    throw new Error(`Upload failed: ${res.status} ${await res.text()}`);
  }

  return publicUrl(destination);
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
  const dryRun = process.argv.includes("--dry-run");
  const skipDb = process.argv.includes("--no-db");

  const discovery: DiscoveryResult[] = JSON.parse(
    await fs.promises.readFile(discoveryPath, "utf8"),
  );

  for (const item of discovery) {
    const filename = path.basename(item.file);

    for (const planId of item.planIds) {
      const destination = `${item.year || "unknown"}/${planId}/${filename}`;

      console.log(`Uploading ${filename} -> ${destination}`);

      const url = dryRun ? publicUrl(destination) : await uploadFile(item.file, destination);
      if (!skipDb) await updatePlanUrl(item, planId, filename, url, dryRun);
    }
  }

  console.log("Upload complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
}).finally(async () => {
  await prisma.$disconnect();
});
