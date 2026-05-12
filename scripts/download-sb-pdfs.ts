import fs from "fs";
import path from "path";

interface DownloadItem {
  url: string;
  filename?: string;
}

async function download(item: DownloadItem, outDir: string) {
  const res = await fetch(item.url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
    },
  });

  if (!res.ok) {
    throw new Error(`Failed ${item.url}: ${res.status}`);
  }

  const contentType = res.headers.get("content-type") || "";

  if (!contentType.includes("pdf")) {
    console.warn(`Skipping non-PDF URL: ${item.url}`);
    return;
  }

  const bytes = Buffer.from(await res.arrayBuffer());

  const filename =
    item.filename ||
    path.basename(new URL(item.url).pathname) ||
    `sb-${Date.now()}.pdf`;

  const outPath = path.join(outDir, filename);

  await fs.promises.writeFile(outPath, bytes);

  console.log(`Downloaded ${filename}`);
}

async function main() {
  const input = process.argv[2] || "./sb-download-list.json";
  const outDir = process.argv[3] || "./summary-of-benefits";

  await fs.promises.mkdir(outDir, { recursive: true });

  const items: DownloadItem[] = JSON.parse(
    await fs.promises.readFile(input, "utf8"),
  );

  for (const item of items) {
    try {
      await download(item, outDir);
    } catch (err) {
      console.error(err);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
