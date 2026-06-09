// scripts/backfill-ssbci-classification.ts
//
// SSBCI Step D data backfill (2026-06-09). Classifies every plan that has an SB
// PDF (sbPdfUrl) AND at least one SSBCI offer flag, by downloading the PDF from
// Vercel Blob, extracting text with pdf-parse, and running the validated
// analyzeSsbci() classifier. The SSBCI_* regexes below are copied VERBATIM from
// scripts/extract-sb-benefits.ts (which can't be imported because it runs main()
// on load). Writes ssbciIsConditional / ssbciIsStandalone / ssbciConditionNote.
//
// Columns already exist in prod — no schema change.
//
// USAGE (from repo root):
//   npx tsx scripts/backfill-ssbci-classification.ts              # dry-run
//   npx tsx scripts/backfill-ssbci-classification.ts --apply      # write
//   npx tsx scripts/backfill-ssbci-classification.ts --apply --limit 20
//
import pdf from "pdf-parse";
const { makePrisma } = require("./prisma-client");
const prisma = makePrisma();

const APPLY = process.argv.includes("--apply");
const limIdx = process.argv.indexOf("--limit");
const LIMIT = limIdx >= 0 ? parseInt(process.argv[limIdx + 1], 10) : Infinity;

// ── validated SSBCI classifier — regexes VERBATIM from extract-sb-benefits.ts ──
const SSBCI_GATING = /(chronically ill|special supplemental benefit|not all members qualify|available only to|high value (?:primary care )?(?:provider|pcp)|hvpip|\bssbci\b|diagnosed with (?:one or more )?(?:of the )?chronic|certain qualifying chronic|qualifying (?:chronic )?condition|if (?:you|they) have (?:certain )?(?:qualifying )?chronic|chronic condition\(s\))/gi;
const SSBCI_FALSE_POSITIVE = /qualifying (?:inpatient|hospital|skilled nursing|facility|stay)/gi;
const SSBCI_EXPANDS = /(will change to|replace your otc|not get any additional funds|may also use this money|plus,? members|plus,? (?:healthy )?(?:food|grocer)|same (?:card|wallet|allowance)|this (?:money|allowance|card) (?:also|can))/gi;
const SSBCI_STANDALONE = /(?:(?:food\s*(?:and|&)\s*home card|healthy foods? card|grocery card|food card)[^.]{0,140}\$\s?\d[\d,]*|\$\s?\d[\d,]*[^.]{0,140}(?:food\s*(?:and|&)\s*home card|healthy foods? card|grocery card|food card))/gi;
const SSBCI_CHRONIC_CTX = /chronic|special supplemental|\bssbci\b|hvpip|high value/i;

interface SsbciResult { isConditional: boolean; isStandalone: boolean; conditionNote: string | null; }

function analyzeSsbci(text: string): SsbciResult {
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
  if (!real.length) return { isConditional: false, isStandalone: false, conditionNote: null };

  SSBCI_EXPANDS.lastIndex = 0;
  const expandsBase = SSBCI_EXPANDS.test(flat);
  SSBCI_STANDALONE.lastIndex = 0;
  const isStandalone = SSBCI_STANDALONE.test(flat) && !expandsBase;

  const chosen = real.find((m) => {
    const idx = m.index ?? 0;
    return SSBCI_CHRONIC_CTX.test(flat.slice(Math.max(0, idx - 60), idx + m[0].length + 60));
  }) ?? real[0];

  const kw = chosen[0].toLowerCase();
  let i = flat.toLowerCase().indexOf(kw);
  if (i < 0) i = 0;
  const seg = flat.slice(i, i + 260);
  const dot = seg.indexOf(". ");
  const conditionNote = (dot !== -1 ? seg.slice(0, dot + 1) : seg).trim().slice(0, 240);

  return { isConditional: true, isStandalone, conditionNote };
}

async function main() {
  // Relevant set: plans that have an SB PDF AND at least one SSBCI offer flag.
  const plans: Array<{ planId: string; planYear: number | null; sbPdfUrl: string | null }> =
    await prisma.plan.findMany({
      where: {
        sbPdfUrl: { not: null },
        OR: [
          { ssbciOffersFood: true },
          { ssbciOffersMeals: true },
          { ssbciOffersUtilities: true },
          { ssbciOffersHousing: true },
          { ssbciOffersTransportation: true },
        ],
      },
      select: { planId: true, planYear: true, sbPdfUrl: true },
    });

  // One PDF serves many county rows / planIds — dedupe the download by URL.
  const byUrl = new Map<string, { url: string; planIds: Set<string>; year: number | null }>();
  for (const p of plans) {
    if (!p.sbPdfUrl) continue;
    const e = byUrl.get(p.sbPdfUrl) ?? { url: p.sbPdfUrl, planIds: new Set<string>(), year: p.planYear };
    e.planIds.add(p.planId);
    byUrl.set(p.sbPdfUrl, e);
  }

  const jobs = [...byUrl.values()].slice(0, LIMIT);
  console.log(`${jobs.length} distinct SB PDFs to classify (${plans.length} plan-rows). ${APPLY ? "APPLY (writing)" : "DRY-RUN"}.`);

  let cond = 0, clean = 0, standalone = 0, failed = 0, written = 0;

  for (let n = 0; n < jobs.length; n++) {
    const job = jobs[n];
    let analysis: SsbciResult;
    try {
      const res = await fetch(job.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const parsed = await pdf(buf);
      analysis = analyzeSsbci(parsed.text || "");
    } catch (err: any) {
      failed++;
      console.warn(`  [${n + 1}/${jobs.length}] FETCH/PARSE FAIL ...${job.url.slice(-44)}: ${err.message}`);
      continue;
    }

    if (analysis.isConditional) cond++; else clean++;
    if (analysis.isStandalone) standalone++;

    if (APPLY) {
      const r = await prisma.plan.updateMany({
        where: { planId: { in: [...job.planIds] }, ...(job.year ? { planYear: job.year } : {}) },
        data: {
          ssbciIsConditional: analysis.isConditional,
          ssbciIsStandalone: analysis.isStandalone,
          ssbciConditionNote: analysis.conditionNote,
        },
      });
      written += r.count;
    }

    if ((n + 1) % 50 === 0 || n === jobs.length - 1) {
      console.log(`  …${n + 1}/${jobs.length} (conditional ${cond}, clean ${clean}, standalone ${standalone}, failed ${failed})`);
    }
  }

  console.log(`\nDONE. PDFs ${jobs.length} | conditional ${cond} | clean ${clean} | standalone ${standalone} | failed ${failed}`);
  if (APPLY) console.log(`Rows written: ${written}`);
  else console.log(`Dry-run only — no writes. Re-run with --apply to persist.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
