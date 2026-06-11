/**
 * SB batch 2 repair — 2026-06-11
 *
 * A. Null H1036-214 food fields (same-wallet DB fix)
 * B. Upload 13 batch2 staged PDFs (3 HealthSpring + 10 Humana incl. 7 R-series), extract
 * C. Re-download ~73 remaining corrupted plans from their sb-download-list.json source URLs
 * D. Hunt 11 no_pdf plans (6 UHC + 5 Wellcare) from download list / guessable patterns
 * E. Refresh missing-SB CSV, print summary
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { put } from "@vercel/blob";
import { makePrisma } from "./prisma-client";

// ── env loading ────────────────────────────────────────────────────────────────
for (const envFile of [".env", ".env.local"]) {
  const p = path.join(__dirname, "..", envFile);
  try {
    const content = fs.readFileSync(p, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"]*)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch (_) { /* file absent */ }
}

// ── constants ──────────────────────────────────────────────────────────────────
const MISS_SB_DIR = "C:\\Users\\dbuir\\OneDrive\\Documents\\Claude\\Projects\\MAPD Plan Finder\\Miss SB";
const DOWNLOAD_LIST_PATH = path.join(process.cwd(), "sb-download-list.json");
const TEMP_DIR = path.join(process.cwd(), "summary-of-benefits");
const DISCOVERY_PATH = path.join(process.cwd(), "sb-discovery-batch2.json");
const STILL_MISSING_CSV = "C:\\Users\\dbuir\\OneDrive\\Documents\\Claude\\Projects\\MAPD Plan Finder\\sb-still-missing-2026-06-11.csv";
const MISSING_SB_CSV = "C:\\Users\\dbuir\\OneDrive\\Documents\\Claude\\Projects\\MAPD Plan Finder\\missing-sb-plans-2026-06-11.csv";
const PLAN_YEAR = 2026;

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

interface DownloadListEntry {
  planId: string;
  planYear: number;
  url: string;
  confidence: number;
  evidence?: string;
  sourceUrl?: string;
  states?: string[];
  organizationName?: string;
}

// B-section: 13 staged batch2 PDFs
const BATCH2_PLANS: Array<{ planId: string; file: string; corrupted: boolean }> = [
  // HealthSpring (H-series)
  { planId: "H0672-13",  file: path.join(MISS_SB_DIR, "HealthSpring", "H0672-013.pdf"), corrupted: false },
  { planId: "H5410-59",  file: path.join(MISS_SB_DIR, "HealthSpring", "H5410-059.pdf"), corrupted: true  },
  { planId: "H7849-144", file: path.join(MISS_SB_DIR, "HealthSpring", "H7849-144.pdf"), corrupted: false },
  // Humana (H-series, corrupted)
  { planId: "H5216-406", file: path.join(MISS_SB_DIR, "Humana", "H5216-406.pdf"), corrupted: true  },
  { planId: "H5216-452", file: path.join(MISS_SB_DIR, "Humana", "H5216-452.pdf"), corrupted: true  },
  { planId: "H5525-4",   file: path.join(MISS_SB_DIR, "Humana", "H5525-004.pdf"), corrupted: true  },
  // Humana R-series Regional PPOs (no_pdf)
  { planId: "R0110-3",   file: path.join(MISS_SB_DIR, "Humana", "R0110-003.pdf"), corrupted: false },
  { planId: "R1532-2",   file: path.join(MISS_SB_DIR, "Humana", "R1532-002.pdf"), corrupted: false },
  { planId: "R4182-3",   file: path.join(MISS_SB_DIR, "Humana", "R4182-003.pdf"), corrupted: false },
  { planId: "R4182-4",   file: path.join(MISS_SB_DIR, "Humana", "R4182-004.pdf"), corrupted: false },
  { planId: "R5361-2",   file: path.join(MISS_SB_DIR, "Humana", "R5361-002.pdf"), corrupted: false },
  { planId: "R5826-5",   file: path.join(MISS_SB_DIR, "Humana", "R5826-005.pdf"), corrupted: false },
  { planId: "R5826-74",  file: path.join(MISS_SB_DIR, "Humana", "R5826-074.pdf"), corrupted: false },
];

// D-section: last 11 no_pdf plans to hunt
const NO_PDF_PLANS = [
  // UHC
  "H0432-3", "H5652-1", "H5652-4", "R0759-1", "R3444-12", "R6801-12",
  // Wellcare
  "H0174-26", "H1032-240", "H1032-242", "H1112-49", "H2491-17",
];

// ── helpers ────────────────────────────────────────────────────────────────────

function isPdfBytes(buf: Buffer): boolean {
  return buf.length > 50000 && buf.slice(0, 5).toString("ascii") === "%PDF-";
}

async function fetchWithHeaders(url: string): Promise<Buffer | null> {
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/pdf,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Connection": "keep-alive",
  };
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
    if (!res.ok) {
      console.log(`    HTTP ${res.status} from ${url}`);
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.log(`    fetch error: ${(err as Error).message}`);
    return null;
  }
}

async function expandAndFetchPdf(url: string): Promise<{ buf: Buffer; url: string } | null> {
  // If the URL looks like a direct PDF, try it first
  if (/\.pdf(?:[?#]|$)/i.test(url)) {
    const buf = await fetchWithHeaders(url);
    if (buf && isPdfBytes(buf)) return { buf, url };
    if (buf) console.log(`    not a valid PDF (${buf.length} bytes, starts: ${buf.slice(0, 8).toString("ascii")})`);
    return null;
  }

  // Web page URL — fetch HTML, look for PDF links
  const pageBuf = await fetchWithHeaders(url);
  if (!pageBuf) return null;
  const html = pageBuf.toString("utf8");

  const hrefRe = /href=["']([^"']+\.pdf(?:\?[^"']*)?)["']/gi;
  const pdfLinks: string[] = [];
  for (const m of html.matchAll(hrefRe)) {
    try { pdfLinks.push(new URL(m[1], url).toString()); } catch (_) { /* bad URL */ }
  }

  for (const pdfUrl of pdfLinks.slice(0, 5)) {
    const buf = await fetchWithHeaders(pdfUrl);
    if (buf && isPdfBytes(buf)) return { buf, url: pdfUrl };
  }
  return null;
}

async function uploadPdf(
  planId: string,
  buf: Buffer,
  filename: string
): Promise<string> {
  const blobPath = `sb-pdfs/${planId}-${filename.replace(/\s/g, "_")}`;
  const blob = new Blob([buf], { type: "application/pdf" });
  const result = await put(blobPath, blob, { access: "public", addRandomSuffix: false });
  return result.url;
}

function makeDiscoveryEntry(planId: string, filePath: string): DiscoveryEntry {
  return {
    file: filePath,
    planIds: [planId],
    year: PLAN_YEAR,
    yearSource: "download-list",
    yearConfidence: 0.95,
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

// ── main ───────────────────────────────────────────────────────────────────────

async function main() {
  const prisma = makePrisma();
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  const discoveryEntries: DiscoveryEntry[] = [];
  const sectionBResults: Array<{ planId: string; status: "ok" | "error"; msg?: string }> = [];
  const sectionCResults: Array<{ planId: string; status: "ok" | "skip" | "error"; msg?: string }> = [];
  const sectionDResults: Array<{ planId: string; status: "ok" | "error"; msg?: string; carrier?: string; states?: string }> = [];

  // ═══ A. Fix H1036-214 same-wallet ═══════════════════════════════════════════
  console.log("\n=== A. Fix H1036-214 same-wallet violation ===");
  const aResult = await prisma.plan.updateMany({
    where: { planId: "H1036-214" },
    data: { sbVerifiedFoodAmount: null, sbVerifiedFoodPeriod: null },
  });
  console.log(`  nulled food on H1036-214: ${aResult.count} rows`);

  // ═══ B. Upload 13 batch2 staged PDFs ════════════════════════════════════════
  console.log("\n=== B. Upload 13 batch2 staged PDFs ===");

  // Clear SB fields for all 13 (corrupted ones need full clear; no_pdf ones only need url cleared)
  for (const { planId, corrupted } of BATCH2_PLANS) {
    const data: Record<string, unknown> = {
      sbPdfUrl: null,
      sbPdfChecksum: null,
      sbPdfSourceFilename: null,
    };
    if (corrupted) {
      Object.assign(data, {
        sbVerifiedOtcAmount: null,
        sbVerifiedFoodAmount: null,
        sbVerifiedOtcPeriod: null,
        sbVerifiedFoodPeriod: null,
        sbLastProcessedAt: null,
        sbDiscoveryConfidence: null,
        ssbciIsConditional: false,
        ssbciIsStandalone: false,
        ssbciConditionNote: null,
      });
    }
    const r = await prisma.plan.updateMany({ where: { planId }, data });
    console.log(`  cleared ${planId} (${corrupted ? "corrupted" : "no_pdf"}): ${r.count} rows`);
  }

  // Upload each PDF
  for (const { planId, file } of BATCH2_PLANS) {
    if (!fs.existsSync(file)) {
      console.error(`  ✗ ${planId}: staged file not found: ${file}`);
      sectionBResults.push({ planId, status: "error", msg: `file not found: ${file}` });
      continue;
    }
    try {
      const buf = fs.readFileSync(file);
      if (!isPdfBytes(buf)) {
        throw new Error(`not a valid PDF (${buf.length} bytes, starts: ${buf.slice(0, 8).toString("ascii")})`);
      }
      const filename = path.basename(file);
      const url = await uploadPdf(planId, buf, filename);
      const r = await prisma.plan.updateMany({ where: { planId }, data: { sbPdfUrl: url } });
      console.log(`  ✓ ${planId}: ...${url.slice(-40)} (${r.count} rows)`);
      // Save to temp dir for extraction (file already exists locally)
      discoveryEntries.push(makeDiscoveryEntry(planId, file));
      sectionBResults.push({ planId, status: "ok" });
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`  ✗ ${planId}: ${msg}`);
      sectionBResults.push({ planId, status: "error", msg });
    }
  }

  // ═══ C. Re-download corrupted plans ═════════════════════════════════════════
  console.log("\n=== C. Re-download corrupted plans ===");

  // Query corrupted = sbPdfUrl set but sbLastProcessedAt null
  const batch2Ids = new Set(BATCH2_PLANS.map((p) => p.planId));
  const corruptedRows = await prisma.plan.findMany({
    where: {
      planYear: PLAN_YEAR,
      sbPdfUrl: { not: null },
      sbLastProcessedAt: null,
    },
    select: { planId: true, organizationName: true, state: true },
    distinct: ["planId"],
    orderBy: { planId: "asc" },
  });

  const corruptedPlanIds = corruptedRows
    .map((r) => r.planId)
    .filter((id) => !batch2Ids.has(id) && planNumber(id) < 800);

  console.log(`  Found ${corruptedPlanIds.length} corrupted plans to re-download (excluded batch2 + EGWP)`);

  // Load download list
  let downloadList: DownloadListEntry[] = [];
  if (fs.existsSync(DOWNLOAD_LIST_PATH)) {
    downloadList = JSON.parse(fs.readFileSync(DOWNLOAD_LIST_PATH, "utf8")) as DownloadListEntry[];
    console.log(`  Loaded ${downloadList.length} entries from sb-download-list.json`);
  } else {
    console.warn(`  WARNING: sb-download-list.json not found — skipping C`);
  }

  // Build planId → best entry map from download list
  const dlByPlanId = new Map<string, DownloadListEntry>();
  for (const entry of downloadList) {
    const key = entry.planId;
    const existing = dlByPlanId.get(key);
    if (!existing || entry.confidence > existing.confidence) {
      dlByPlanId.set(key, entry);
    }
  }

  for (const planId of corruptedPlanIds) {
    const entry = dlByPlanId.get(planId);
    if (!entry) {
      console.log(`  - ${planId}: no URL in download list — skipping`);
      sectionCResults.push({ planId, status: "skip", msg: "no URL in download list" });
      continue;
    }

    console.log(`  → ${planId}: trying ${entry.url.slice(0, 80)}`);
    const result = await expandAndFetchPdf(entry.url);

    if (!result) {
      // Try sourceUrl if different
      if (entry.sourceUrl && entry.sourceUrl !== entry.url) {
        console.log(`    trying sourceUrl: ${entry.sourceUrl.slice(0, 80)}`);
        const r2 = await expandAndFetchPdf(entry.sourceUrl);
        if (r2) {
          const filename = `${planId}-redownload.pdf`;
          const localPath = path.join(TEMP_DIR, filename);
          fs.writeFileSync(localPath, r2.buf);
          const url = await uploadPdf(planId, r2.buf, filename);
          await prisma.plan.updateMany({ where: { planId }, data: { sbPdfUrl: url } });
          discoveryEntries.push(makeDiscoveryEntry(planId, localPath));
          console.log(`    ✓ from sourceUrl`);
          sectionCResults.push({ planId, status: "ok" });
          continue;
        }
      }
      console.log(`    ✗ failed`);
      sectionCResults.push({ planId, status: "error", msg: "download failed" });
      continue;
    }

    const filename = `${planId}-redownload.pdf`;
    const localPath = path.join(TEMP_DIR, filename);
    fs.writeFileSync(localPath, result.buf);
    const url = await uploadPdf(planId, result.buf, filename);
    await prisma.plan.updateMany({ where: { planId }, data: { sbPdfUrl: url } });
    discoveryEntries.push(makeDiscoveryEntry(planId, localPath));
    console.log(`    ✓ ${result.buf.length} bytes`);
    sectionCResults.push({ planId, status: "ok" });
  }

  // ═══ D. Hunt 11 no_pdf plans ════════════════════════════════════════════════
  console.log("\n=== D. Hunt 11 no_pdf plans ===");

  // Check each planId against download list and guessable patterns
  const GUESSABLE_PATTERNS: Array<(planId: string) => string[]> = [
    // Humana: content.medicareadvantage.com
    (id) => {
      const m = id.match(/^([A-Z]\d{4})-(\d+)$/);
      if (!m) return [];
      const contract = m[1];
      const plan = m[2].padStart(3, "0");
      return [`https://content.medicareadvantage.com/2026/Humana-${contract}${plan}000SB26pdf-2026-SF20251001.pdf`];
    },
    // HealthSpring/Cigna
    (id) => {
      const m = id.match(/^H(\d{4})-(\d+)$/);
      if (!m) return [];
      const plan = m[2].padStart(3, "0");
      return [`https://www.healthspring.com/static/docs/medicare/plans/2026/sb-h${m[1]}-${plan}-000.pdf`];
    },
    // UHC: content.medicareadvantage.com pattern
    (id) => {
      const m = id.match(/^([A-Z]\d{4})-(\d+)$/);
      if (!m) return [];
      const contract = m[1];
      const plan = m[2].padStart(3, "0");
      return [
        `https://content.medicareadvantage.com/2026/UHC-${contract}${plan}000-SB-2026.pdf`,
      ];
    },
    // Wellcare
    (id) => {
      const m = id.match(/^H(\d{4})-(\d+)$/);
      if (!m) return [];
      const plan = m[2].padStart(3, "0");
      return [
        `https://www.wellcare.com/~/media/documents/2026/sb/h${m[1]}_${plan}_000_sb.pdf`,
      ];
    },
  ];

  // Build states lookup
  const noPdfDbRows = await prisma.plan.findMany({
    where: { planId: { in: NO_PDF_PLANS } },
    select: { planId: true, organizationName: true, state: true },
  });
  const carrierByPlanId = new Map<string, string>();
  const statesByPlanId = new Map<string, Set<string>>();
  for (const row of noPdfDbRows) {
    if (!carrierByPlanId.has(row.planId) && row.organizationName) {
      carrierByPlanId.set(row.planId, row.organizationName);
    }
    if (row.state) {
      if (!statesByPlanId.has(row.planId)) statesByPlanId.set(row.planId, new Set());
      statesByPlanId.get(row.planId)!.add(row.state);
    }
  }

  for (const planId of NO_PDF_PLANS) {
    const carrier = carrierByPlanId.get(planId) ?? "unknown";
    const states = [...(statesByPlanId.get(planId) ?? [])].sort().join("|");

    // Check download list first
    const dlEntry = dlByPlanId.get(planId);
    if (dlEntry) {
      console.log(`  → ${planId}: trying download list URL`);
      const result = await expandAndFetchPdf(dlEntry.url);
      if (result) {
        const filename = `${planId}-acquired.pdf`;
        const localPath = path.join(TEMP_DIR, filename);
        fs.writeFileSync(localPath, result.buf);
        const url = await uploadPdf(planId, result.buf, filename);
        await prisma.plan.updateMany({ where: { planId }, data: { sbPdfUrl: url } });
        discoveryEntries.push(makeDiscoveryEntry(planId, localPath));
        console.log(`    ✓ from download list`);
        sectionDResults.push({ planId, status: "ok", carrier, states });
        continue;
      }
    }

    // Try guessable patterns
    let found = false;
    for (const pattern of GUESSABLE_PATTERNS) {
      const urls = pattern(planId);
      for (const tryUrl of urls) {
        console.log(`  → ${planId}: trying ${tryUrl.slice(0, 80)}`);
        const result = await expandAndFetchPdf(tryUrl);
        if (result) {
          const filename = `${planId}-acquired.pdf`;
          const localPath = path.join(TEMP_DIR, filename);
          fs.writeFileSync(localPath, result.buf);
          const url = await uploadPdf(planId, result.buf, filename);
          await prisma.plan.updateMany({ where: { planId }, data: { sbPdfUrl: url } });
          discoveryEntries.push(makeDiscoveryEntry(planId, localPath));
          console.log(`    ✓ from guessable pattern`);
          sectionDResults.push({ planId, status: "ok", carrier, states });
          found = true;
          break;
        }
      }
      if (found) break;
    }

    if (!found) {
      console.log(`  ✗ ${planId}: all attempts failed`);
      sectionDResults.push({ planId, status: "error", carrier, states });
    }
  }

  // Write still-missing CSV for D failures
  const dFailed = sectionDResults.filter((r) => r.status === "error");
  if (dFailed.length > 0) {
    const csvRows = ["planId,carrier,states,lastError"];
    for (const r of dFailed) {
      csvRows.push(`${r.planId},"${r.carrier ?? ""}","${r.states ?? ""}",all download attempts failed`);
    }
    fs.writeFileSync(STILL_MISSING_CSV, csvRows.join("\r\n") + "\r\n");
    console.log(`\n  Wrote ${dFailed.length} still-missing plans to ${STILL_MISSING_CSV}`);
  } else {
    console.log(`\n  All 11 no_pdf plans resolved!`);
  }

  // ═══ Run extraction for all acquired plans ═══════════════════════════════════
  if (discoveryEntries.length > 0) {
    console.log(`\n=== Running SB extraction for ${discoveryEntries.length} acquired plans ===`);
    fs.writeFileSync(DISCOVERY_PATH, JSON.stringify(discoveryEntries, null, 2));
    console.log(`  wrote ${DISCOVERY_PATH}`);
    execSync(`npx tsx scripts/extract-sb-benefits.ts ${DISCOVERY_PATH} --update-db`, {
      stdio: "inherit",
      cwd: process.cwd(),
    });
  } else {
    console.log("\n=== No new PDFs acquired — skipping extraction ===");
  }

  // ═══ E. Refresh missing-SB CSV ═══════════════════════════════════════════════
  console.log("\n=== E. Refreshing missing-SB list ===");

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
    if (!p.sbPdfUrl) {
      reason = "no_pdf";
    } else if (!p.sbLastProcessedAt) {
      reason = "corrupted";
    } else if (!p.sbVerifiedOtcAmount && !p.sbVerifiedFoodAmount) {
      reason = "no_card_found";  // relabeled from extract_failed
    }
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
  for (const row of csvRows.slice(1)) {
    const reason = row.split(",").pop()!;
    byReason[reason] = (byReason[reason] ?? 0) + 1;
  }
  for (const [reason, count] of Object.entries(byReason)) {
    console.log(`    ${reason}: ${count}`);
  }

  // ═══ Summary table ════════════════════════════════════════════════════════════
  console.log("\n=== Summary ===");
  console.log(`\nSection B (13 staged): ${sectionBResults.filter((r) => r.status === "ok").length} ok, ${sectionBResults.filter((r) => r.status === "error").length} errors`);
  console.log(`Section C (corrupted re-downloads): ${sectionCResults.filter((r) => r.status === "ok").length} ok, ${sectionCResults.filter((r) => r.status === "skip").length} skipped, ${sectionCResults.filter((r) => r.status === "error").length} failed`);
  console.log(`Section D (11 no_pdf hunts): ${sectionDResults.filter((r) => r.status === "ok").length} ok, ${sectionDResults.filter((r) => r.status === "error").length} failed`);
  console.log(`\nMissing-SB total: ${missingCount}`);

  // Verification: query batch2 planIds
  console.log("\n=== Verification (batch2 + H1036-214) ===");
  const batch2Verify = await prisma.plan.findMany({
    where: { planId: { in: ["H1036-214", ...BATCH2_PLANS.map((p) => p.planId)] } },
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

  console.log("\nplanId        | blob URL (last 30)             | OTC               | Food              | SSBCI");
  console.log("-------------|--------------------------------|-------------------|-------------------|------");
  for (const p of batch2Verify) {
    const url = p.sbPdfUrl ? `...${p.sbPdfUrl.slice(-30)}` : "MISSING";
    const otc = p.sbVerifiedOtcAmount != null
      ? `$${p.sbVerifiedOtcAmount}/${p.sbVerifiedOtcPeriod ?? "?"}`
      : "n/a";
    const food = p.sbVerifiedFoodAmount != null
      ? `$${p.sbVerifiedFoodAmount}/${p.sbVerifiedFoodPeriod ?? "?"}`
      : "n/a";
    const gated = p.ssbciIsConditional ? "gated" : "no";
    console.log(
      `${p.planId.padEnd(13)} | ${url.padEnd(32)} | ${otc.padEnd(17)} | ${food.padEnd(17)} | ${gated}`
    );
  }

  console.log("\nDone.");
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
