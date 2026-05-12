import fs from "fs";
import path from "path";
import crypto from "crypto";
import pdf from "pdf-parse";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DIRECT_URL || process.env.DATABASE_URL },
  },
});

interface DiscoveryResult {
  file: string;
  planIds: string[];
  year: number | null;
}

interface ExtractedBenefit {
  amount: number | null;
  period: string | null;
  page: number | null;
  confidence: number;
  evidence: string | null;
}

interface ExtractionResult {
  file: string;
  checksum: string;
  planIds: string[];
  year: number | null;
  otc: ExtractedBenefit;
  food: ExtractedBenefit;
  dental: ExtractedBenefit;
  vision: ExtractedBenefit;
  hearing: ExtractedBenefit;
  transportation: ExtractedBenefit;
  warnings: string[];
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function moneyToNumber(raw: string): number | null {
  const cleaned = raw.replace(/[$,]/g, "").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function detectPeriod(text: string): string | null {
  const s = text.toLowerCase();
  if (/per\s+month|monthly|\/\s*mo\b|each\s+month/.test(s)) return "month";
  if (/per\s+quarter|quarterly|every\s+3\s+months|\/\s*qtr/.test(s)) return "quarter";
  if (/per\s+year|annually|annual|yearly|calendar\s+year|\/\s*yr/.test(s)) return "year";
  if (/per\s+benefit\s+period|benefit\s+period/.test(s)) return "benefit period";
  return null;
}

function pageNumberForIndex(text: string, index: number): number | null {
  const prior = text.slice(0, index);
  const pageBreaks = prior.match(/\f/g);
  return pageBreaks ? pageBreaks.length + 1 : null;
}

function findBenefit(text: string, keywords: RegExp[], exclusions: RegExp[] = []): ExtractedBenefit {
  const windows: Array<{ snippet: string; index: number; score: number }> = [];

  for (const keyword of keywords) {
    keyword.lastIndex = 0;
    for (const match of text.matchAll(keyword)) {
      const idx = match.index ?? 0;
      const start = Math.max(0, idx - 350);
      const end = Math.min(text.length, idx + 650);
      const snippet = cleanText(text.slice(start, end));
      if (exclusions.some((r) => r.test(snippet))) continue;
      const amountHits = snippet.match(/\$\s?[\d,]+(?:\.\d{2})?/g) || [];
      const score = amountHits.length ? 0.74 : 0.45;
      windows.push({ snippet, index: idx, score });
    }
  }

  if (!windows.length) {
    return { amount: null, period: null, page: null, confidence: 0, evidence: null };
  }

  windows.sort((a, b) => b.score - a.score);
  const best = windows[0];
  const moneyMatches = best.snippet.match(/\$\s?[\d,]+(?:\.\d{2})?/g) || [];

  let amount: number | null = null;
  if (moneyMatches.length) {
    const nums = moneyMatches.map(moneyToNumber).filter((n): n is number => n != null);
    amount = nums.length ? Math.max(...nums) : null;
  }

  let confidence = best.score;
  if (amount != null) confidence += 0.15;
  if (detectPeriod(best.snippet)) confidence += 0.08;
  confidence = Math.min(confidence, 0.97);

  return {
    amount,
    period: detectPeriod(best.snippet),
    page: pageNumberForIndex(text, best.index),
    confidence,
    evidence: best.snippet.slice(0, 500),
  };
}

async function extractPdf(file: string, planIds: string[], year: number | null): Promise<ExtractionResult> {
  const buffer = await fs.promises.readFile(file);
  const checksum = crypto.createHash("sha256").update(buffer).digest("hex");
  const parsed = await pdf(buffer);
  const text = parsed.text || "";
  const warnings: string[] = [];

  if (text.trim().length < 500) {
    warnings.push("PDF text extraction returned very little text; OCR may be needed.");
  }

  const otc = findBenefit(text, [
    /over-the-counter/gi,
    /\bOTC\b/g,
    /health\s+and\s+wellness\s+allowance/gi,
    /healthy\s+benefits/gi,
    /spendables/gi,
  ]);

  const food = findBenefit(text, [
    /food\s+(card|allowance|benefit)/gi,
    /grocery\s+(card|allowance|benefit)/gi,
    /healthy\s+food/gi,
    /healthy\s+options/gi,
    /utilities/gi,
    /flex\s+card/gi,
  ]);

  const dental = findBenefit(text, [
    /dental\s+(services|benefits|allowance|maximum)/gi,
    /comprehensive\s+dental/gi,
    /preventive\s+dental/gi,
  ]);

  const vision = findBenefit(text, [
    /vision\s+(services|benefits|allowance|maximum)/gi,
    /eyewear/gi,
    /routine\s+eye/gi,
  ]);

  const hearing = findBenefit(text, [
    /hearing\s+(services|benefits|aid|aids|allowance|maximum)/gi,
    /hearing\s+aid/gi,
  ]);

  const transportation = findBenefit(text, [
    /transportation/gi,
    /one-way\s+trips/gi,
    /routine\s+transportation/gi,
  ]);

  return { file, checksum, planIds, year, otc, food, dental, vision, hearing, transportation, warnings };
}

function annualize(amount: number | null, period: string | null): number | null {
  if (amount == null) return null;
  if (period === "month") return amount * 12;
  if (period === "quarter") return amount * 4;
  return amount;
}

async function updatePlans(result: ExtractionResult, dryRun: boolean) {
  for (const planId of result.planIds) {
    const data: Record<string, unknown> = {
      sbPdfChecksum: result.checksum,
      sbPdfSourceFilename: path.basename(result.file),
      sbLastProcessedAt: new Date(),
      sbDiscoveryConfidence: Math.max(result.otc.confidence, result.food.confidence, result.dental.confidence),
      sbOtcPage: result.otc.page,
      sbFoodCardPage: result.food.page,
      sbDentalPage: result.dental.page,
      sbVisionPage: result.vision.page,
      sbHearingPage: result.hearing.page,
      sbTransportationPage: result.transportation.page,
      sbVerifiedOtcAmount: annualize(result.otc.amount, result.otc.period),
      sbVerifiedFoodAmount: annualize(result.food.amount, result.food.period),
    };

    Object.keys(data).forEach((k) => data[k] === undefined && delete data[k]);

    console.log(`${dryRun ? "Would update" : "Updating"} ${planId}`, data);

    if (!dryRun) {
      await prisma.plan.updateMany({
        where: {
          planId: planId.replace(/-(\d{3})$/, (_, p) => `-${Number(p)}`),
          ...(result.year ? { planYear: result.year } : {}),
        },
        data,
      });
    }
  }
}

async function main() {
  const discoveryPath = process.argv[2] || "./sb-discovery-results.json";
  const dryRun = process.argv.includes("--dry-run");
  const updateDb = process.argv.includes("--update-db");

  const discovery: DiscoveryResult[] = JSON.parse(await fs.promises.readFile(discoveryPath, "utf8"));
  const results: ExtractionResult[] = [];

  for (const item of discovery) {
    const result = await extractPdf(item.file, item.planIds, item.year);
    results.push(result);
    if (updateDb) await updatePlans(result, dryRun);
  }

  const out = path.join(process.cwd(), "sb-benefit-extraction-results.json");
  await fs.promises.writeFile(out, JSON.stringify(results, null, 2));
  console.log(`Wrote ${out}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
