import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";

const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DIRECT_URL || process.env.DATABASE_URL },
  },
});

const TARGET_CARRIERS = [
  "HealthSpring",
  "UnitedHealthcare",
  "UHC",
  "Devoted Health",
  "Aetna Medicare",
  "Humana",
];

const DEFAULT_YEAR = 2026;
const DEFAULT_MIN_CONFIDENCE = 0.78;

interface PlanRow {
  planId: string;
  planYear: number;
  organizationName: string;
  planName: string;
  state: string;
  county: string;
}

interface PlanTarget extends PlanRow {
  states: string[];
  counties: string[];
  queries: string[];
}

interface SearchCandidate {
  url: string;
  title?: string;
  snippet?: string;
  sourceUrl?: string;
  query?: string;
  planId?: string;
  planYear?: number;
  organizationName?: string;
  planName?: string;
}

interface DownloadListItem {
  planId: string;
  planYear: number;
  organizationName: string;
  planName: string;
  state: string;
  county: string;
  url: string;
  confidence: number;
  evidence: string;
  sourceUrl?: string;
  states?: string[];
  counties?: string[];
}

interface UnresolvedPlan {
  planId: string;
  planYear: number;
  organizationName: string;
  planName: string;
  state: string;
  county: string;
  states: string[];
  counties: string[];
  queries: string[];
  bestCandidate?: {
    url: string;
    confidence: number;
    evidence: string;
    sourceUrl?: string;
  };
  reason: string;
}

interface Args {
  year: number;
  inputFiles: string[];
  output: string;
  unresolved: string;
  minConfidence: number;
  limit?: number;
  maxQueriesPerPlan: number;
  maxResultsPerQuery: number;
  skipWebSearch: boolean;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const getValue = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };

  const inputFiles = args
    .flatMap((arg, index) => {
      if (arg === "--input" && args[index + 1]) return [args[index + 1]];
      if (arg.startsWith("--input=")) return [arg.slice("--input=".length)];
      return [];
    })
    .filter(Boolean);

  return {
    year: Number(getValue("--year") || DEFAULT_YEAR),
    inputFiles,
    output: getValue("--output") || "./sb-download-list.json",
    unresolved: getValue("--unresolved") || "./sb-unresolved-plans.json",
    minConfidence: Number(getValue("--min-confidence") || DEFAULT_MIN_CONFIDENCE),
    limit: getValue("--limit") ? Number(getValue("--limit")) : undefined,
    maxQueriesPerPlan: Number(getValue("--max-queries-per-plan") || 4),
    maxResultsPerQuery: Number(getValue("--max-results-per-query") || 5),
    skipWebSearch: args.includes("--no-web-search"),
  };
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizePlanId(value: string): string {
  const match = value.toUpperCase().match(/\b([A-Z]\d{4})[- ]?0*(\d{1,3})\b/);
  if (!match) return value.toUpperCase().trim();
  return `${match[1]}-${Number(match[2])}`;
}

function paddedPlanId(value: string): string {
  const match = normalizePlanId(value).match(/\b([A-Z]\d{4})-(\d{1,3})\b/);
  if (!match) return value.toUpperCase().trim();
  return `${match[1]}-${match[2].padStart(3, "0")}`;
}

function slugPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 90);
}

function carrierAliases(organizationName: string): string[] {
  const org = organizationName.toLowerCase();
  if (org.includes("united") || org === "uhc") {
    return ["UnitedHealthcare", "UHC", "AARP Medicare"];
  }
  if (org.includes("aetna")) return ["Aetna Medicare", "Aetna"];
  if (org.includes("devoted")) return ["Devoted Health", "Devoted"];
  if (org.includes("humana")) return ["Humana"];
  if (org.includes("healthspring") || org.includes("cigna")) {
    return ["HealthSpring", "Cigna Healthcare", "Cigna-HealthSpring"];
  }
  return [organizationName];
}

function isTargetCarrier(plan: PlanRow): boolean {
  const haystack = `${plan.organizationName} ${plan.planName}`.toLowerCase();
  return TARGET_CARRIERS.some((carrier) => haystack.includes(carrier.toLowerCase()));
}

function buildQueries(plan: PlanRow): string[] {
  const planId = normalizePlanId(plan.planId);
  const padded = paddedPlanId(plan.planId);
  const aliases = carrierAliases(plan.organizationName);
  const baseName = plan.planName.replace(/\([^)]*\)/g, "").trim();
  const queries = new Set<string>();

  for (const carrier of aliases) {
    queries.add(`"${planId}" "${plan.planYear}" "Summary of Benefits" PDF`);
    queries.add(`"${padded}" "${plan.planYear}" "Summary of Benefits" PDF`);
    queries.add(`"${carrier}" "${baseName}" "${plan.planYear}" "Summary of Benefits" PDF`);
    queries.add(`"${carrier}" "${planId}" Medicare "Summary of Benefits"`);
    queries.add(`site:${carrierDomainHint(carrier)} "${planId}" "${plan.planYear}" PDF`);
  }

  return [...queries].filter((query) => !query.includes("site: "));
}

function carrierDomainHint(carrier: string): string {
  const normalized = carrier.toLowerCase();
  if (normalized.includes("united") || normalized === "uhc" || normalized.includes("aarp")) {
    return "uhc.com";
  }
  if (normalized.includes("aetna")) return "aetna.com";
  if (normalized.includes("devoted")) return "devoted.com";
  if (normalized.includes("humana")) return "humana.com";
  if (normalized.includes("healthspring") || normalized.includes("cigna")) return "cigna.com";
  return "";
}

function targetKey(plan: PlanRow): string {
  return [
    normalizePlanId(plan.planId),
    plan.planYear,
    plan.organizationName.toLowerCase().replace(/\s+/g, " "),
  ].join("|");
}

async function loadPlans(year: number, limit?: number): Promise<PlanTarget[]> {
  const rows = await prisma.plan.findMany({
    where: { planYear: year, planCategory: "DSNP", drugTier1Copay: null },
    select: {
      planId: true,
      planYear: true,
      organizationName: true,
      planName: true,
      state: true,
      county: true,
    },
    orderBy: [{ organizationName: "asc" }, { planId: "asc" }, { state: "asc" }, { county: "asc" }],
  });

  const grouped = new Map<string, PlanRow[]>();
  for (const row of rows.filter(isTargetCarrier)) {
    const key = targetKey(row);
    grouped.set(key, [...(grouped.get(key) || []), row]);
  }

  const targets = [...grouped.values()].map((group) => {
    const sorted = [...group].sort((a, b) =>
      `${a.state}|${a.county}`.localeCompare(`${b.state}|${b.county}`),
    );
    const first = sorted[0];
    return {
      ...first,
      planId: normalizePlanId(first.planId),
      states: [...new Set(sorted.map((row) => row.state))],
      counties: [...new Set(sorted.map((row) => `${row.state}:${row.county}`))],
      queries: buildQueries(first),
    };
  });

  return typeof limit === "number" ? targets.slice(0, limit) : targets;
}

function extractCandidatesFromUnknown(value: unknown): SearchCandidate[] {
  if (!value) return [];
  if (typeof value === "string") return [{ url: value }];
  if (Array.isArray(value)) return value.flatMap(extractCandidatesFromUnknown);
  if (typeof value !== "object") return [];

  const record = value as Record<string, unknown>;
  const nested = ["results", "items", "organic_results", "candidates"]
    .flatMap((key) => extractCandidatesFromUnknown(record[key]));

  const rawUrl = record.url || record.link || record.href || record.pdfUrl;
  const direct = typeof rawUrl === "string"
    ? [{
        url: rawUrl,
        title: stringValue(record.title || record.name),
        snippet: stringValue(record.snippet || record.description || record.evidence),
        sourceUrl: stringValue(record.sourceUrl || record.source || record.pageUrl),
        query: stringValue(record.query),
        planId: stringValue(record.planId),
        planYear: numberValue(record.planYear),
        organizationName: stringValue(record.organizationName),
        planName: stringValue(record.planName),
      }]
    : [];

  return [...direct, ...nested];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

async function loadManualCandidates(inputFiles: string[]): Promise<SearchCandidate[]> {
  const candidates = new Map<string, SearchCandidate>();
  const defaults = ["./sb-search-results.json", "./sb-manual-sb-urls.json"];
  const files = [...inputFiles, ...defaults];

  for (const file of files) {
    const fullPath = path.resolve(file);
    if (!fs.existsSync(fullPath)) continue;
    const parsed = JSON.parse(await fs.promises.readFile(fullPath, "utf8"));
    for (const candidate of extractCandidatesFromUnknown(parsed)) {
      if (!candidate.url) continue;
      candidates.set(candidate.url, candidate);
    }
  }

  return [...candidates.values()];
}

async function searchBing(query: string, count: number): Promise<SearchCandidate[]> {
  const key = process.env.BING_SEARCH_API_KEY || process.env.AZURE_BING_SEARCH_API_KEY;
  if (!key) return [];

  const endpoint = process.env.BING_SEARCH_ENDPOINT || "https://api.bing.microsoft.com/v7.0/search";
  const url = new URL(endpoint);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));
  url.searchParams.set("responseFilter", "Webpages");

  const res = await fetch(url, { headers: { "Ocp-Apim-Subscription-Key": key } });
  if (!res.ok) throw new Error(`Bing search failed: ${res.status} ${res.statusText}`);
  const data = await res.json() as { webPages?: { value?: Array<Record<string, unknown>> } };

  return (data.webPages?.value || []).flatMap((item) =>
    extractCandidatesFromUnknown({
      url: item.url,
      title: item.name,
      snippet: item.snippet,
      sourceUrl: item.url,
      query,
    }),
  );
}

async function searchSerpApi(query: string, count: number): Promise<SearchCandidate[]> {
  const key = process.env.SERPAPI_API_KEY;
  if (!key) return [];

  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google");
  url.searchParams.set("q", query);
  url.searchParams.set("num", String(count));
  url.searchParams.set("api_key", key);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`SerpApi search failed: ${res.status} ${res.statusText}`);
  return extractCandidatesFromUnknown(await res.json());
}

async function runSearch(query: string, count: number, skipWebSearch: boolean): Promise<SearchCandidate[]> {
  if (skipWebSearch) return [];

  const results = [
    ...(await searchBing(query, count)),
    ...(await searchSerpApi(query, count)),
  ];

  return results.map((result) => ({ ...result, query }));
}

async function expandPdfLinks(candidate: SearchCandidate): Promise<SearchCandidate[]> {
  if (/\.pdf(?:[?#].*)?$/i.test(candidate.url)) return [candidate];

  try {
    const res = await fetch(candidate.url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [candidate];

    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("pdf")) return [candidate];
    if (!contentType.includes("html") && !contentType.includes("text")) return [candidate];

    const html = await res.text();
    const links = new Set<string>();
    const hrefRegex = /href=["']([^"']+\.pdf(?:\?[^"']*)?)["']/gi;

    for (const match of html.matchAll(hrefRegex)) {
      try {
        links.add(new URL(match[1], candidate.url).toString());
      } catch {
        continue;
      }
    }

    return [
      candidate,
      ...[...links].slice(0, 10).map((url) => ({
        ...candidate,
        url,
        sourceUrl: candidate.url,
        snippet: candidate.snippet || `PDF link discovered from ${candidate.url}`,
      })),
    ];
  } catch {
    return [candidate];
  }
}

function candidateAppliesToPlan(candidate: SearchCandidate, plan: PlanTarget): boolean {
  if (candidate.planYear && candidate.planYear !== plan.planYear) return false;
  if (candidate.planId && normalizePlanId(candidate.planId) !== normalizePlanId(plan.planId)) return false;
  if (candidate.organizationName) {
    const org = candidate.organizationName.toLowerCase();
    if (!carrierAliases(plan.organizationName).some((alias) => org.includes(alias.toLowerCase()))) {
      return false;
    }
  }
  return true;
}

function planNameTokenScore(planName: string, text: string): number {
  const tokens = planName
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 && !["medicare", "advantage", "plan"].includes(token));

  if (!tokens.length) return 0;
  const hits = tokens.filter((token) => text.includes(token)).length;
  return Math.min(0.22, (hits / tokens.length) * 0.22);
}

function scoreCandidate(plan: PlanTarget, candidate: SearchCandidate): {
  confidence: number;
  evidence: string;
} {
  const url = candidate.url;
  const text = normalizeWhitespace(
    `${url} ${candidate.title || ""} ${candidate.snippet || ""}`.toLowerCase(),
  );
  const planId = normalizePlanId(plan.planId).toLowerCase();
  const padded = paddedPlanId(plan.planId).toLowerCase();
  const aliases = carrierAliases(plan.organizationName).map((alias) => alias.toLowerCase());
  const directPdf = /\.pdf(?:[?#].*)?$/i.test(url) || text.includes(".pdf");
  let score = 0;
  const reasons: string[] = [];

  if (directPdf) {
    score += 0.2;
    reasons.push("direct PDF URL");
  }
  if (text.includes(planId) || text.includes(padded)) {
    score += 0.45;
    reasons.push("matched plan ID");
  }
  if (text.includes(String(plan.planYear))) {
    score += 0.12;
    reasons.push("matched plan year");
  }
  if (/summary of benefits|summary-of-benefits|\bsob\b/.test(text)) {
    score += 0.14;
    reasons.push("matched Summary of Benefits language");
  }
  if (aliases.some((alias) => text.includes(alias))) {
    score += 0.12;
    reasons.push("matched carrier name");
  }

  const nameScore = planNameTokenScore(plan.planName, text);
  if (nameScore > 0) {
    score += nameScore;
    reasons.push("matched plan name tokens");
  }

  if (plan.states.some((state) => text.includes(state.toLowerCase()))) score += 0.03;
  if (/medicare|mapd|hmo|ppo|dsnp|d-snp/.test(text)) score += 0.04;

  if (!directPdf) {
    score -= 0.08;
    reasons.push("not a direct PDF URL");
  }

  const carrierDomain = aliases.some((alias) => {
    const hint = carrierDomainHint(alias);
    return hint && text.includes(hint);
  });
  if (carrierDomain) score += 0.03;

  const confidence = Math.max(0, Math.min(0.98, Number(score.toFixed(2))));
  const source = candidate.sourceUrl || candidate.url;
  const evidence = reasons.length
    ? `${reasons.join("; ")}. Source: ${source}`
    : `Weak textual match. Source: ${source}`;

  return { confidence, evidence };
}

function buildFilename(item: DownloadListItem): string {
  return [
    "sb",
    item.planYear,
    normalizePlanId(item.planId).replace("-", "_"),
    slugPart(item.organizationName),
    slugPart(item.state),
    slugPart(item.county),
  ].filter(Boolean).join("-") + ".pdf";
}

async function main() {
  const args = parseArgs();
  const manualCandidates = await loadManualCandidates(args.inputFiles);
  const plans = await loadPlans(args.year, args.limit);
  const downloads: Array<DownloadListItem & { filename: string }> = [];
  const unresolved: UnresolvedPlan[] = [];

  // Resume support: reload prior partial results so a crash mid-run does not
  // lose work or repeat SerpAPI calls. Output files are flushed periodically.
  function loadPrior<T>(file: string): T[] {
    try { return JSON.parse(fs.readFileSync(path.resolve(file), "utf8")) as T[]; }
    catch { return []; }
  }
  for (const d of loadPrior<DownloadListItem & { filename: string }>(args.output)) downloads.push(d);
  for (const u of loadPrior<UnresolvedPlan>(args.unresolved)) unresolved.push(u);
  const processedIds = new Set<string>([
    ...downloads.map((d) => d.planId),
    ...unresolved.map((u) => u.planId),
  ]);
  const pending = plans.filter((p) => !processedIds.has(p.planId));

  let flushing = false;
  async function flush(): Promise<void> {
    if (flushing) return;
    flushing = true;
    try {
      await fs.promises.writeFile(path.resolve(args.output), JSON.stringify(downloads, null, 2));
      await fs.promises.writeFile(path.resolve(args.unresolved), JSON.stringify(unresolved, null, 2));
    } finally { flushing = false; }
  }

  console.log(`Found ${plans.length} unique ${args.year} target carrier plans; ${processedIds.size} already done, ${pending.length} pending.`);
  if (manualCandidates.length) {
    console.log(`Loaded ${manualCandidates.length} manual/search-result candidate URLs.`);
  }
  if (!process.env.BING_SEARCH_API_KEY && !process.env.AZURE_BING_SEARCH_API_KEY && !process.env.SERPAPI_API_KEY) {
    console.log("No web search API key found; using manual candidates only.");
  }

  async function processPlan(plan: (typeof plans)[number]): Promise<void> {
    const candidateMap = new Map<string, SearchCandidate>();

    for (const candidate of manualCandidates.filter((item) => candidateAppliesToPlan(item, plan))) {
      candidateMap.set(candidate.url, candidate);
    }

    for (const query of plan.queries.slice(0, args.maxQueriesPerPlan)) {
      try {
        for (const candidate of await runSearch(query, args.maxResultsPerQuery, args.skipWebSearch)) {
          candidateMap.set(candidate.url, candidate);
        }
      } catch (err) {
        console.warn(`Search failed for ${plan.planId}:`, err);
      }
    }

    await Promise.all(
      [...candidateMap.values()].map(async (candidate) => {
        for (const expanded of await expandPdfLinks(candidate)) {
          candidateMap.set(expanded.url, expanded);
        }
      }),
    );

    const ranked = [...candidateMap.values()]
      .map((candidate) => ({
        candidate,
        ...scoreCandidate(plan, candidate),
      }))
      .sort((a, b) => b.confidence - a.confidence);

    const best = ranked[0];
    if (best && best.confidence >= args.minConfidence) {
      const item: DownloadListItem = {
        planId: plan.planId,
        planYear: plan.planYear,
        organizationName: plan.organizationName,
        planName: plan.planName,
        state: plan.state,
        county: plan.county,
        url: best.candidate.url,
        confidence: best.confidence,
        evidence: best.evidence,
        sourceUrl: best.candidate.sourceUrl,
        states: plan.states,
        counties: plan.counties,
      };
      downloads.push({ ...item, filename: buildFilename(item) });
    } else {
      unresolved.push({
        planId: plan.planId,
        planYear: plan.planYear,
        organizationName: plan.organizationName,
        planName: plan.planName,
        state: plan.state,
        county: plan.county,
        states: plan.states,
        counties: plan.counties,
        queries: plan.queries,
        bestCandidate: best
          ? {
              url: best.candidate.url,
              confidence: best.confidence,
              evidence: best.evidence,
              sourceUrl: best.candidate.sourceUrl,
            }
          : undefined,
        reason: best
          ? `Best candidate confidence ${best.confidence} is below ${args.minConfidence}.`
          : "No candidate URLs found. Paste search results into sb-search-results.json or configure a search API key.",
      });
    }
  }

  // Parallelized plan processing: a fixed pool of workers pulls from a shared
  // cursor. Cuts wall-clock time ~Nx vs the original sequential loop, which
  // was dominated by per-candidate page fetches (10s timeouts each).
  const CONCURRENCY = Number(process.env.ACQUIRE_CONCURRENCY || 8);
  let cursor = 0;
  let completed = 0;
  async function worker(): Promise<void> {
    while (cursor < pending.length) {
      const idx = cursor;
      cursor += 1;
      await processPlan(pending[idx]);
      completed += 1;
      if (completed % 5 === 0) await flush();
      if (completed % 20 === 0 || completed === pending.length) {
        console.log(`Processed ${completed}/${pending.length} pending (resolved ${downloads.length}, unresolved ${unresolved.length})`);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, pending.length) }, () => worker()),
  );

  await flush();

  console.log(`Wrote ${downloads.length} download items to ${path.resolve(args.output)}`);
  console.log(`Wrote ${unresolved.length} unresolved plans to ${path.resolve(args.unresolved)}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
