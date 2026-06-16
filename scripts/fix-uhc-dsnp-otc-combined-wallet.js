// scripts/fix-uhc-dsnp-otc-combined-wallet.js
//
// Fixes the 2026-06-16 audit's "UHC DSNP 98% OTC gap". Root cause (confirmed against
// 6+ SB PDFs and the production pdf-parse text): UHC's SB files OTC+food+utilities as
// ONE combined-wallet line ("OTC, healthy food, utilities + wellness support" / "$X
// credit every month for over-the-counter (OTC) products and wellness support, plus
// healthy food and utilities for qualifying members"). The existing
// findCombinedOtcFoodUtil() in scripts/extract-sb-benefits.ts requires exactly one
// distinct dollar amount within a +/-250-char zone around that phrase — but UHC's
// dense "Additional benefits" tables pack this row next to unrelated copay lines
// (e.g. "$0 copay" for a nearby outpatient visit), so the zone often contains 2+
// distinct amounts and the function bails, returning null for OTC. Separately, some
// other/earlier extraction pass DID find the same dollar amount and wrote it to
// sbVerifiedFoodAmount — violating the same-wallet rule (one wallet => OTC only).
//
// This script re-extracts using the FIXED logic (now also patched into
// extract-sb-benefits.ts) and corrects both sides: writes the amount to
// sbVerifiedOtcAmount/sbVerifiedOtcPeriod, and nulls the mis-attributed
// sbVerifiedFoodAmount/sbVerifiedFoodPeriod.
//
// Scope: only the UHC DSNP plans where food has a real value but OTC is null (the SB
// IS a valid 2026 document). Plans whose SB is broken (stale 2025 doc, wrong document
// type, etc.) are a SEPARATE workstream and are intentionally NOT touched here — they
// are printed as skipped.
//
// USAGE:
//   node scripts/fix-uhc-dsnp-otc-combined-wallet.js                 # dry-run
//   node scripts/fix-uhc-dsnp-otc-combined-wallet.js --apply         # write
//
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const pdf = require("pdf-parse");
const { makePrisma } = require("./prisma-client");
const prisma = makePrisma();

const APPLY = process.argv.includes("--apply");
const TMP = path.join(os.tmpdir(), "fix-uhc-otc");
fs.mkdirSync(TMP, { recursive: true });

function moneyToNumber(raw) {
  const n = parseFloat(raw.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function cleanText(t) {
  return t.replace(/\s+/g, " ").trim();
}
function detectPeriod(text) {
  const s = text.toLowerCase();
  if (/per\s+month|each\s+month|every\s+month|monthly|month(?:ly)?\s+(?:allowance|credit|amount|benefit)|\/\s*mo\b|\bmo\./.test(s)) return "month";
  if (/per\s+quarter|each\s+quarter|every\s+quarter|quarterly|every\s+3\s+months|3-month|three-month|\/\s*qtr|\bqtr\b/.test(s)) return "quarter";
  if (/per\s+year|each\s+year|annually|annual|yearly|calendar\s+year|plan\s+year|every\s+year|\/\s*yr\b|\byr\./.test(s)) return "year";
  return null;
}
function annualize(amount, period) {
  if (amount == null) return null;
  if (period === "month") return amount * 12;
  if (period === "quarter") return amount * 4;
  return amount;
}

const COMBINED_OTC_FOOD_UTIL_RE = /(?:(?:OTC|over.?the.?counter)[^.!?\n]{0,80}(?:food\b|grocery)[^.!?\n]{0,80}utilit|(?:food\b|grocery)[^.!?\n]{0,80}(?:OTC|over.?the.?counter)[^.!?\n]{0,80}utilit|utilit[^.!?\n]{0,80}(?:OTC|over.?the.?counter)[^.!?\n]{0,80}(?:food\b|grocery))/gi;

// Same logic as the patched scripts/extract-sb-benefits.ts findCombinedOtcFoodUtil().
function findCombinedOtcFoodUtil(text) {
  const moneyRe = /\$\s?[\d,]+(?:\.\d{2})?/g;
  for (const phraseMatch of text.matchAll(COMBINED_OTC_FOOD_UTIL_RE)) {
    const phraseStart = phraseMatch.index ?? 0;
    const phraseEnd = phraseStart + phraseMatch[0].length;
    const zoneStart = Math.max(0, phraseStart - 250);
    const zoneEnd = Math.min(text.length, phraseEnd + 250);
    const zone = cleanText(text.slice(zoneStart, zoneEnd));

    const moneyMatches = [...zone.matchAll(moneyRe)];
    const amounts = moneyMatches.map((m) => moneyToNumber(m[0])).filter((n) => n != null);
    const distinctAmounts = new Set(amounts);

    let amount;
    if (distinctAmounts.size === 1) {
      amount = [...distinctAmounts][0];
    } else {
      const creditMoneyRe = /\$\s?[\d,]+(?:\.\d{2})?\s*credit\b/gi;
      const creditAmounts = new Set(
        [...zone.matchAll(creditMoneyRe)].map((m) => moneyToNumber(m[0])).filter((n) => n != null),
      );
      if (creditAmounts.size !== 1) continue;
      amount = [...creditAmounts][0];
    }

    const evidenceSnippet = cleanText(text.slice(Math.max(0, phraseStart - 60), Math.min(text.length, phraseEnd + 100)));
    const period = detectPeriod(evidenceSnippet) || detectPeriod(zone);
    return { amount, period, evidence: evidenceSnippet.slice(0, 200) };
  }
  return null;
}

async function getText(planId, sbPdfUrl) {
  const dest = path.join(TMP, planId.replace(/[^A-Za-z0-9-]/g, "_") + ".pdf");
  if (!fs.existsSync(dest)) {
    execFileSync("curl", ["-s", "-f", "--max-time", "25", "-o", dest, sbPdfUrl], { stdio: ["ignore", "ignore", "ignore"] });
  }
  const buf = fs.readFileSync(dest);
  const parsed = await pdf(buf);
  if (parsed.text && parsed.text.trim().length >= 500) return parsed.text;
  // fall back to pdftotext -layout, same as the production pipeline
  try {
    const alt = execFileSync("pdftotext", ["-layout", dest, "-"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (alt && alt.trim().length > 0) return alt;
  } catch {}
  return parsed.text || "";
}

async function main() {
  const plans = await prisma.plan.findMany({
    where: { planCategory: "DSNP", organizationName: "UnitedHealthcare" },
    distinct: ["planId"],
    select: { planId: true, sbPdfUrl: true, otcAllowance: true, sbVerifiedOtcAmount: true, sbVerifiedFoodAmount: true },
  });

  const noBenefit = (v) => v == null || v <= 0;
  const effectiveOtc = (p) => (p.sbVerifiedOtcAmount > 0 ? p.sbVerifiedOtcAmount : p.otcAllowance > 0 ? p.otcAllowance : null);
  const candidates = plans.filter((p) => noBenefit(effectiveOtc(p)) && p.sbVerifiedFoodAmount > 0);

  console.log(`Candidates (food mis-populated, OTC null): ${candidates.length}`);

  let fixed = 0, skippedNoMatch = 0;
  for (const p of candidates) {
    let text;
    try {
      text = await getText(p.planId, p.sbPdfUrl);
    } catch (e) {
      console.log(`  ${p.planId}: FETCH FAILED (${e.message}) — skipped, likely a broken SB doc (separate workstream)`);
      continue;
    }
    const result = findCombinedOtcFoodUtil(text);
    if (!result) {
      console.log(`  ${p.planId}: no combined-wallet match found in SB text — skipped (needs manual review)`);
      skippedNoMatch++;
      continue;
    }
    const annualOtc = annualize(result.amount, result.period);
    console.log(`  ${p.planId}: OTC null -> $${result.amount}/${result.period} (annualized ${annualOtc}); food ${p.sbVerifiedFoodAmount} -> null`);
    fixed++;
    if (APPLY) {
      await prisma.plan.updateMany({
        where: { planId: p.planId },
        data: {
          sbVerifiedOtcAmount: annualOtc,
          sbVerifiedOtcPeriod: result.period,
          sbVerifiedFoodAmount: null,
          sbVerifiedFoodPeriod: null,
        },
      });
    }
  }

  console.log(`\nFixed: ${fixed} | no-match (manual review): ${skippedNoMatch} | total candidates: ${candidates.length}`);
  if (!APPLY) console.log("Dry-run — no writes. Re-run with --apply to persist.");
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
