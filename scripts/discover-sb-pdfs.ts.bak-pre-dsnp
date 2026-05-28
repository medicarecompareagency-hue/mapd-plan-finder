import fs from "fs";
import path from "path";
import pdf from "pdf-parse";

type YearSource = "filename" | "download-list" | "document-title" | "text-fallback" | "unknown";

interface MatchResult {
  file: string;
  planIds: string[];
  year: number | null;
  yearSource: YearSource;
  yearConfidence: number;
  filenameYear: number | null;
  downloadListYear: number | null;
  documentTitleYear: number | null;
  textFallbackYear: number | null;
  textYears: number[];
  organization: string | null;
  warnings: string[];
}

interface DownloadListItem {
  filename?: string;
  url?: string;
  planId?: string;
  planYear?: number;
  organizationName?: string;
}

const ROOT = process.argv[2] || "./summary-of-benefits";

const PLAN_REGEX = /\b([A-Z]\d{4})[- ]?(\d{1,3})\b/g;
const YEAR_REGEX = /\b20(2[5-9]|3\d)\b/g;
const DOCUMENT_TITLE_YEAR_REGEX = /\b(20(?:2[5-9]|3\d))\s+(?:Medicare\s+)?Summary\s+of\s+Benefits\b|\bSummary\s+of\s+Benefits\s+(?:for\s+)?(20(?:2[5-9]|3\d))\b/gi;

async function extractText(filePath: string): Promise<string> {
  const data = await fs.promises.readFile(filePath);
  const parsed = await pdf(data);
  return parsed.text || "";
}

function normalizePlan(contract: string, plan: string): string {
  return `${contract}-${plan.padStart(3, "0")}`;
}

function normalizePlanId(value: string): string {
  const match = value.toUpperCase().match(/\b([A-Z]\d{4})[-_ ]?0*(\d{1,3})\b/);
  if (!match) return value.toUpperCase().trim();
  return `${match[1]}-${match[2].padStart(3, "0")}`;
}

function filenameYear(filePath: string): number | null {
  const filename = path.basename(filePath);
  const match = filename.match(/\bsb[-_ ](20(?:2[5-9]|3\d))\b/i)
    || filename.match(/\b(20(?:2[5-9]|3\d))[-_ ][A-Z]\d{4}[-_ ]?\d{1,3}\b/i);
  return match ? Number(match[1]) : null;
}

function documentTitleYear(text: string): number | null {
  const firstPages = text.slice(0, 6000);
  for (const match of firstPages.matchAll(DOCUMENT_TITLE_YEAR_REGEX)) {
    const year = Number(match[1] || match[2]);
    if (Number.isInteger(year)) return year;
  }
  return null;
}

function textFallbackYear(text: string): number | null {
  const years = [...text.matchAll(YEAR_REGEX)].map((match) => Number(match[0]));
  return years.length ? years[0] : null;
}

function uniqueYears(text: string): number[] {
  return [...new Set([...text.matchAll(YEAR_REGEX)].map((match) => Number(match[0])))]
    .sort((a, b) => a - b);
}

async function loadDownloadListMetadata(): Promise<Map<string, DownloadListItem>> {
  const file = path.join(process.cwd(), "sb-download-list.json");
  const byFilename = new Map<string, DownloadListItem>();
  if (!fs.existsSync(file)) return byFilename;

  const items = JSON.parse(await fs.promises.readFile(file, "utf8")) as DownloadListItem[];
  for (const item of items) {
    if (!item.filename) continue;
    byFilename.set(path.basename(item.filename).toLowerCase(), item);
  }
  return byFilename;
}

function downloadListYear(filePath: string, plans: Set<string>, metadata: Map<string, DownloadListItem>): number | null {
  const item = metadata.get(path.basename(filePath).toLowerCase());
  if (item?.planYear) return item.planYear;

  for (const candidate of metadata.values()) {
    if (candidate.planId && plans.has(normalizePlanId(candidate.planId)) && candidate.planYear) {
      return candidate.planYear;
    }
  }

  return null;
}

function chooseYear(parts: {
  filename: number | null;
  downloadList: number | null;
  documentTitle: number | null;
  textFallback: number | null;
}): { year: number | null; yearSource: YearSource; yearConfidence: number } {
  if (parts.filename) return { year: parts.filename, yearSource: "filename", yearConfidence: 0.99 };
  if (parts.downloadList) return { year: parts.downloadList, yearSource: "download-list", yearConfidence: 0.95 };
  if (parts.documentTitle) return { year: parts.documentTitle, yearSource: "document-title", yearConfidence: 0.88 };
  if (parts.textFallback) return { year: parts.textFallback, yearSource: "text-fallback", yearConfidence: 0.45 };
  return { year: null, yearSource: "unknown", yearConfidence: 0 };
}

async function scanPdf(filePath: string, metadata: Map<string, DownloadListItem>): Promise<MatchResult | null> {
  try {
    const text = await extractText(filePath);

    const plans = new Set<string>();

    for (const match of text.matchAll(PLAN_REGEX)) {
      plans.add(normalizePlan(match[1], match[2]));
    }

    const fileYear = filenameYear(filePath);
    const dlYear = downloadListYear(filePath, plans, metadata);
    const titleYear = documentTitleYear(text);
    const fallbackYear = textFallbackYear(text);
    const textYears = uniqueYears(text);
    const warnings: string[] = [];
    const yearChoice = chooseYear({
      filename: fileYear,
      downloadList: dlYear,
      documentTitle: titleYear,
      textFallback: fallbackYear,
    });

    if (fileYear && textYears.length && !textYears.includes(fileYear)) {
      warnings.push(`Filename year ${fileYear} does not appear in extracted PDF text years: ${textYears.join(", ")}.`);
    }

    if (fileYear && titleYear && fileYear !== titleYear) {
      warnings.push(`Filename year ${fileYear} conflicts with document title year ${titleYear}.`);
    }

    if (fileYear && dlYear && fileYear !== dlYear) {
      warnings.push(`Filename year ${fileYear} conflicts with sb-download-list planYear ${dlYear}.`);
    }

    const disagreeingTextYears = textYears.filter((year) => year !== fileYear && year !== titleYear && year !== dlYear);
    if (fileYear && disagreeingTextYears.length) {
      warnings.push(`PDF text also mentions other years (${disagreeingTextYears.join(", ")}); using filename year ${fileYear}.`);
    }

    if (yearChoice.yearSource === "text-fallback") {
      warnings.push(`Using weak text-fallback year ${yearChoice.year}; verify before DB updates.`);
    }

    return {
      file: filePath,
      planIds: [...plans],
      year: yearChoice.year,
      yearSource: yearChoice.yearSource,
      yearConfidence: yearChoice.yearConfidence,
      filenameYear: fileYear,
      downloadListYear: dlYear,
      documentTitleYear: titleYear,
      textFallbackYear: fallbackYear,
      textYears,
      organization: null,
      warnings,
    };
  } catch (err) {
    console.error(`Failed parsing ${filePath}`, err);
    return null;
  }
}

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });

  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) {
        return [full];
      }
      return [];
    }),
  );

  return files.flat();
}

async function main() {
  const pdfs = await walk(ROOT);
  const metadata = await loadDownloadListMetadata();

  console.log(`Found ${pdfs.length} PDFs`);
  if (metadata.size) console.log(`Loaded ${metadata.size} download-list metadata entries`);

  const results: MatchResult[] = [];

  for (const file of pdfs) {
    const res = await scanPdf(file, metadata);
    if (res && res.planIds.length) {
      results.push(res);
      for (const warning of res.warnings) {
        console.warn(`${path.basename(file)}: ${warning}`);
      }
    }
  }

  const output = path.join(process.cwd(), "sb-discovery-results.json");
  await fs.promises.writeFile(output, JSON.stringify(results, null, 2));

  console.log(`Matched ${results.length} PDFs`);
  console.log(`Results written to ${output}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
