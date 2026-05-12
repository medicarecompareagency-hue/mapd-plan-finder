import fs from "fs";
import path from "path";
import pdf from "pdf-parse";

interface MatchResult {
  file: string;
  planIds: string[];
  year: number | null;
  organization: string | null;
}

const ROOT = process.argv[2] || "./summary-of-benefits";

const PLAN_REGEX = /\b([A-Z]\d{4})[- ]?(\d{1,3})\b/g;
const YEAR_REGEX = /\b20(2[5-9]|3\d)\b/g;

async function extractText(filePath: string): Promise<string> {
  const data = await fs.promises.readFile(filePath);
  const parsed = await pdf(data);
  return parsed.text || "";
}

function normalizePlan(contract: string, plan: string): string {
  return `${contract}-${plan.padStart(3, "0")}`;
}

async function scanPdf(filePath: string): Promise<MatchResult | null> {
  try {
    const text = await extractText(filePath);

    const plans = new Set<string>();

    for (const match of text.matchAll(PLAN_REGEX)) {
      plans.add(normalizePlan(match[1], match[2]));
    }

    const years = [...text.matchAll(YEAR_REGEX)].map((m) => Number(m[0]));

    return {
      file: filePath,
      planIds: [...plans],
      year: years.length ? Math.max(...years) : null,
      organization: null,
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

  console.log(`Found ${pdfs.length} PDFs`);

  const results: MatchResult[] = [];

  for (const file of pdfs) {
    const res = await scanPdf(file);
    if (res && res.planIds.length) {
      results.push(res);
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
