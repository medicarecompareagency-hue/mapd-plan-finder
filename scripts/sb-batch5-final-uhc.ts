/**
 * SB batch 5 (final): 5 remaining UHC SBs — closes the missing-SB backlog.
 *
 * Source URLs (from manifest.csv, for reference only — no sbSourceUrl DB column):
 *   H0432-3  → https://content.medicareadvantage.com/2026/UHC_AAAL26HP0332370_2026_SB_SF20260204.pdf
 *   H2406-67 → https://content.medicareadvantage.com/2026/UHC_AAIN26LP0332742_2026_SB_SF20260204.pdf
 *   R0759-1  → https://content.medicareadvantage.com/2026/UHC_AAFL26RP0333156_2026_SB_SF20260204.pdf
 *   R3444-12 → https://content.medicareadvantage.com/2026/UHC_UHEX26RP0333163_2026_SB_SF20260204.pdf
 *   R6801-12 → https://content.medicareadvantage.com/2026/UHC_UHTX26RP0333167_2026_SB_SF20260204.pdf
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

const STAGING_DIR = "C:\\Users\\dbuir\\OneDrive\\Documents\\Claude\\Projects\\MAPD Plan Finder\\Miss SB\\UnitedHealthcare";
const TEMP_DIR = path.join(process.cwd(), "summary-of-benefits-uhc-batch5");
const DISCOVERY_PATH = path.join(process.cwd(), "sb-discovery-uhc-batch5.json");
const MISSING_SB_CSV = "C:\\Users\\dbuir\\OneDrive\\Documents\\Claude\\Projects\\MAPD Plan Finder\\missing-sb-plans-2026-06-11.csv";
const PLAN_YEAR = 2026;

const PLANS: Array<{ planId: string; file: string }> = [
  { planId: "H0432-3",  file: "H0432-003.pdf" },
  { planId: "H2406-67", file: "H2406-067.pdf" },
  { planId: "R0759-1",  file: "R0759-001.pdf" },
  { planId: "R3444-12", file: "R3444-012.pdf" },
  { planId: "R6801-12", file: "R6801-012.pdf" },
];

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
  organization: string;
  warnings: string[];
}

function planNum(planId: string): number {
  const m = planId.match(/-(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

function csvQuote(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

async function main() {
  const prisma = makePrisma();
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  // ═══ 1. Upload PDFs + update sbPdfUrl ════════════════════════════════════════
  console.log("\n=== 1. Uploading PDFs to Vercel Blob ===");

  const discoveryEntries: DiscoveryEntry[] = [];

  for (const { planId, file } of PLANS) {
    const srcPath = path.join(STAGING_DIR, file);
    const destPath = path.join(TEMP_DIR, file);

    if (!fs.existsSync(srcPath)) {
      console.error(`  ✗ ${planId}: missing staged file ${srcPath}`);
      continue;
    }

    // Check if already uploaded
    const existing = await prisma.plan.findFirst({
      where: { planId, planYear: PLAN_YEAR, sbPdfUrl: { not: null } },
      select: { sbPdfUrl: true },
    });

    let blobUrl: string;

    if (existing?.sbPdfUrl) {
      console.log(`  ↩ ${planId}: already uploaded → ${existing.sbPdfUrl.slice(0, 70)}`);
      blobUrl = existing.sbPdfUrl;
    } else {
      const buf = fs.readFileSync(srcPath);
      if (buf.length < 5000 || buf.slice(0, 4).toString("ascii") !== "%PDF") {
        console.error(`  ✗ ${planId}: not a valid PDF (${buf.length}B)`);
        continue;
      }
      const blobPath = `sb-pdfs/${planId}-${file}`;
      const blob = new Blob([new Uint8Array(buf)], { type: "application/pdf" });
      const result = await put(blobPath, blob, {
        access: "public",
        addRandomSuffix: false,
        contentType: "application/pdf",
      });
      blobUrl = result.url;

      const updated = await prisma.plan.updateMany({
        where: { planId, planYear: PLAN_YEAR },
        data: { sbPdfUrl: blobUrl },
      });
      console.log(`  ✓ ${planId}: uploaded → ${blobUrl.slice(0, 70)} (${updated.count} rows)`);
    }

    // Copy to temp dir for extraction
    fs.copyFileSync(srcPath, destPath);

    discoveryEntries.push({
      file: destPath,
      planIds: [planId],
      year: PLAN_YEAR,
      yearSource: "staged",
      yearConfidence: 0.98,
      filenameYear: null,
      downloadListYear: PLAN_YEAR,
      documentTitleYear: null,
      textFallbackYear: null,
      textYears: [PLAN_YEAR],
      organization: "UnitedHealthcare",
      warnings: [],
    });
  }

  if (discoveryEntries.length === 0) {
    console.error("No plans to extract — aborting.");
    await prisma.$disconnect();
    return;
  }

  // ═══ 2. Write discovery JSON ══════════════════════════════════════════════════
  fs.writeFileSync(DISCOVERY_PATH, JSON.stringify(discoveryEntries, null, 2));
  console.log(`\n=== 2. Wrote discovery JSON: ${discoveryEntries.length} entries ===`);

  // ═══ 3. Extract + write to DB ═════════════════════════════════════════════════
  console.log("\n=== 3. Running extraction (dry-run) ===");
  execSync(`npx tsx scripts/extract-sb-benefits.ts "${DISCOVERY_PATH}"`, {
    stdio: "inherit",
    cwd: process.cwd(),
  });

  console.log("\n=== 4. Writing extraction results to DB ===");
  execSync(`npx tsx scripts/extract-sb-benefits.ts "${DISCOVERY_PATH}" --update-db`, {
    stdio: "inherit",
    cwd: process.cwd(),
  });

  // ═══ 5. Refresh missing-SB CSV ═══════════════════════════════════════════════
  console.log("\n=== 5. Refreshing missing-SB CSV ===");

  const allPlans = await prisma.plan.findMany({
    where: { planYear: PLAN_YEAR },
    select: {
      planId: true,
      planName: true,
      organizationName: true,
      state: true,
      sbPdfUrl: true,
      sbLastProcessedAt: true,
      sbVerifiedOtcAmount: true,
      sbVerifiedFoodAmount: true,
    },
  });

  const planMap = new Map<string, {
    planName: string; carrier: string; states: Set<string>;
    sbPdfUrl: string | null; sbLastProcessedAt: Date | null;
    sbVerifiedOtcAmount: number | null; sbVerifiedFoodAmount: number | null;
  }>();
  for (const p of allPlans) {
    if (!planMap.has(p.planId)) {
      planMap.set(p.planId, {
        planName: p.planName ?? "",
        carrier: p.organizationName ?? "",
        states: new Set(),
        sbPdfUrl: p.sbPdfUrl,
        sbLastProcessedAt: p.sbLastProcessedAt,
        sbVerifiedOtcAmount: p.sbVerifiedOtcAmount,
        sbVerifiedFoodAmount: p.sbVerifiedFoodAmount,
      });
    }
    if (p.state) planMap.get(p.planId)!.states.add(p.state);
  }

  const sellable = [...planMap.entries()].filter(([id]) => planNum(id) < 800);

  const csvRows = ["planId,planName,carrier,states,reason"];
  for (const [id, p] of sellable) {
    let reason: string | null = null;
    if (!p.sbPdfUrl) reason = "no_pdf";
    else if (!p.sbLastProcessedAt) reason = "corrupted";
    else if (!p.sbVerifiedOtcAmount && !p.sbVerifiedFoodAmount) reason = "no_card_found";
    if (!reason) continue;
    const states = [...p.states].sort().join("|");
    csvRows.push(`${id},${csvQuote(p.planName)},${csvQuote(p.carrier)},${csvQuote(states)},${reason}`);
  }

  fs.writeFileSync(MISSING_SB_CSV, csvRows.join("\r\n") + "\r\n");
  const missingCount = csvRows.length - 1;
  console.log(`  Wrote missing-sb CSV: ${missingCount} plans`);
  const byReason: Record<string, number> = {};
  for (const row of csvRows.slice(1)) { const r = row.split(",").pop()!; byReason[r] = (byReason[r] ?? 0) + 1; }
  for (const [r, c] of Object.entries(byReason)) console.log(`    ${r}: ${c}`);

  // ═══ 6. Report ════════════════════════════════════════════════════════════════
  console.log("\n=== 6. Per-plan results ===");

  const batchPlans = await prisma.plan.findMany({
    where: {
      planId: { in: PLANS.map(p => p.planId) },
      planYear: PLAN_YEAR,
    },
    select: {
      planId: true,
      planName: true,
      sbVerifiedOtcAmount: true,
      sbVerifiedOtcPeriod: true,
      sbVerifiedFoodAmount: true,
      sbVerifiedFoodPeriod: true,
      ssbciIsConditional: true,
      sbLastProcessedAt: true,
    },
    distinct: ["planId"],
    orderBy: { planId: "asc" },
  });

  console.log("\nplanId        | OTC           | Food          | SSBCI-gated | Processed");
  console.log("--------------|---------------|---------------|-------------|----------");
  for (const p of batchPlans) {
    const otcAmt = p.sbVerifiedOtcAmount;
    const otcPer = p.sbVerifiedOtcPeriod;
    const foodAmt = p.sbVerifiedFoodAmount;
    const foodPer = p.sbVerifiedFoodPeriod;
    const otcMo = otcAmt == null ? null : otcPer === "month" ? otcAmt / 12 : otcPer === "quarter" ? otcAmt / 4 : otcAmt;
    const foodMo = foodAmt == null ? null : foodPer === "month" ? foodAmt / 12 : foodPer === "quarter" ? foodAmt / 4 : foodAmt;
    const otcStr = otcMo != null ? `$${otcMo}/mo` : "n/a";
    const foodStr = foodMo != null ? `$${foodMo}/mo` : "n/a";
    const gated = p.ssbciIsConditional ? "yes" : "no";
    const processed = p.sbLastProcessedAt ? "✓" : "✗";
    console.log(`${p.planId.padEnd(14)} | ${otcStr.padEnd(13)} | ${foodStr.padEnd(13)} | ${gated.padEnd(11)} | ${processed}`);
  }

  console.log(`\nMissing-SB total after batch 5: ${missingCount}`);
  if (missingCount === 0) console.log("  ✓ Missing-SB backlog CLOSED — all sellable plans have SB PDFs extracted.");

  await prisma.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
