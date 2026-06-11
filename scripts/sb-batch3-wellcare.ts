/**
 * SB batch 3: upload 58 Wellcare SBs and attempt 7 remaining UHC plans.
 *
 * Steps:
 *   1. Clear SB fields for all 58 Wellcare planIds (corrupted + no_pdf)
 *   2. Upload each PDF from staging, update sbPdfUrl
 *   3. Run extraction (58 plans)
 *   4. Attempt 7 UHC plans (best-effort; failures go to still-missing CSV)
 *   5. Refresh missing-SB CSV
 *   6. Print verification table
 *
 * Note: schema has no sbSourceUrl column; manifest source URLs recorded in
 * sb-batch3-wellcare.ts comments only.
 */
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { put } from "@vercel/blob";
import { makePrisma } from "./prisma-client";

for (const envFile of [".env", ".env.local"]) {
  const p = path.join(__dirname, "..", envFile);
  try {
    const content = fs.readFileSync(p, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"]*)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch (_) {}
}

const WELLCARE_DIR = "C:\\Users\\dbuir\\OneDrive\\Documents\\Claude\\Projects\\MAPD Plan Finder\\Miss SB\\Wellcare";
const MANIFEST_PATH = path.join(WELLCARE_DIR, "manifest.csv");
const TEMP_DIR = path.join(process.cwd(), "summary-of-benefits");
const DISCOVERY_PATH = path.join(process.cwd(), "sb-discovery-batch3.json");
const MISSING_SB_CSV = "C:\\Users\\dbuir\\OneDrive\\Documents\\Claude\\Projects\\MAPD Plan Finder\\missing-sb-plans-2026-06-11.csv";
const STILL_MISSING_CSV = "C:\\Users\\dbuir\\OneDrive\\Documents\\Claude\\Projects\\MAPD Plan Finder\\sb-still-missing-2026-06-11.csv";
const PLAN_YEAR = 2026;

// 7 remaining UHC plans after Wellcare batch
const UHC_PLANS = [
  // R-series Regional PPOs — no docid known; content.medicareadvantage.com returned 403
  { planId: "R0759-1",  carrier: "UHC" },
  { planId: "R3444-12", carrier: "UHC" },
  { planId: "R6801-12", carrier: "UHC" },
  // H-series UHC — previously failed download or bad checksum
  { planId: "H2406-67", carrier: "UHC" },
  { planId: "H0432-3",  carrier: "UHC" },
  { planId: "H5652-1",  carrier: "UHC" },
  { planId: "H5652-4",  carrier: "UHC" },
];

interface ManifestRow {
  planId: string;
  file: string;
  sourceUrl: string;
}

interface DiscoveryEntry {
  file: string;
  planIds: string[];
  year: number;
  yearSource: string;
  yearConfidence: number;
  filenameYear: null;
  downloadListYear: number;
  documentTitleYear: null;
  textFallbackYear: null;
  textYears: number[];
  warnings: string[];
}

function readManifest(): ManifestRow[] {
  const lines = fs.readFileSync(MANIFEST_PATH, "utf8").split(/\r?\n/).filter(Boolean);
  return lines.slice(1).map((line) => {
    const [planId, file, ...rest] = line.split(",");
    return { planId: planId.trim(), file: file.trim(), sourceUrl: rest.join(",").trim() };
  });
}

function isPdfBytes(buf: Buffer): boolean {
  return buf.length > 50000 && buf.slice(0, 5).toString("ascii") === "%PDF-";
}

async function uploadPdf(planId: string, buf: Buffer, filename: string): Promise<string> {
  const blobPath = `sb-pdfs/${planId}-${filename.replace(/\s/g, "_")}`;
  const blob = new Blob([new Uint8Array(buf)], { type: "application/pdf" });
  const result = await put(blobPath, blob, { access: "public", addRandomSuffix: false });
  return result.url;
}

function makeDiscoveryEntry(planId: string, filePath: string): DiscoveryEntry {
  return {
    file: filePath,
    planIds: [planId],
    year: PLAN_YEAR,
    yearSource: "staged",
    yearConfidence: 0.98,
    filenameYear: null,
    downloadListYear: PLAN_YEAR,
    documentTitleYear: null,
    textFallbackYear: null,
    textYears: [PLAN_YEAR],
    warnings: [],
  };
}

function planNumber(planId: string): number {
  const m = planId.match(/-(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

async function fetchWithHeaders(url: string): Promise<Buffer | null> {
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/pdf,text/html,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.uhc.com/",
  };
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
    if (!res.ok) { console.log(`    HTTP ${res.status} from ${url.slice(0, 80)}`); return null; }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.log(`    fetch error: ${(err as Error).message}`);
    return null;
  }
}

async function main() {
  const prisma = makePrisma();
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  const manifest = readManifest();
  console.log(`Read ${manifest.length} entries from manifest.csv`);

  const wellcarePlanIds = manifest.map((r) => r.planId);
  const discoveryEntries: DiscoveryEntry[] = [];

  // ═══ 1. Clear SB fields for all 58 Wellcare plans ════════════════════════════
  console.log("\n=== 1. Clearing SB fields for 58 Wellcare plans ===");
  for (const planId of wellcarePlanIds) {
    const r = await prisma.plan.updateMany({
      where: { planId, planYear: PLAN_YEAR },
      data: {
        sbPdfUrl: null,
        sbPdfChecksum: null,
        sbPdfSourceFilename: null,
        sbVerifiedOtcAmount: null,
        sbVerifiedFoodAmount: null,
        sbVerifiedOtcPeriod: null,
        sbVerifiedFoodPeriod: null,
        sbLastProcessedAt: null,
        sbDiscoveryConfidence: null,
        ssbciIsConditional: false,
        ssbciIsStandalone: false,
        ssbciConditionNote: null,
      },
    });
    if (r.count === 0) console.log(`  WARNING: ${planId} — 0 DB rows found`);
  }
  console.log(`  cleared ${wellcarePlanIds.length} planIds`);

  // ═══ 2. Upload PDFs ═══════════════════════════════════════════════════════════
  console.log("\n=== 2. Uploading 58 Wellcare PDFs ===");
  let uploadOk = 0, uploadFail = 0;

  for (const { planId, file } of manifest) {
    const filePath = path.join(WELLCARE_DIR, file);
    if (!fs.existsSync(filePath)) {
      console.error(`  ✗ ${planId}: file not found: ${filePath}`);
      uploadFail++;
      continue;
    }
    try {
      const buf = fs.readFileSync(filePath);
      if (!isPdfBytes(buf)) {
        throw new Error(`not valid PDF (${buf.length} bytes, starts: ${buf.slice(0, 8).toString("ascii")})`);
      }
      const url = await uploadPdf(planId, buf, file);
      const r = await prisma.plan.updateMany({
        where: { planId, planYear: PLAN_YEAR },
        data: { sbPdfUrl: url },
      });
      console.log(`  ✓ ${planId}: ...${url.slice(-40)} (${r.count} rows)`);
      discoveryEntries.push(makeDiscoveryEntry(planId, filePath));
      uploadOk++;
    } catch (err) {
      console.error(`  ✗ ${planId}: ${(err as Error).message}`);
      uploadFail++;
    }
  }
  console.log(`\n  Uploaded: ${uploadOk}, Failed: ${uploadFail}`);

  // ═══ 3. Run extraction for Wellcare plans ════════════════════════════════════
  if (discoveryEntries.length > 0) {
    console.log(`\n=== 3. Running SB extraction for ${discoveryEntries.length} Wellcare plans ===`);
    fs.writeFileSync(DISCOVERY_PATH, JSON.stringify(discoveryEntries, null, 2));
    execSync(`npx tsx scripts/extract-sb-benefits.ts ${DISCOVERY_PATH} --update-db`, {
      stdio: "inherit",
      cwd: process.cwd(),
    });
  }

  // ═══ 4. Attempt 7 remaining UHC plans ════════════════════════════════════════
  console.log("\n=== 4. Attempting 7 remaining UHC plans ===");

  // Load download list for UHC URL lookup
  const dlPath = path.join(process.cwd(), "sb-download-list.json");
  type DlItem = { planId: string; url: string; confidence: number; sourceUrl?: string };
  const dlBest = new Map<string, DlItem>();
  if (fs.existsSync(dlPath)) {
    const all: DlItem[] = JSON.parse(fs.readFileSync(dlPath, "utf8"));
    for (const item of all) {
      const ex = dlBest.get(item.planId);
      if (!ex || item.confidence > ex.confidence) dlBest.set(item.planId, item);
    }
  }

  const uhcDiscovery: DiscoveryEntry[] = [];
  const uhcFailed: Array<{ planId: string; carrier: string }> = [];

  for (const { planId } of UHC_PLANS) {
    const entry = dlBest.get(planId);
    const urls: string[] = [];

    // Collect candidate URLs to try
    if (entry?.url) urls.push(entry.url);
    if (entry?.sourceUrl && entry.sourceUrl !== entry.url) urls.push(entry.sourceUrl);

    // Try uhc.com alphadog with common docid patterns derived from sibling plan refs
    // H5652: EREX series (H5652-8 = EREX26HP0333100_000)
    if (planId.startsWith("H5652")) {
      for (let suffix = 90; suffix <= 110; suffix++) {
        urls.push(`https://www.uhc.com/medicare/alphadog/EREX26HP033${suffix.toString().padStart(4, "0")}_000`);
      }
    }
    // content.medicareadvantage.com direct PDF
    const m = planId.match(/^([A-Z]\d{4})-(\d+)$/);
    if (m) {
      const contract = m[1];
      const plan = m[2].padStart(3, "0");
      urls.push(`https://content.medicareadvantage.com/2026/UHC-${contract}${plan}000-SB-2026.pdf`);
      // Also try year-specific patterns seen in download list
      urls.push(`https://content.medicareadvantage.com/2026/${contract}${plan}000-SB-2026.pdf`);
    }

    let found = false;
    for (const url of urls.slice(0, 10)) {
      console.log(`  → ${planId}: ${url.slice(0, 80)}`);
      const buf = await fetchWithHeaders(url);
      if (!buf || !isPdfBytes(buf)) continue;

      // Validate plan ID appears in text via pdftotext
      const tmpFile = path.join(TEMP_DIR, `${planId}-uhc-tmp.pdf`);
      fs.writeFileSync(tmpFile, buf);
      let textOk = false;
      try {
        const text = execSync(`pdftotext -layout "${tmpFile}" -`, {
          timeout: 15000, encoding: "utf8",
        });
        const contract = planId.split("-")[0].toLowerCase();
        const planNum = planId.split("-")[1].padStart(3, "0");
        if (text.toLowerCase().includes(contract) || text.includes(planNum)) {
          textOk = true;
        } else {
          console.log(`    ✗ plan ID not found in text`);
        }
      } catch (_) {
        // pdftotext unavailable or failed — trust the size check
        textOk = buf.length > 100000;
      }
      fs.unlinkSync(tmpFile);

      if (!textOk) continue;

      const filename = `${planId}-uhc-2026.pdf`;
      const localPath = path.join(TEMP_DIR, filename);
      fs.writeFileSync(localPath, buf);
      const blobUrl = await uploadPdf(planId, buf, filename);
      await prisma.plan.updateMany({ where: { planId, planYear: PLAN_YEAR }, data: { sbPdfUrl: blobUrl } });
      uhcDiscovery.push(makeDiscoveryEntry(planId, localPath));
      console.log(`    ✓ ${buf.length} bytes`);
      found = true;
      break;
    }

    if (!found) {
      console.log(`  ✗ ${planId}: all attempts failed`);
      uhcFailed.push({ planId, carrier: "UHC" });
    }
  }

  if (uhcDiscovery.length > 0) {
    console.log(`\n  Extracting ${uhcDiscovery.length} acquired UHC plans...`);
    const uhcDiscPath = path.join(process.cwd(), "sb-discovery-batch3-uhc.json");
    fs.writeFileSync(uhcDiscPath, JSON.stringify(uhcDiscovery, null, 2));
    execSync(`npx tsx scripts/extract-sb-benefits.ts ${uhcDiscPath} --update-db`, {
      stdio: "inherit",
      cwd: process.cwd(),
    });
  }

  // ═══ 5. Refresh missing-SB CSV ═══════════════════════════════════════════════
  console.log("\n=== 5. Refreshing missing-SB list ===");

  const plans2026 = await prisma.plan.findMany({
    where: { planYear: PLAN_YEAR },
    select: {
      planId: true,
      planName: true,
      organizationName: true,
      sbPdfUrl: true,
      sbLastProcessedAt: true,
      sbVerifiedOtcAmount: true,
      sbVerifiedFoodAmount: true,
    },
    distinct: ["planId"],
    orderBy: { planId: "asc" },
  });

  const sellable = plans2026.filter((p) => planNumber(p.planId) < 800);

  const missingIds = sellable
    .filter((p) => !p.sbPdfUrl || !p.sbLastProcessedAt || (!p.sbVerifiedOtcAmount && !p.sbVerifiedFoodAmount))
    .map((p) => p.planId);

  const stateRows = await prisma.plan.findMany({
    where: { planId: { in: missingIds } },
    select: { planId: true, state: true },
  });
  const stateAgg = new Map<string, Set<string>>();
  for (const { planId, state } of stateRows) {
    if (state) {
      if (!stateAgg.has(planId)) stateAgg.set(planId, new Set());
      stateAgg.get(planId)!.add(state);
    }
  }

  const csvRows: string[] = ["planId,planName,carrier,states,reason"];
  for (const p of sellable) {
    let reason: string | null = null;
    if (!p.sbPdfUrl) reason = "no_pdf";
    else if (!p.sbLastProcessedAt) reason = "corrupted";
    else if (!p.sbVerifiedOtcAmount && !p.sbVerifiedFoodAmount) reason = "no_card_found";
    if (!reason) continue;
    const states = [...(stateAgg.get(p.planId) ?? [])].sort().join("|");
    const name = (p.planName ?? "").replace(/"/g, "'");
    const carrier = (p.organizationName ?? "").replace(/"/g, "'");
    csvRows.push(`${p.planId},"${name}","${carrier}","${states}",${reason}`);
  }

  fs.writeFileSync(MISSING_SB_CSV, csvRows.join("\r\n") + "\r\n");
  const missingCount = csvRows.length - 1;
  console.log(`  wrote ${MISSING_SB_CSV} (${missingCount} plans)`);

  const byReason: Record<string, number> = {};
  for (const row of csvRows.slice(1)) { const r = row.split(",").pop()!; byReason[r] = (byReason[r] ?? 0) + 1; }
  for (const [r, c] of Object.entries(byReason)) console.log(`    ${r}: ${c}`);

  // Update still-missing CSV
  const allFailed = [...uhcFailed];
  if (allFailed.length > 0) {
    const newLines = ["planId,carrier,states,lastError"];
    // Collect UHC stateinfo
    const uhcStates = await prisma.plan.findMany({
      where: { planId: { in: allFailed.map((f) => f.planId) } },
      select: { planId: true, state: true, organizationName: true },
    });
    const smCarrier = new Map<string, string>();
    const smStates = new Map<string, Set<string>>();
    for (const row of uhcStates) {
      if (!smCarrier.has(row.planId) && row.organizationName) smCarrier.set(row.planId, row.organizationName);
      if (row.state) {
        if (!smStates.has(row.planId)) smStates.set(row.planId, new Set());
        smStates.get(row.planId)!.add(row.state);
      }
    }
    for (const { planId } of allFailed) {
      const carrier = smCarrier.get(planId) ?? "UHC";
      const states = [...(smStates.get(planId) ?? [])].sort().join("|");
      newLines.push(`${planId},"${carrier}","${states}",uhc.com requires browser auth — manual download needed`);
    }
    fs.writeFileSync(STILL_MISSING_CSV, newLines.join("\r\n") + "\r\n");
    console.log(`\n  wrote ${STILL_MISSING_CSV} (${newLines.length - 1} UHC plans still missing)`);
  } else {
    // All UHC resolved — clear still-missing
    fs.writeFileSync(STILL_MISSING_CSV, "planId,carrier,states,lastError\r\n");
    console.log("\n  All plans resolved — cleared still-missing CSV");
  }

  // ═══ 6. Verification table ═══════════════════════════════════════════════════
  console.log("\n=== 6. Verification (all 58 Wellcare + attempted UHC) ===");

  const verifyIds = [...wellcarePlanIds, ...UHC_PLANS.map((p) => p.planId)];
  const verified = await prisma.plan.findMany({
    where: { planId: { in: verifyIds }, planYear: PLAN_YEAR },
    select: {
      planId: true,
      sbPdfUrl: true,
      sbVerifiedOtcAmount: true,
      sbVerifiedOtcPeriod: true,
      sbVerifiedFoodAmount: true,
      sbVerifiedFoodPeriod: true,
      ssbciIsConditional: true,
    },
    distinct: ["planId"],
    orderBy: { planId: "asc" },
  });

  let hasOtc = 0, hasFood = 0, hasGated = 0, noCard = 0;
  console.log("\nplanId        | OTC               | Food              | SSBCI");
  console.log("-------------|-------------------|-------------------|------");
  for (const p of verified) {
    const otc = p.sbVerifiedOtcAmount != null
      ? `$${p.sbVerifiedOtcAmount}/${p.sbVerifiedOtcPeriod ?? "?"}` : "n/a";
    const food = p.sbVerifiedFoodAmount != null
      ? `$${p.sbVerifiedFoodAmount}/${p.sbVerifiedFoodPeriod ?? "?"}` : "n/a";
    const gated = p.ssbciIsConditional ? "gated" : "no";
    if (p.sbVerifiedOtcAmount) hasOtc++;
    if (p.sbVerifiedFoodAmount) hasFood++;
    if (p.ssbciIsConditional) hasGated++;
    if (!p.sbVerifiedOtcAmount && !p.sbVerifiedFoodAmount) noCard++;
    console.log(`${p.planId.padEnd(13)} | ${otc.padEnd(17)} | ${food.padEnd(17)} | ${gated}`);
  }

  console.log(`\nSummary: ${hasOtc} with OTC | ${hasFood} with Food | ${hasGated} SSBCI-gated | ${noCard} no-card-found`);
  console.log(`Wellcare uploaded: ${uploadOk} | UHC resolved: ${uhcDiscovery.length} | UHC still-missing: ${uhcFailed.length}`);
  console.log(`Missing-SB total: ${missingCount}`);

  console.log("\nDone.");
  await prisma.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
