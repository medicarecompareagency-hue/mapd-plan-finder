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

type YearSource = "filename" | "download-list" | "document-title" | "text-fallback" | "unknown";

interface DiscoveryResult {
  file: string;
  planIds: string[];
  year: number | null;
  yearSource?: YearSource;
  yearConfidence?: number;
  filenameYear?: number | null;
  downloadListYear?: number | null;
  documentTitleYear?: number | null;
  textFallbackYear?: number | null;
  textYears?: number[];
  organization?: string | null;
  warnings?: string[];
}

interface ExtractedBenefit {
  amount: number | null;
  period: string | null;
  page: number | null;
  confidence: number;
  evidence: string | null;
  debug?: string[];
}

interface ExtractionResult {
  file: string;
  checksum: string;
  planIds: string[];
  year: number | null;
  yearSource: YearSource;
  yearConfidence: number;
  filenameYear: number | null;
  downloadListYear: number | null;
  documentTitleYear: number | null;
  textFallbackYear: number | null;
  textYears: number[];
  otc: ExtractedBenefit;
  food: ExtractedBenefit;
  dental: ExtractedBenefit;
  vision: ExtractedBenefit;
  hearing: ExtractedBenefit;
  transportation: ExtractedBenefit;
  ssbci: SsbciAnalysis;
  warnings: string[];
}

interface SsbciAnalysis {
  // SSBCI = Special Supplemental Benefits for the Chronically Ill. These are
  // condition-gated: a member only gets the dollars if they have a qualifying
  // chronic condition (and sometimes a designated provider). The CMS PBP fields
  // (ssbciFoodAllowance, etc.) do NOT capture that gating, so the tool was
  // rendering them as if every member gets the money. This analyzer reads the
  // SB PDF prose to flag the gating so the UI can stop misleading members.
  isConditional: boolean;   // true => benefit requires a qualifying chronic condition
  expandsBase: boolean;     // gated categories ride the existing OTC/spending card; no new $
  isStandalone: boolean;    // gated benefit has its own separate dollar card
  conditionNote: string | null; // plain-English snippet of the eligibility language
  evidencePage: number | null;
}

type BenefitKind = "otc" | "food" | "dental" | "vision" | "hearing" | "transportation";

interface PlanContext {
  organizationName: string | null;
  planName: string | null;
}

interface BenefitConfig {
  kind: BenefitKind;
  keywords: RegExp[];
  strongLabels: RegExp[];
  exclusions: RegExp[];
}

interface CandidateAmount {
  amount: number;
  period: string | null;
  confidence: number;
  page: number | null;
  evidence: string;
  debug: string[];
}

const DEBUG = process.argv.includes("--debug") || process.env.DEBUG_SB_EXTRACTION === "1";
const MIN_UPDATE_CONFIDENCE = 0.85;
// Food amounts use a slightly lower threshold — the scoring model penalizes
// food candidates near OTC keywords (to prevent cross-contamination), which
// legitimately lowers confidence even when the SB text is unambiguous (e.g.
// Devoted "$296 per month toward eligible food"). 0.80 is safe here.
const MIN_FOOD_CONFIDENCE = 0.80;
const MIN_YEAR_UPDATE_CONFIDENCE = 0.8;

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
  if (/per\s+month|each\s+month|every\s+month|monthly|month(?:ly)?\s+(?:allowance|credit|amount|benefit)|\/\s*mo\b|\bmo\./.test(s)) return "month";
  if (/per\s+quarter|each\s+quarter|every\s+quarter|quarterly|every\s+3\s+months|3-month|three-month|\/\s*qtr|\bqtr\b|reload(?:ed|s)?\s+(?:each\s+)?quarter/.test(s)) return "quarter";
  if (/per\s+year|each\s+year|annually|annual|yearly|calendar\s+year|plan\s+year|every\s+year|\/\s*yr\b|\byr\./.test(s)) return "year";
  if (/per\s+benefit\s+period|each\s+benefit\s+period|benefit\s+period/.test(s)) return "benefit period";
  return null;
}

function periodScore(period: string | null): number {
  if (period === "month") return 0.16;
  if (period === "quarter") return 0.14;
  if (period === "benefit period") return 0.04;
  if (period === "year") return -0.14;
  return -0.08;
}

function pageNumberForIndex(text: string, index: number): number | null {
  const prior = text.slice(0, index);
  const pageBreaks = prior.match(/\f/g);
  if (pageBreaks) return pageBreaks.length + 1;

  const nearby = text.slice(Math.max(0, index - 1400), Math.min(text.length, index + 600));
  const markers = [
    ...nearby.matchAll(/\b(\d{1,3})\s*20(2[5-9]|3\d)\s+Summary\s+of\s+Benefits/gi),
    ...nearby.matchAll(/Summary\s+of\s+Benefits\s+for\s+[A-Z]\d{4}[- ]?\d{1,3}\s+(\d{1,3})\b/gi),
  ];

  if (!markers.length) return null;

  const pages = markers
    .map((match) => Number(match[1]))
    .filter((page) => Number.isInteger(page) && page > 0 && page < 300);

  return pages.length ? pages[pages.length - 1] : null;
}

function filenameYear(filePath: string): number | null {
  const filename = path.basename(filePath);
  const match = filename.match(/\bsb[-_ ](20(?:2[5-9]|3\d))\b/i)
    || filename.match(/\b(20(?:2[5-9]|3\d))[-_ ][A-Z]\d{4}[-_ ]?\d{1,3}\b/i);
  return match ? Number(match[1]) : null;
}

function getCarrier(text: string, context?: PlanContext): "aetna" | "uhc" | "devoted" | "cigna" | "humana" | "wellcare" | "unknown" {
  const haystack = `${context?.organizationName || ""} ${context?.planName || ""} ${text.slice(0, 3000)}`.toLowerCase();
  if (/aetna|cvs health/.test(haystack)) return "aetna";
  if (/unitedhealthcare|\buhc\b|aarp medicare/.test(haystack)) return "uhc";
  if (/devoted/.test(haystack)) return "devoted";
  if (/healthspring|cigna/.test(haystack)) return "cigna";
  if (/humana/.test(haystack)) return "humana";
  if (/wellcare/.test(haystack)) return "wellcare";
  return "unknown";
}

function carrierStrongLabels(carrier: ReturnType<typeof getCarrier>, kind: BenefitKind): RegExp[] {
  // Carrier names for OTC/food cards change frequently; these labels anchor the
  // dollar value to the product vocabulary instead of generic marketing totals.
  const commonOtc = [/over-the-counter/gi, /\bOTC\b/g, /otc\s+(allowance|credit|benefit|items|card)/gi, /wellcare\s+spendables/gi, /\bspendables\b/gi, /preloaded\s+on\s+your/gi];
  const commonFood = [/food\s+(card|allowance|benefit|credit)/gi, /grocery\s+(card|allowance|benefit|credit)/gi, /healthy\s+(food|foods)/gi];

  const labels: Record<string, { otc: RegExp[]; food: RegExp[] }> = {
    aetna: {
      otc: [...commonOtc, /otc\s+health\s+solutions/gi, /extra\s+benefits\s+card/gi, /resources\s+for\s+living/gi],
      food: [...commonFood, /extra\s+benefits\s+card/gi, /healthy\s+foods?\s+card/gi, /healthy\s+foods?\s+benefit/gi],
    },
    uhc: {
      otc: [...commonOtc, /\bUCard\b/g, /healthy\s+benefits\s+plus/gi, /otc\s+credit/gi],
      food: [...commonFood, /\bUCard\b/g, /healthy\s+benefits\s+plus/gi, /food[,/\s]+otc\s+and\s+utility/gi],
    },
    devoted: {
      otc: [...commonOtc, /devoted\s+dollars/gi, /flex\s+card/gi, /healthy\s+benefits/gi],
      // "Food & Home Card" uses "&" in Devoted PDFs, not "and"
      food: [...commonFood, /food\s+(?:and|&)\s+home\s+card/gi, /devoted\s+dollars/gi, /healthy\s+foods?\s+card/gi],
    },
    cigna: {
      otc: [...commonOtc, /cigna\s+healthy\s+today/gi, /healthy\s+today\s+card/gi, /otc\s+mail\s+order/gi],
      food: [...commonFood, /cigna\s+healthy\s+today/gi, /healthy\s+today\s+card/gi, /healthy\s+options/gi],
    },
    humana: {
      // Humana's combined OTC+food card is "Humana Healthy Options Allowance™"
      otc: [...commonOtc, /healthy\s+options\s+allowance/gi, /humana\s+healthy\s+options/gi],
      food: [...commonFood, /healthy\s+options\s+allowance/gi, /humana\s+healthy\s+options/gi, /healthy\s+options/gi],
    },
    wellcare: { otc: commonOtc, food: commonFood },
    unknown: { otc: commonOtc, food: commonFood },
  };

  if (kind === "otc" || kind === "food") return labels[carrier][kind];
  return [];
}

function benefitConfig(kind: BenefitKind, carrier: ReturnType<typeof getCarrier>): BenefitConfig {
  const commonExclusions = [
    /dental\s+(annual\s+)?(maximum|max|allowance)/gi,
    /vision\s+(annual\s+)?(maximum|max|allowance)/gi,
    /hearing\s+(annual\s+)?(maximum|max|allowance)/gi,
    /maximum\s+out-of-pocket|out-of-pocket\s+maximum/gi,
    /monthly\s+premium/gi,
  ];

  const configs: Record<BenefitKind, BenefitConfig> = {
    otc: {
      kind,
      keywords: carrierStrongLabels(carrier, "otc"),
      strongLabels: carrierStrongLabels(carrier, "otc"),
      exclusions: [
        ...commonExclusions,
        /food\s+(card|allowance|benefit)|grocery|utilities|utility/gi,
      ],
    },
    food: {
      kind,
      keywords: [
        ...carrierStrongLabels(carrier, "food"),
        /healthy\s+options/gi,
        /utilit(?:y|ies)/gi,
        /flex\s+card/gi,
      ],
      strongLabels: carrierStrongLabels(carrier, "food"),
      exclusions: [
        ...commonExclusions,
        /meal(?:s)?\s+after\s+(?:an\s+)?inpatient\s+stay/gi,
        /home-delivered\s+meals/gi,
      ],
    },
    dental: {
      kind,
      keywords: [/dental\s+(services|benefits|allowance|maximum)/gi, /comprehensive\s+dental/gi, /preventive\s+dental/gi],
      strongLabels: [/dental/gi],
      exclusions: [],
    },
    vision: {
      kind,
      keywords: [/vision\s+(services|benefits|allowance|maximum)/gi, /eyewear/gi, /routine\s+eye/gi],
      strongLabels: [/vision|eyewear/gi],
      exclusions: [],
    },
    hearing: {
      kind,
      keywords: [/hearing\s+(services|benefits|aid|aids|allowance|maximum)/gi, /hearing\s+aid/gi],
      strongLabels: [/hearing/gi],
      exclusions: [],
    },
    transportation: {
      kind,
      keywords: [/transportation/gi, /one-way\s+trips/gi, /routine\s+transportation/gi],
      strongLabels: [/transportation|one-way\s+trips/gi],
      exclusions: [],
    },
  };

  return configs[kind];
}

function regexHits(regexes: RegExp[], text: string): number {
  return regexes.reduce((hits, regex) => {
    regex.lastIndex = 0;
    return hits + (regex.test(text) ? 1 : 0);
  }, 0);
}

function nearestKeywordDistance(snippet: string, amountIndex: number, keywords: RegExp[]): number {
  const distances: number[] = [];
  for (const keyword of keywords) {
    keyword.lastIndex = 0;
    for (const match of snippet.matchAll(keyword)) {
      distances.push(Math.abs((match.index ?? 0) - amountIndex));
    }
  }
  return distances.length ? Math.min(...distances) : Number.POSITIVE_INFINITY;
}

function contextAround(text: string, index: number, before = 130, after = 170): string {
  return cleanText(text.slice(Math.max(0, index - before), Math.min(text.length, index + after)));
}

function scoreAmountCandidate(
  text: string,
  windowText: string,
  windowStart: number,
  amountMatch: RegExpMatchArray,
  allAmounts: number[],
  config: BenefitConfig,
): CandidateAmount | null {
  const amount = moneyToNumber(amountMatch[0]);
  if (amount == null) return null;

  const amountIndex = amountMatch.index ?? 0;
  const absoluteIndex = windowStart + amountIndex;
  const local = contextAround(windowText, amountIndex);
  const lowerLocal = local.toLowerCase();
  const lowerWindow = windowText.toLowerCase();
  const period = detectPeriod(local) || detectPeriod(windowText);
  const distance = nearestKeywordDistance(windowText, amountIndex, config.keywords);
  const competingAmounts = new Set(allAmounts).size;
  const debug: string[] = [];
  let score = 0.42;

  // Prefer explicitly labeled card/allowance values close to OTC or food words;
  // this is the main guard against dental/vision maxima elsewhere in a table.
  if (distance <= 80) {
    score += 0.19;
    debug.push(`strong proximity (${distance} chars)`);
  } else if (distance <= 180) {
    score += 0.1;
    debug.push(`moderate proximity (${distance} chars)`);
  } else {
    score -= 0.13;
    debug.push(`weak keyword proximity (${Number.isFinite(distance) ? distance : "none"} chars)`);
  }

  const labelHits = regexHits(config.strongLabels, local);
  if (labelHits) {
    score += Math.min(0.18, labelHits * 0.09);
    debug.push("explicit benefit label");
  }

  const cadenceScore = periodScore(period);
  score += cadenceScore;
  debug.push(period ? `${period} cadence` : "unclear cadence");

  if (/allowance|credit|card|benefit|reload|loaded|per|each|every/.test(lowerLocal)) {
    score += 0.08;
    debug.push("allowance/card wording near amount");
  }

  if (/combined|total\s+combined|up\s+to|summary|highlights?|maximum\s+benefit|annual\s+maximum/.test(lowerLocal)) {
    score -= 0.12;
    debug.push("possible combined or marketing total");
  }

  if (/annual|annually|calendar\s+year|plan\s+year/.test(lowerLocal) && period !== "month" && period !== "quarter") {
    score -= 0.1;
    debug.push("annual wording penalty");
  }

  // Skip exclusion penalty for Humana combined OTC+food card (Healthy Options
  // Allowance) — the food-related exclusion pattern fires on "food allowance"
  // text that is expected/intentional for this carrier's combined card.
  const isHumanaCombinedCard = /healthy\s+options\s+allowance|humana\s+healthy\s+options/i.test(windowText);
  if (!isHumanaCombinedCard && config.exclusions.some((regex) => {
    regex.lastIndex = 0;
    return regex.test(local) || regex.test(lowerWindow);
  })) {
    score -= 0.23;
    debug.push("near unrelated benefit wording");
  }

  // OTC and food/flex card sections often sit next to each other or share a
  // carrier card name. Require the local sentence around the dollar amount to
  // carry the right benefit vocabulary before giving it high confidence.
  if (config.kind === "food") {
    const hasFoodLocal = /food|foods|grocery|groceries|utility|utilities|healthy\s+options|extra\s+supports?\s+wallet/.test(lowerLocal);
    const hasOtcLocal = /\botc\b|over.?the.?counter|health(?:y)?\s+options\s+allowance|humana\s+healthy\s+options|health\s+and\s+wellness\s+products?|wellcare\s+spendables|\bspendables\b|preloaded\s+on\s+your/.test(lowerLocal);
    if (hasOtcLocal && !hasFoodLocal) {
      score -= 0.38;
      debug.push("OTC wording without local food/utility label");
    } else if (!hasFoodLocal) {
      score -= 0.18;
      debug.push("missing local food/utility label");
    }
  }

  if (config.kind === "otc") {
    const hasOtcLocal = /\botc\b|over.?the.?counter|health(?:y)?\s+options\s+allowance|humana\s+healthy\s+options|health\s+and\s+wellness\s+products?|wellcare\s+spendables|\bspendables\b|preloaded\s+on\s+your/.test(lowerLocal);
    const hasFoodLocal = /food|foods|grocery|groceries|utility|utilities/.test(lowerLocal);
    if (hasFoodLocal && !hasOtcLocal) {
      score -= 0.28;
      debug.push("food/utility wording without local OTC label");
    }
  }

  if (amount >= 1500 && (config.kind === "otc" || config.kind === "food")) {
    score -= 0.22;
    debug.push("large amount likely annual/dental/vision maximum");
  } else if (amount >= 750 && period !== "month" && period !== "quarter" && (config.kind === "otc" || config.kind === "food")) {
    score -= 0.12;
    debug.push("large amount without preferred cadence");
  }

  // An allowance/credit dollar value is never a copay. Cost-share rows often
  // sit directly above the OTC row in benefit tables (e.g. UHC H2802-41:
  // "individual therapy visit 2 $25 copay Not covered OTC credit $35 credit
  // every quarter") and the copay amount lands inside the OTC keyword window
  // with the same proximity/cadence credit as the real allowance. Penalize
  // amounts immediately followed by cost-share wording. (2026-06-10)
  if (config.kind === "otc" || config.kind === "food") {
    const after = windowText.slice(amountIndex + amountMatch[0].length, amountIndex + amountMatch[0].length + 30).toLowerCase();
    if (/^\s*(?:copay|co-?pay(?:ment)?|coinsurance|per\s+visit)/.test(after)) {
      score -= 0.3;
      debug.push("cost-share wording right after amount");
    }
  }

  if (competingAmounts > 1) {
    const penalty = Math.min(0.14, (competingAmounts - 1) * 0.035);
    score -= penalty;
    debug.push(`${competingAmounts} competing dollar values`);
  }

  if (!period) score -= 0.05;
  if (!/\$\s?[\d,]+/.test(local)) return null;

  return {
    amount,
    period,
    confidence: Math.max(0, Math.min(0.98, Number(score.toFixed(2)))),
    page: pageNumberForIndex(text, absoluteIndex),
    evidence: local,
    debug,
  };
}

// Matches all three category keywords in the same clause (no sentence boundary
// between them). Sentence-boundary chars (.!?\n) act as stop markers so this
// cannot fire across separate benefit sections (e.g. Devoted's "OTC) items.
// [sentence end] Food & Home Card $60" pattern correctly doesn't match).
const COMBINED_OTC_FOOD_UTIL_RE = /(?:(?:OTC|over.?the.?counter)[^.!?\n]{0,80}(?:food\b|grocery)[^.!?\n]{0,80}utilit|(?:food\b|grocery)[^.!?\n]{0,80}(?:OTC|over.?the.?counter)[^.!?\n]{0,80}utilit|utilit[^.!?\n]{0,80}(?:OTC|over.?the.?counter)[^.!?\n]{0,80}(?:food\b|grocery))/gi;

function findCombinedOtcFoodUtil(text: string): ExtractedBenefit | null {
  const moneyRe = /\$\s?[\d,]+(?:\.\d{2})?/g;

  for (const phraseMatch of text.matchAll(COMBINED_OTC_FOOD_UTIL_RE)) {
    const phraseStart = phraseMatch.index ?? 0;
    const phraseEnd = phraseStart + phraseMatch[0].length;

    // Search for dollar amounts in a generous zone around the phrase.
    const zoneStart = Math.max(0, phraseStart - 250);
    const zoneEnd = Math.min(text.length, phraseEnd + 250);
    const zone = cleanText(text.slice(zoneStart, zoneEnd));

    const moneyMatches = [...zone.matchAll(moneyRe)];
    const amounts = moneyMatches
      .map((m) => moneyToNumber(m[0]))
      .filter((n): n is number => n != null);
    const distinctAmounts = new Set(amounts);

    // Require exactly one distinct dollar amount — two or more means separate
    // allowances stated near each other, not a single combined line.
    if (distinctAmounts.size !== 1) continue;

    const amount = [...distinctAmounts][0];
    const firstMoney = moneyMatches.find((m) => moneyToNumber(m[0]) === amount)!;
    const absoluteIdx = zoneStart + (firstMoney.index ?? 0);

    const evidenceSnippet = cleanText(
      text.slice(Math.max(0, phraseStart - 60), Math.min(text.length, phraseEnd + 100)),
    );
    const period = detectPeriod(evidenceSnippet) || detectPeriod(zone);

    let confidence = 0.90;
    if (!period) confidence -= 0.07;
    // Large annual amounts are suspicious without a clear annual cadence word
    if (amount >= 2000 && period !== "month" && period !== "quarter") confidence -= 0.10;

    return {
      amount,
      period,
      page: pageNumberForIndex(text, absoluteIdx),
      confidence: Math.max(0, Math.min(0.98, Number(confidence.toFixed(2)))),
      evidence: `combined OTC/food/utilities — ${evidenceSnippet.slice(0, 400)}`,
    };
  }

  return null;
}

// --- SSBCI condition-gating detection (phrase-based, carrier-agnostic) ---
// Validated 2026-05-28 across Aetna/UHC/Humana/Devoted D-SNPs (all correctly
// flagged conditional) and 3 HealthSpring plans (all correctly NOT flagged).
// A header-based parser fails because each carrier names the section
// differently; these phrases are the cross-carrier signal.
const SSBCI_GATING = /(chronically ill|special supplemental benefit|not all members qualify|available only to|high value (?:primary care )?(?:provider|pcp)|hvpip|\bssbci\b|diagnosed with (?:one or more )?(?:of the )?chronic|certain qualifying chronic|qualifying (?:chronic )?condition|if (?:you|they) have (?:certain )?(?:qualifying )?chronic|chronic condition\(s\))/gi;
// Guard: HealthSpring uses "qualifying inpatient/hospital stay" for
// post-discharge meals — that is NOT chronic-condition gating.
const SSBCI_FALSE_POSITIVE = /qualifying (?:inpatient|hospital|skilled nursing|facility|stay)/gi;
// Expansion model: the gated categories share the base OTC/spending card and
// add NO new money (Aetna/UHC/Humana).
const SSBCI_EXPANDS = /(will change to|replace your otc|not get any additional funds|may also use this money|plus,? members|plus,? (?:healthy )?(?:food|grocer)|same (?:card|wallet|allowance)|this (?:money|allowance|card) (?:also|can))/gi;
// Standalone model: a dedicated gated food/home/grocery card with its own
// dollar amount (Devoted).
const SSBCI_STANDALONE = /(?:(?:food\s*(?:and|&)\s*home card|healthy foods? card|grocery card|food card)[^.]{0,140}\$\s?\d[\d,]*|\$\s?\d[\d,]*[^.]{0,140}(?:food\s*(?:and|&)\s*home card|healthy foods? card|grocery card|food card))/gi;
const SSBCI_CHRONIC_CTX = /chronic|special supplemental|\bssbci\b|hvpip|high value/i;

function analyzeSsbci(text: string): SsbciAnalysis {
  // pdf-parse inserts hard newlines mid-phrase ("Food & Home Card \n(Special\n...\n$156"),
  // which breaks any regex relying on a single line or on [^.\n] proximity. Detect on a
  // whitespace-normalized copy so phrases and card->$ proximity survive line wrapping.
  const flat = text.replace(/\s+/g, " ");

  const real: RegExpMatchArray[] = [];
  SSBCI_GATING.lastIndex = 0;
  for (const m of flat.matchAll(SSBCI_GATING)) {
    const idx = m.index ?? 0;
    const win = flat.slice(Math.max(0, idx - 40), idx + m[0].length + 40);
    SSBCI_FALSE_POSITIVE.lastIndex = 0;
    if (SSBCI_FALSE_POSITIVE.test(win) && !SSBCI_CHRONIC_CTX.test(win)) continue;
    real.push(m);
  }

  if (!real.length) {
    return { isConditional: false, expandsBase: false, isStandalone: false, conditionNote: null, evidencePage: null };
  }

  SSBCI_EXPANDS.lastIndex = 0;
  const expandsBase = SSBCI_EXPANDS.test(flat);
  SSBCI_STANDALONE.lastIndex = 0;
  const isStandalone = SSBCI_STANDALONE.test(flat) && !expandsBase;

  // Prefer a gating match that sits in clearly chronic/SSBCI context for the note.
  const chosen = real.find((m) => {
    const idx = m.index ?? 0;
    return SSBCI_CHRONIC_CTX.test(flat.slice(Math.max(0, idx - 60), idx + m[0].length + 60));
  }) ?? real[0];

  // Take from the gating phrase forward to the next sentence end so the note reads cleanly.
  const kw = chosen[0].toLowerCase();
  let i = flat.toLowerCase().indexOf(kw);
  if (i < 0) i = 0;
  const seg = flat.slice(i, i + 260);
  const dot = seg.indexOf(". ");
  const conditionNote = (dot !== -1 ? seg.slice(0, dot + 1) : seg).trim().slice(0, 240);

  // evidencePage needs an index into the ORIGINAL text (it counts form-feeds), so
  // locate the chosen phrase there with a whitespace-flexible search.
  const flexible = new RegExp(
    chosen[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"),
    "i"
  );
  const orig = flexible.exec(text);
  const origIdx = orig ? orig.index : 0;

  return {
    isConditional: true,
    expandsBase,
    isStandalone,
    conditionNote,
    evidencePage: pageNumberForIndex(text, origIdx),
  };
}

function findBenefit(text: string, config: BenefitConfig): ExtractedBenefit {
  const candidates: CandidateAmount[] = [];
  const moneyRegex = /\$\s?[\d,]+(?:\.\d{2})?/g;

  for (const keyword of config.keywords) {
    keyword.lastIndex = 0;
    for (const match of text.matchAll(keyword)) {
      const idx = match.index ?? 0;
      const start = Math.max(0, idx - 450);
      const end = Math.min(text.length, idx + 850);
      const rawWindow = text.slice(start, end);
      const windowText = cleanText(rawWindow);
      const matches = [...windowText.matchAll(moneyRegex)];
      const amounts = matches.map((m) => moneyToNumber(m[0])).filter((n): n is number => n != null);

      for (const amountMatch of matches) {
        const candidate = scoreAmountCandidate(text, windowText, start, amountMatch, amounts, config);
        if (candidate) candidates.push(candidate);
      }
    }
  }

  if (!candidates.length) {
    return { amount: null, period: null, page: null, confidence: 0, evidence: null };
  }

  candidates.sort((a, b) => b.confidence - a.confidence);
  const best = candidates[0];
  // Runner-up = best-scoring candidate with a DIFFERENT amount. Duplicate
  // windows produce many copies of the same candidate; comparing against a
  // duplicate (same amount) used to skip the guard, while a float-noise tie
  // (0.91 - 0.83 = 0.0799…) used to fire it spuriously. (2026-06-10)
  const runnerUp = candidates.find((c) => c.amount !== best.amount);

  if (runnerUp && best.confidence - runnerUp.confidence < 0.075) {
    best.confidence = Math.max(0, Number((best.confidence - 0.08).toFixed(2)));
    best.debug.push("close competing candidate penalty");
  }

  if (DEBUG) {
    console.log(`[debug] ${config.kind} top candidates`);
    for (const candidate of candidates.slice(0, 5)) {
      console.log({
        amount: candidate.amount,
        period: candidate.period,
        confidence: candidate.confidence,
        page: candidate.page,
        debug: candidate.debug,
        evidence: candidate.evidence.slice(0, 220),
      });
    }
  }

  return {
    amount: best.amount,
    period: best.period,
    page: best.page,
    confidence: best.confidence,
    evidence: best.evidence.slice(0, 650),
    ...(DEBUG ? { debug: best.debug } : {}),
  };
}

async function loadPlanContext(planIds: string[], year: number | null, organization?: string | null): Promise<PlanContext> {
  if (organization) return { organizationName: organization, planName: null };
  const normalizedIds = planIds.map((id) => id.replace(/-(\d{3})$/, (_, p) => `-${Number(p)}`));
  const plan = await prisma.plan.findFirst({
    where: {
      planId: { in: normalizedIds },
      ...(year ? { planYear: year } : {}),
    },
    select: { organizationName: true, planName: true },
  });

  return {
    organizationName: plan?.organizationName || null,
    planName: plan?.planName || null,
  };
}

interface SpendablesResult {
  amount: number | null;
  period: string | null;
  coversFood: boolean;
  evidence: string;
}

export function extractWellcareSpendables(layoutText: string, plan3: string): SpendablesResult | null {
  if (!/spendables/i.test(layoutText)) return null;
  const lines = layoutText.split(/\r?\n/);

  // 1. Column anchors: collect x-offsets of "Plan ###" header tokens per plan number.
  //    Headers repeat per page; use the median x-offset per plan number for stability.
  const anchors = new Map<string, number[]>();
  const headerRe = /H\d{4},?\s*Plan\s*(\d{3})/g;
  for (const line of lines) {
    let m: RegExpExecArray | null;
    headerRe.lastIndex = 0;
    while ((m = headerRe.exec(line)) !== null) {
      const arr = anchors.get(m[1]) ?? [];
      arr.push(m.index);
      anchors.set(m[1], arr);
    }
  }
  const median = (a: number[]) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const planCols = [...anchors.entries()]
    .map(([p, xs]) => ({ plan: p, x: median(xs) }))
    .sort((a, b) => a.x - b.x);

  // Single-plan doc (or no headers found): simple multiline regex on collapsed text.
  if (planCols.length <= 1) {
    const flat = layoutText.replace(/\s+/g, " ");
    const m = /(?:you will receive\s+)?\$\s?([\d,]+)\s+(monthly|quarterly|per month|per quarter|every month|every quarter)[^.]{0,60}?preloaded on your\s+wellcare\s+spendables/i.exec(flat);
    if (!m) return null;
    const coversFood = /card allowance can be used towards[^]*?(healthy foods?|groceries|food)/i.test(flat.slice(m.index, m.index + 1200));
    return { amount: Number(m[1].replace(/,/g, "")), period: /quarter/i.test(m[2]) ? "quarter" : "month", coversFood, evidence: m[0].slice(0, 160) };
  }

  // 2. Multi-plan: find target column boundaries [xStart, xEnd).
  const idx = planCols.findIndex(c => c.plan === plan3);
  if (idx === -1) return null;
  const PAD = 6;
  const xStart = Math.max(0, planCols[idx].x - PAD);
  const xEnd = idx + 1 < planCols.length ? planCols[idx + 1].x - PAD : Number.MAX_SAFE_INTEGER;

  // 3. Find each "Wellcare Spendables" label row; take the ~25 lines after it,
  //    slice the target column, and parse.
  for (let i = 0; i < lines.length; i++) {
    if (!/wellcare\s+spendables/i.test(lines[i])) continue;
    // benefit labels live in the left label column; skip rewards-section mentions
    const labelX = lines[i].search(/\S/);
    if (labelX > 40) continue;
    const cell: string[] = [];
    for (let j = i; j < Math.min(i + 26, lines.length); j++) {
      cell.push(lines[j].slice(xStart, xEnd === Number.MAX_SAFE_INTEGER ? undefined : xEnd).trim());
    }
    const cellText = cell.join(" ").replace(/\s+/g, " ").trim();
    const m = /\$\s?([\d,]+)\s+(monthly|quarterly|per month|per quarter|every month|every quarter)/i.exec(cellText);
    if (m) {
      const coversFood = /(healthy foods?|groceries|food items?)/i.test(cellText);
      return { amount: Number(m[1].replace(/,/g, "")), period: /quarter/i.test(m[2]) ? "quarter" : "month", coversFood, evidence: cellText.slice(0, 160) };
    }
    if (/not covered/i.test(cellText)) {
      return { amount: null, period: null, coversFood: false, evidence: "Not covered (column-resolved)" };
    }
  }
  return null;
}

async function extractPdf(item: DiscoveryResult, context?: PlanContext): Promise<ExtractionResult> {
  const file = item.file;
  const buffer = await fs.promises.readFile(file);
  const checksum = crypto.createHash("sha256").update(buffer).digest("hex");
  const parsed = await pdf(buffer);
  let text = parsed.text || "";
  let layoutText: string | null = null;
  // pdftotext -layout (2026-06-10/2026-06-11): two purposes —
  //   1. Fallback when pdf-parse returns near-empty text (Humana font mismatches)
  //   2. Column-aware extraction for Wellcare multi-plan comparison SBs
  // Requires poppler's pdftotext on PATH (project prereq per HANDOFF).
  const needsLayout = text.trim().length < 500 || /spendables/i.test(text);
  if (needsLayout) {
    const { execFileSync } = await import("child_process");
    // On Windows the binary may only be in the Git MinGW prefix, not system PATH.
    const pdftotextCandidates = process.platform === "win32"
      ? ["pdftotext", "C:\\Program Files\\Git\\mingw64\\bin\\pdftotext.exe"]
      : ["pdftotext"];
    for (const bin of pdftotextCandidates) {
      try {
        const alt = execFileSync(bin, ["-layout", file, "-"], {
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        });
        if (alt && alt.trim().length > 0) {
          layoutText = alt;
          if (text.trim().length < 500 && alt.trim().length > text.trim().length) text = alt;
          break;
        }
      } catch {
        // try next candidate or give up
      }
    }
  }
  const warnings: string[] = [...(item.warnings || [])];
  const carrier = getCarrier(`${file} ${text}`, context);
  const derivedFilenameYear = item.filenameYear ?? filenameYear(file);
  const yearSource = item.yearSource || (item.year ? "unknown" : "unknown");
  const yearConfidence = item.yearConfidence ?? 0;

  if (text.trim().length < 500) {
    warnings.push("PDF text extraction returned very little text; OCR may be needed.");
  }

  if (derivedFilenameYear && item.year && derivedFilenameYear !== item.year) {
    warnings.push(`Discovery year ${item.year} conflicts with filename year ${derivedFilenameYear}.`);
  }

  if (item.year == null) {
    warnings.push("Discovery year is null; DB update is unsafe.");
  } else if (yearConfidence < MIN_YEAR_UPDATE_CONFIDENCE) {
    warnings.push(`Plan-year confidence ${yearConfidence} from ${yearSource} is below ${MIN_YEAR_UPDATE_CONFIDENCE}; DB update is unsafe.`);
  }

  if (DEBUG) console.log(`[debug] extracting ${file} carrier=${carrier}`);

  const EMPTY_BENEFIT: ExtractedBenefit = { amount: null, period: null, page: null, confidence: 0, evidence: null };

  // Pre-pass 1: Wellcare Spendables column-aware extraction.
  // Uses pdftotext -layout output for correct column attribution in multi-plan docs.
  // Confidence 0.93 (column-resolved) always clears MIN_UPDATE_CONFIDENCE.
  // Spendables is one combined wallet — same-wallet rule: OTC only, food=null.
  const plan3 = item.planIds[0]?.match(/-(\d+)$/)?.[1]?.padStart(3, "0") ?? null;
  const spendables = plan3 !== null ? extractWellcareSpendables(layoutText ?? text, plan3) : null;

  let otc: ExtractedBenefit;
  let food: ExtractedBenefit;

  if (spendables !== null) {
    otc = { amount: spendables.amount, period: spendables.period, page: null, confidence: 0.93, evidence: spendables.evidence };
    food = EMPTY_BENEFIT;
  } else {
    // Pre-pass 2: if a single dollar amount serves OTC, food, AND utilities in one
    // clause it is one combined wallet — same-wallet rule (2026-06-11): write the
    // amount to OTC only, null out food.
    const combined = findCombinedOtcFoodUtil(text);
    otc = combined ?? findBenefit(text, benefitConfig("otc", carrier));
    food = combined ? EMPTY_BENEFIT : findBenefit(text, benefitConfig("food", carrier));
  }
  const dental = findBenefit(text, benefitConfig("dental", carrier));
  const vision = findBenefit(text, benefitConfig("vision", carrier));
  const hearing = findBenefit(text, benefitConfig("hearing", carrier));
  const transportation = findBenefit(text, benefitConfig("transportation", carrier));
  const ssbci = analyzeSsbci(text);

  return {
    file,
    checksum,
    planIds: item.planIds,
    year: item.year,
    yearSource,
    yearConfidence,
    filenameYear: derivedFilenameYear,
    downloadListYear: item.downloadListYear ?? null,
    documentTitleYear: item.documentTitleYear ?? null,
    textFallbackYear: item.textFallbackYear ?? null,
    textYears: item.textYears || [],
    otc,
    food,
    dental,
    vision,
    hearing,
    transportation,
    ssbci,
    warnings,
  };
}

function annualize(amount: number | null, period: string | null): number | null {
  if (amount == null) return null;
  if (period === "month") return amount * 12;
  if (period === "quarter") return amount * 4;
  return amount;
}

function yearSafetyWarnings(result: ExtractionResult, allowYearConflicts: boolean): string[] {
  const warnings: string[] = [];

  if (result.year == null) {
    warnings.push("Skipping DB update because discovery year is null.");
  }

  if (
    result.filenameYear
    && result.year
    && result.filenameYear !== result.year
    && !allowYearConflicts
  ) {
    warnings.push(`Skipping DB update because discovery year ${result.year} conflicts with filename year ${result.filenameYear}.`);
  }

  if (result.yearConfidence < MIN_YEAR_UPDATE_CONFIDENCE) {
    warnings.push(`Skipping DB update because year confidence ${result.yearConfidence} from ${result.yearSource} is below ${MIN_YEAR_UPDATE_CONFIDENCE}.`);
  }

  return warnings;
}

async function updatePlans(result: ExtractionResult, dryRun: boolean, allowYearConflicts: boolean) {
  const safetyWarnings = yearSafetyWarnings(result, allowYearConflicts);
  if (safetyWarnings.length) {
    for (const warning of safetyWarnings) {
      if (!result.warnings.includes(warning)) result.warnings.push(warning);
      console.warn(`${path.basename(result.file)}: ${warning}`);
    }
    return;
  }

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
      ssbciIsConditional: result.ssbci.isConditional,
      ssbciIsStandalone: result.ssbci.isStandalone,
      ssbciConditionNote: result.ssbci.conditionNote,
    };

    if (result.otc.confidence >= MIN_UPDATE_CONFIDENCE) {
      data.sbVerifiedOtcAmount = annualize(result.otc.amount, result.otc.period);
      data.sbVerifiedOtcPeriod = result.otc.period; // filed cadence per the SB (2026-06-10)
    } else if (result.otc.amount != null) {
      console.warn(`Skipping OTC verified amount for ${planId}; confidence ${result.otc.confidence} < ${MIN_UPDATE_CONFIDENCE}`);
    }

    if (result.food.confidence >= MIN_FOOD_CONFIDENCE) {
      data.sbVerifiedFoodAmount = annualize(result.food.amount, result.food.period);
      data.sbVerifiedFoodPeriod = result.food.period; // filed cadence per the SB (2026-06-10)
    } else if (result.food.amount != null) {
      console.warn(`Skipping food verified amount for ${planId}; confidence ${result.food.confidence} < ${MIN_FOOD_CONFIDENCE}`);
    }

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
  const discoveryPath = process.argv.slice(2).find((arg) => !arg.startsWith("--")) || "./sb-discovery-results.json";
  const dryRun = process.argv.includes("--dry-run");
  const updateDb = process.argv.includes("--update-db");
  const allowYearConflicts = process.argv.includes("--allow-year-conflicts");

  const discovery: DiscoveryResult[] = JSON.parse(await fs.promises.readFile(discoveryPath, "utf8"));
  const results: ExtractionResult[] = [];

  for (const item of discovery) {
    const context = await loadPlanContext(item.planIds, item.year, item.organization);
    const result = await extractPdf(item, context);
    results.push(result);
    if (updateDb) await updatePlans(result, dryRun, allowYearConflicts);
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
