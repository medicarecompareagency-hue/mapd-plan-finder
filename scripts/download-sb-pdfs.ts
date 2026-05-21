import fs from "fs";
import path from "path";

interface DownloadItem {
  url: string;
  filename?: string;
  planId?: string;
  planYear?: number;
  organizationName?: string;
  state?: string;
  county?: string;
}

function slugPart(value: string | undefined): string | null {
  if (!value) return null;
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return slug || null;
}

function filenameFor(item: DownloadItem): string {
  if (item.filename) return item.filename;

  if (item.planId && item.planYear) {
    const parts = [
      "sb",
      String(item.planYear),
      item.planId.replace(/[^a-z0-9]+/gi, "_"),
      slugPart(item.organizationName),
      slugPart(item.state),
      slugPart(item.county),
    ].filter(Boolean);
    return `${parts.join("-")}.pdf`;
  }

  return path.basename(new URL(item.url).pathname) || `sb-${Date.now()}.pdf`;
}

async function download(item: DownloadItem, outDir: string): Promise<"ok" | "skip" | "fail"> {
  if (!item.url) {
    console.warn("Skipping item without a URL");
    return "skip";
  }

  const filename = filenameFor(item);
  const outPath = path.join(outDir, filename);

  // Resumable: skip files already on disk so the run can be chunked/retried.
  if (fs.existsSync(outPath)) return "skip";

  const res = await fetch(item.url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(25000),
  });

  if (!res.ok) {
    throw new Error(`Failed ${item.url}: ${res.status}`);
  }

  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("pdf")) {
    console.warn(`Skipping non-PDF URL: ${item.url}`);
    return "skip";
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  await fs.promises.writeFile(outPath, bytes);
  console.log(`Downloaded ${filename}`);
  return "ok";
}

async function main() {
  const input = process.argv[2] || "./sb-download-list.json";
  const outDir = process.argv[3] || "./summary-of-benefits";

  await fs.promises.mkdir(outDir, { recursive: true });

  const items: DownloadItem[] = JSON.parse(
    await fs.promises.readFile(input, "utf8"),
  );

  const CONCURRENCY = Number(process.env.DOWNLOAD_CONCURRENCY || 8);
  let cursor = 0;
  const counts = { ok: 0, skip: 0, fail: 0 };
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      try {
        counts[await download(item, outDir)] += 1;
      } catch (err) {
        counts.fail += 1;
        console.error(`Download error: ${(err as Error).message}`);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, () => worker()),
  );
  console.log(`Done. downloaded=${counts.ok} skipped=${counts.skip} failed=${counts.fail}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
