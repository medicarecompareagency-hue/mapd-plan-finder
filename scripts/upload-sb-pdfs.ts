import fs from "fs";
import path from "path";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BUCKET = process.env.SB_BUCKET || "summary-of-benefits";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing Supabase env vars");
}

interface DiscoveryResult {
  file: string;
  planIds: string[];
  year: number | null;
}

async function uploadFile(filePath: string, destination: string) {
  const bytes = await fs.promises.readFile(filePath);

  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${destination}`,
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
}

async function main() {
  const discoveryPath = process.argv[2] || "./sb-discovery-results.json";

  const discovery: DiscoveryResult[] = JSON.parse(
    await fs.promises.readFile(discoveryPath, "utf8"),
  );

  for (const item of discovery) {
    const filename = path.basename(item.file);

    for (const planId of item.planIds) {
      const destination = `${item.year || "unknown"}/${planId}/${filename}`;

      console.log(`Uploading ${filename} -> ${destination}`);

      await uploadFile(item.file, destination);
    }
  }

  console.log("Upload complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
