// One-shot cleanup: removes blobs under YEAR/<planId>/... (old per-planId scheme)
// and resets stale sbPdfUrl values on Plan rows. Run once before re-uploading
// with the new YEAR/sb-pdfs/<filename>.pdf shared-path scheme.
import "./load-env";
import { PrismaClient } from "@prisma/client";
import { list, del } from "@vercel/blob";

const DRY_RUN = process.argv.includes("--dry-run");
const TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

if (!DRY_RUN && !TOKEN) {
  throw new Error("Missing BLOB_READ_WRITE_TOKEN. Pass --dry-run to preview without deleting.");
}

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL || process.env.DATABASE_URL } },
});

// Old scheme: <year>/H<contract>-<plan>/<filename>.pdf  (planId folder)
// New scheme: <year>/sb-pdfs/<filename>.pdf              (shared folder)
function isOldSchemePath(pathname: string): boolean {
  const parts = pathname.split("/");
  if (parts.length < 3) return false;
  if (!/^\d{4}$/.test(parts[0])) return false;
  if (parts[1] === "sb-pdfs") return false;
  return /^[A-Z]\d{4}-\d{1,3}$/.test(parts[1]);
}

async function main() {
  console.log(`${DRY_RUN ? "[DRY-RUN]" : ""} Listing Vercel Blob entries...`);

  // List all blobs (paginated). Keep only old-scheme paths.
  const toDelete: { url: string; pathname: string; size: number }[] = [];
  let cursor: string | undefined;
  let totalSeen = 0;

  do {
    const page = await list({ token: TOKEN, cursor, limit: 1000 });
    for (const b of page.blobs) {
      totalSeen++;
      if (isOldSchemePath(b.pathname)) {
        toDelete.push({ url: b.url, pathname: b.pathname, size: b.size });
      }
    }
    cursor = page.cursor;
  } while (cursor);

  const totalBytes = toDelete.reduce((sum, b) => sum + b.size, 0);
  console.log(`Scanned ${totalSeen} blob entries; ${toDelete.length} match old per-planId scheme (${(totalBytes / 1024 / 1024).toFixed(2)} MiB).`);

  if (toDelete.length === 0) {
    console.log("Nothing to delete. Skipping DB reset since no stale blobs exist.");
  } else if (DRY_RUN) {
    console.log("[DRY-RUN] Would delete:");
    toDelete.slice(0, 5).forEach((b) => console.log(`  ${b.pathname}  (${b.size} bytes)`));
    if (toDelete.length > 5) console.log(`  ...and ${toDelete.length - 5} more`);
  } else {
    // Delete in batches of 100 (Vercel's hard limit per del call is 1000; 100 is safe and gives nice progress logs).
    const batchSize = 100;
    let deleted = 0;
    for (let i = 0; i < toDelete.length; i += batchSize) {
      const batch = toDelete.slice(i, i + batchSize);
      await del(batch.map((b) => b.url), { token: TOKEN });
      deleted += batch.length;
      console.log(`  Deleted ${deleted}/${toDelete.length}`);
    }
    console.log(`Freed ${(totalBytes / 1024 / 1024).toFixed(2)} MiB across ${toDelete.length} blobs.`);
  }

  // Reset Plan rows. Two reset strategies:
  // - In dry-run: count what would change without writing.
  // - Otherwise: NULL out sb* fields on every row whose URL is on the OLD path.
  console.log();
  const oldSchemeFilter = { sbPdfUrl: { contains: "/2026/H" } } as const;
  const affected = await prisma.plan.count({ where: oldSchemeFilter });
  console.log(`Plan rows with old-scheme sbPdfUrl: ${affected}`);

  if (DRY_RUN) {
    console.log("[DRY-RUN] Would NULL sbPdfUrl / sbPdfSourceFilename / sbDiscoveryConfidence / sbLastProcessedAt on those rows.");
  } else if (affected > 0) {
    const res = await prisma.plan.updateMany({
      where: oldSchemeFilter,
      data: {
        sbPdfUrl: null,
        sbPdfSourceFilename: null,
        sbDiscoveryConfidence: null,
        sbLastProcessedAt: null,
      },
    });
    console.log(`Reset ${res.count} plan rows.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
}).finally(async () => {
  await prisma.$disconnect();
});
