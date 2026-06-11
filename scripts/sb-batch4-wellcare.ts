/**
 * SB batch 4: Wellcare Spendables extraction — vocab + column attribution fix, fleet re-run.
 *
 * Steps:
 *   1. Query all Wellcare planIds with SB PDFs from DB
 *   2. Download each blob URL to temp dir (skips cached)
 *   3. Build discovery JSON
 *   4. Dry-run extraction + validate ground-truth table (stop if >2 mismatches)
 *   5. Write to DB
 *   6. Refresh missing-SB and still-missing CSVs
 *   7. Print report
 */
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
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

const TEMP_DIR = path.join(process.cwd(), "summary-of-benefits-wellcare-batch4");
const DISCOVERY_PATH = path.join(process.cwd(), "sb-discovery-wellcare-batch4.json");
const PLAN_YEAR = 2026;
const MISSING_SB_CSV = "C:\\Users\\dbuir\\OneDrive\\Documents\\Claude\\Projects\\MAPD Plan Finder\\missing-sb-plans-2026-06-11.csv";
const STILL_MISSING_CSV = "C:\\Users\\dbuir\\OneDrive\\Documents\\Claude\\Projects\\MAPD Plan Finder\\sb-still-missing-2026-06-11.csv";

// Ground-truth amounts (monthly, $). null = "Not covered / no Spendables card".
// H1416-077 = Wellcare Simple = RIGHT column = $75/mo; H1416-079 = Wellcare Giveback = LEFT column = Not covered.
// H9730-9 omitted: its blob PDF is a standalone SB (says $164/quarter), not the 3-col SB used in staging.
const GROUND_TRUTH: Record<string, number | null> = {
  "H0074-4":   77,
  "H0111-1":   10,
  "H0111-7":   15,
  "H0174-9":   15,
  "H0174-26": 114,
  "H0270-1":   45,
  "H1032-237": 40,
  "H1112-34":  95,
  "H1112-47":  91,
  "H1416-35": 173,
  "H1416-60":  50,
  "H1416-71":  18,
  "H1416-72":  45,
  "H3975-1":   33,
  "H4537-1":   45,
  "H5779-7":   55,
  "H7518-1":   78,
  "H7518-3":  130,
  "H9730-11":  80,
  // Multi-plan column checks (corrected against actual PDF column layout)
  "H9730-7":   15,
  "H9730-10":  61,
  "H1416-77":  75,    // Wellcare Simple = RIGHT column = $75/mo
  "H1416-79":  null,  // Wellcare Giveback = LEFT column = Not covered
};

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

interface ExtractionResult {
  planIds: string[];
  otc: { amount: number | null; period: string | null; confidence: number; evidence: string | null };
  food: { amount: number | null; confidence: number };
  warnings: string[];
}

function planNum(planId: string): number {
  const m = planId.match(/-(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

function csvQuote(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

async function downloadBlob(url: string, destPath: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) { console.log(`    HTTP ${res.status} for ${url.slice(0, 80)}`); return false; }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 5000) { console.log(`    too small (${buf.length}B)`); return false; }
    fs.writeFileSync(destPath, buf);
    return true;
  } catch (err) {
    console.log(`    fetch error: ${(err as Error).message}`);
    return false;
  }
}

async function main() {
  const prisma = makePrisma();
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  // ═══ 1. Query all Wellcare plans with SB PDFs ═════════════════════════════════
  console.log("\n=== 1. Querying Wellcare plans with SB PDFs ===");

  const rawRows = await prisma.plan.findMany({
    where: {
      organizationName: { contains: "Wellcare", mode: "insensitive" },
      planYear: PLAN_YEAR,
      sbPdfUrl: { not: null },
    },
    select: { planId: true, sbPdfUrl: true, organizationName: true },
    distinct: ["planId"],
    orderBy: { planId: "asc" },
  });

  console.log(`  Found ${rawRows.length} distinct Wellcare planIds with SB PDFs`);

  // ═══ 2. Download PDFs ═════════════════════════════════════════════════════════
  console.log("\n=== 2. Downloading PDFs (skips already-cached) ===");

  const discoveryEntries: DiscoveryEntry[] = [];
  let dlOk = 0, dlSkip = 0, dlFail = 0;

  for (const row of rawRows) {
    const plan3 = row.planId.match(/-(\d+)$/)?.[1]?.padStart(3, "0") ?? "000";
    const contract = row.planId.replace(/-\d+$/, "");
    const filename = `${contract}-${plan3}.pdf`;
    const destPath = path.join(TEMP_DIR, filename);

    if (fs.existsSync(destPath)) {
      dlSkip++;
    } else {
      const ok = await downloadBlob(row.sbPdfUrl!, destPath);
      if (ok) { dlOk++; console.log(`  ✓ ${row.planId}`); }
      else { dlFail++; console.error(`  ✗ ${row.planId}: download failed`); continue; }
    }

    discoveryEntries.push({
      file: destPath,
      planIds: [row.planId],
      year: PLAN_YEAR,
      yearSource: "staged",
      yearConfidence: 0.98,
      filenameYear: null,
      downloadListYear: PLAN_YEAR,
      documentTitleYear: null,
      textFallbackYear: null,
      textYears: [PLAN_YEAR],
      organization: row.organizationName,
      warnings: [],
    });
  }

  console.log(`\n  Downloaded: ${dlOk}, Cached: ${dlSkip}, Failed: ${dlFail}`);

  if (discoveryEntries.length === 0) {
    console.error("No discovery entries — aborting.");
    await prisma.$disconnect();
    return;
  }

  // ═══ 3. Write discovery JSON ══════════════════════════════════════════════════
  fs.writeFileSync(DISCOVERY_PATH, JSON.stringify(discoveryEntries, null, 2));
  console.log(`\n=== 3. Wrote discovery JSON: ${discoveryEntries.length} entries ===`);

  // ═══ 4. Dry-run extraction + ground-truth validation ═════════════════════════
  console.log("\n=== 4. Running extraction (dry-run, no DB writes) ===");
  execSync(`npx tsx scripts/extract-sb-benefits.ts "${DISCOVERY_PATH}"`, {
    stdio: "inherit",
    cwd: process.cwd(),
  });

  const resultsPath = path.join(process.cwd(), "sb-benefit-extraction-results.json");
  const results: ExtractionResult[] = JSON.parse(fs.readFileSync(resultsPath, "utf8"));

  const byPlan = new Map<string, ExtractionResult>();
  for (const r of results) {
    for (const id of r.planIds) byPlan.set(id, r);
  }

  console.log("\n--- Ground-truth validation ---");
  let mismatches = 0;

  for (const [planId, expectedMonthly] of Object.entries(GROUND_TRUTH)) {
    const r = byPlan.get(planId);
    if (!r) {
      console.warn(`  MISSING from results: ${planId}`);
      mismatches++;
      continue;
    }
    const { amount, period } = r.otc;
    const actualMonthly = amount == null ? null
      : period === "month" ? amount
      : period === "quarter" ? +(amount / 3).toFixed(2)
      : amount;
    const match = actualMonthly === expectedMonthly;
    const line = `${planId.padEnd(12)} expected=${String(expectedMonthly ?? "null").padStart(5)}/mo  got=${String(actualMonthly ?? "null").padStart(5)}/mo  conf=${r.otc.confidence.toFixed(2)}`;
    if (!match) { console.error(`  ✗ MISMATCH  ${line}`); mismatches++; }
    else { console.log(`  ✓ OK        ${line}`); }
  }

  console.log(`\n  Validation: ${Object.keys(GROUND_TRUTH).length - mismatches}/${Object.keys(GROUND_TRUTH).length} match, ${mismatches} mismatch(es)`);

  if (mismatches > 2) {
    console.error(`\n  STOP: ${mismatches} mismatches > threshold of 2. NOT writing to DB.`);
    await prisma.$disconnect();
    process.exit(1);
  }

  // ═══ 5. Write to DB ═══════════════════════════════════════════════════════════
  console.log("\n=== 5. Writing extraction results to DB ===");
  execSync(`npx tsx scripts/extract-sb-benefits.ts "${DISCOVERY_PATH}" --update-db`, {
    stdio: "inherit",
    cwd: process.cwd(),
  });

  // ═══ 6. Refresh missing-SB CSVs ══════════════════════════════════════════════
  console.log("\n=== 6. Refreshing missing-SB CSVs ===");

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

  // Deduplicate by planId, aggregating states
  const planMap = new Map<string, { planName: string; carrier: string; states: Set<string>; sbPdfUrl: string | null; sbLastProcessedAt: Date | null; sbVerifiedOtcAmount: number | null; sbVerifiedFoodAmount: number | null }>();
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

  // Preserve still-missing (UHC plans; Wellcare gaps should now be resolved)
  const stillPlans = sellable.filter(([id, p]) => !p.sbPdfUrl && p.sbLastProcessedAt !== null);
  if (stillPlans.length > 0) {
    const stillLines = ["planId,carrier,states,lastError"];
    for (const [id, p] of stillPlans) {
      const states = [...p.states].sort().join("|");
      stillLines.push(`${id},${csvQuote(p.carrier)},${csvQuote(states)},attempted but unavailable`);
    }
    fs.writeFileSync(STILL_MISSING_CSV, stillLines.join("\r\n") + "\r\n");
    console.log(`  Wrote still-missing CSV: ${stillPlans.length} plans`);
  }

  // ═══ 7. Report ════════════════════════════════════════════════════════════════
  console.log("\n=== 7. Report ===");

  const wellcareAfter = await prisma.plan.findMany({
    where: {
      organizationName: { contains: "Wellcare", mode: "insensitive" },
      planYear: PLAN_YEAR,
      sbPdfUrl: { not: null },
    },
    select: {
      planId: true,
      sbVerifiedOtcAmount: true,
      sbVerifiedOtcPeriod: true,
      sbVerifiedFoodAmount: true,
      ssbciIsConditional: true,
    },
    distinct: ["planId"],
    orderBy: { planId: "asc" },
  });

  let withOtc = 0, withFood = 0, withGated = 0, noCard = 0;
  console.log("\nplanId        | OTC         | Food        | SSBCI");
  console.log("--------------|-------------|-------------|------");
  for (const p of wellcareAfter) {
    const a = p.sbVerifiedOtcAmount;
    const per = p.sbVerifiedOtcPeriod;
    const mo = a == null ? null : per === "month" ? a / 12 : per === "quarter" ? a / 4 : a;
    const otcStr = mo != null ? `$${mo}/mo` : "n/a";
    const foodStr = p.sbVerifiedFoodAmount != null ? `$${p.sbVerifiedFoodAmount}` : "n/a";
    const gated = p.ssbciIsConditional ? "gated" : "no";
    if (a != null) withOtc++;
    if (p.sbVerifiedFoodAmount != null) withFood++;
    if (p.ssbciIsConditional) withGated++;
    if (!a && !p.sbVerifiedFoodAmount) noCard++;
    console.log(`${p.planId.padEnd(14)} | ${otcStr.padEnd(11)} | ${foodStr.padEnd(11)} | ${gated}`);
  }

  console.log(`\nSummary: ${withOtc} with OTC | ${withFood} with Food | ${withGated} SSBCI-gated | ${noCard} no-card-found`);
  console.log(`Missing-SB total: ${missingCount}`);

  await prisma.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
