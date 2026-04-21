/**
 * prepare-pbp.ts
 *
 * Standalone download + extract of the CMS PBP Benefits ZIP for a given
 * plan year. NO database operations. This exists so you can get
 * `pbp_Section_A.txt` on disk without triggering the full 3.5-hour
 * import flow when all you really need is raw files.
 *
 *   npx tsx scripts/prepare-pbp.ts 2025
 */

import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as http from "http";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { execSync } from "child_process";

const args = process.argv.slice(2);
const PLAN_YEAR = parseInt(args.find((a) => /^\d{4}$/.test(a)) || "2026", 10);
const WORK_DIR = path.join(process.cwd(), ".cms-import-tmp");

async function downloadFile(url: string, dest: string): Promise<void> {
  const client = url.startsWith("https") ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadFile(res.headers.location, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const out = createWriteStream(dest);
      pipeline(res, out).then(resolve, reject);
    });
    req.on("error", reject);
  });
}

async function main() {
  if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR, { recursive: true });
  const zipPath = path.join(WORK_DIR, `pbp-benefits-${PLAN_YEAR}.zip`);
  const extractDir = path.join(WORK_DIR, `pbp-${PLAN_YEAR}`);
  const url = `https://www.cms.gov/files/zip/pbp-benefits-${PLAN_YEAR}.zip`;

  if (fs.existsSync(path.join(extractDir, "pbp_Section_A.txt"))) {
    console.log(`Already prepared: ${extractDir}`);
    return;
  }

  if (!fs.existsSync(zipPath)) {
    console.log(`Downloading ${url}...`);
    await downloadFile(url, zipPath);
    console.log(`  ${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB`);
  } else {
    console.log(`ZIP cached at ${zipPath}`);
  }

  if (!fs.existsSync(extractDir)) {
    console.log("Extracting...");
    fs.mkdirSync(extractDir, { recursive: true });
    try {
      execSync(`unzip -o -q "${zipPath}" -d "${extractDir}"`, { stdio: "pipe" });
    } catch {
      execSync(
        `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`,
        { stdio: "pipe" },
      );
    }
  }

  if (!fs.existsSync(path.join(extractDir, "pbp_Section_A.txt"))) {
    throw new Error(
      `Extract completed but pbp_Section_A.txt not found under ${extractDir}.`,
    );
  }
  console.log(`Ready: ${extractDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
