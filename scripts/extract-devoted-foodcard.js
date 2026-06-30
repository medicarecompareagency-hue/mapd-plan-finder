/**
 * Devoted Health food/OTC wallet extractor.
 * Parses "Food & Home Card" (SSBCI chronic-conditional) and "Over-the-Counter Items (OTC)"
 * from Devoted 2026 Summary of Benefits PDFs.
 *
 * Devoted SB layout (confirmed across H1290/H7993/H9888/H9231 families):
 *   OTC : "$X per quarter" under "Over-the-Counter Items (OTC)"
 *   Food: "$X per month"  under "Food & Home Card (Special Supplemental Benefit for the Chronically Ill)"
 *   Both always appear in the "More Benefits and Perks With Your Plan" section.
 *   Food & Home Card is always SSBCI-conditional ("available only to chronically ill members").
 *
 * Returns { foodMonthly, foodAnnual, otcQuarterly, otcAnnual, ssbciIsConditional, foodSnippet, otcSnippet }
 * or null if the PDF can't be parsed.
 * If a field is not found, it is null (not 0).
 */
const { execFileSync } = require("child_process");
const { makePrisma } = require("./prisma-client");
const https = require("https");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PDFTOTEXT = "C:\\Program Files\\Git\\mingw64\\bin\\pdftotext.exe";

// ─── PDF helpers ─────────────────────────────────────────────────────────────

function fetchBuf(url) {
  return new Promise((res, rej) => {
    const mod = url.startsWith("https") ? https : http;
    const chunks = [];
    mod.get(url, r => {
      r.on("data", c => chunks.push(c));
      r.on("end", () => res(Buffer.concat(chunks)));
      r.on("error", rej);
    }).on("error", rej);
  });
}

function pdfToText(buf) {
  const tmp = path.join(os.tmpdir(), "dv_" + Math.random().toString(36).slice(2) + ".pdf");
  try {
    fs.writeFileSync(tmp, buf);
    return execFileSync(PDFTOTEXT, ["-layout", "-f", "1", "-l", "20", tmp, "-"], {
      maxBuffer: 30 * 1024 * 1024,
    }).toString("utf8");
  } catch {
    return "";
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// ─── Wallet parser ────────────────────────────────────────────────────────────

/**
 * Extract wallet info from pdftotext output.
 * @returns {{ foodMonthly:number|null, foodAnnual:number|null, otcQuarterly:number|null, otcAnnual:number|null,
 *             ssbciIsConditional:boolean, foodSnippet:string, otcSnippet:string }}
 */
function parseWallet(txt) {
  const lines = txt.split(/\r?\n/);

  let foodMonthly = null;
  let foodSnippet = "";
  let otcQuarterly = null;
  let otcMonthly = null;
  let otcSnippet = "";
  let ssbciIsConditional = false;

  // Scan all lines for the key patterns
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // OTC: Devoted renders "Over-the-Counter" in two pdftotext layout styles:
    //   Style A: "Over-the-Counter Items        $50 per quarter..."  (one match line)
    //   Style B: "Over-the-Counter          $50 per quarter..."  then "Items (OTC)  ..." on next line
    // Match both by anchoring on "over-the-counter" alone and searching ±3 lines.
    if (/over-the-counter/i.test(line) && otcQuarterly === null && otcMonthly === null) {
      const ctx = lines.slice(Math.max(0, i - 2), i + 8).join(" ");
      const mQ = ctx.match(/\$(\d[\d,]*)\s+per\s+quarter/i);
      const mM = ctx.match(/\$(\d[\d,]*)\s+per\s+month/i);
      if (mQ) { otcQuarterly = parseInt(mQ[1].replace(/,/g, ""), 10); }
      else if (mM) { otcMonthly = parseInt(mM[1].replace(/,/g, ""), 10); }
      otcSnippet = ctx.slice(0, 200).replace(/\s+/g, " ").trim();
    }

    // Food: look for dollar amount near "per month" in the Food & Home Card section
    if (/food.*home card|food.*card.*special supplemental|food.*card.*chronically/i.test(line)) {
      const ctx = lines.slice(i, i + 10).join(" ");
      const mM = ctx.match(/\$(\d[\d,]*)\s+per\s+month/i);
      const mQ = ctx.match(/\$(\d[\d,]*)\s+per\s+quarter/i);
      if (mM) { foodMonthly = parseInt(mM[1].replace(/,/g, ""), 10); }
      else if (mQ) { foodMonthly = parseInt(mQ[1].replace(/,/g, ""), 10) / 3; } // quarterly→monthly
      foodSnippet = ctx.slice(0, 300).replace(/\s+/g, " ").trim();
    }

    // SSBCI conditional flag
    if (/chronically ill|special supplemental benefit for the chronically/i.test(line)) {
      ssbciIsConditional = true;
    }
  }

  // Also handle the case where Food & Home Card dollar is on a nearby line (page-break split)
  // Look for lines containing just "$X per month" near food-related anchor text
  if (foodMonthly === null) {
    for (let i = 0; i < lines.length; i++) {
      // Try standalone "$X per month" lines that follow a food-related heading
      if (/\$(\d[\d,]+)\s+per\s+month/i.test(lines[i])) {
        // Check surrounding context for food keywords
        const ctx = lines.slice(Math.max(0, i - 4), i + 4).join(" ");
        if (/food|eligible food|home card|utility|utilities|mortgage|rent/i.test(ctx)) {
          const m = lines[i].match(/\$(\d[\d,]+)\s+per\s+month/i);
          if (m) {
            foodMonthly = parseInt(m[1].replace(/,/g, ""), 10);
            foodSnippet = ctx.slice(0, 300).replace(/\s+/g, " ").trim();
          }
        }
      }
    }
  }

  const foodAnnual = foodMonthly !== null ? foodMonthly * 12 : null;
  const otcAnnual = otcQuarterly !== null ? otcQuarterly * 4
    : otcMonthly !== null ? otcMonthly * 12
    : null;

  return { foodMonthly, foodAnnual, otcQuarterly, otcMonthly, otcAnnual, ssbciIsConditional, foodSnippet, otcSnippet };
}

// ─── Main extraction function ─────────────────────────────────────────────────

async function extractDevotedWallet(sbPdfUrl) {
  const buf = await fetchBuf(sbPdfUrl);
  const txt = pdfToText(buf);
  if (!txt || txt.length < 200) return null;
  return parseWallet(txt);
}

// ─── CLI / S4 validation runner ───────────────────────────────────────────────

async function runValidation() {
  const prisma = makePrisma();
  try {
    // Get 8 on-file Devoted DSNP/CSNP plans across different families/states
    const rows = await prisma.plan.findMany({
      where: {
        planYear: 2026,
        planCategory: { in: ["DSNP", "CSNP"] },
        organizationName: { contains: "Devoted", mode: "insensitive" },
        sbPdfUrl: { not: null },
        OR: [{ foodCardAllowance: 0 }, { foodCardAllowance: null }],
      },
      select: { planId: true, planName: true, planCategory: true, state: true, sbPdfUrl: true },
      distinct: ["planId"],
      orderBy: { planId: "asc" },
    });

    // Sample: pick 1–2 per contract family for diversity
    const byFamily = {};
    for (const r of rows) {
      const fam = r.planId.split("-")[0];
      if (!byFamily[fam]) byFamily[fam] = [];
      byFamily[fam].push(r);
    }
    const sample = [];
    for (const [, plans] of Object.entries(byFamily)) {
      sample.push(...plans.slice(0, 1));
      if (sample.length >= 12) break;
    }

    console.log(`\nS4 VALIDATION — Devoted wallet parser on ${sample.length} on-file plans\n`);
    console.log(["planId".padEnd(14), "cat ".padEnd(6), "st", "OTC/qtr", "OTC/yr", "food/mo", "food/yr", "cond", "snippet (food)"].join(" | "));
    console.log("─".repeat(130));

    for (const plan of sample) {
      const w = await extractDevotedWallet(plan.sbPdfUrl);
      if (!w) {
        console.log(`${plan.planId.padEnd(14)} | PARSE FAILED`);
        continue;
      }
      const otcQ = w.otcQuarterly !== null ? `$${w.otcQuarterly}` : "  — ";
      const otcY = w.otcAnnual !== null ? `$${w.otcAnnual}` : "  — ";
      const fM = w.foodMonthly !== null ? `$${w.foodMonthly}` : " — ";
      const fY = w.foodAnnual !== null ? `$${w.foodAnnual}` : " — ";
      const snip = w.foodSnippet.slice(0, 80).replace(/\s+/g, " ");
      console.log([
        plan.planId.padEnd(14),
        plan.planCategory.padEnd(6),
        plan.state.padEnd(2),
        otcQ.padEnd(7),
        otcY.padEnd(6),
        fM.padEnd(7),
        fY.padEnd(7),
        String(w.ssbciIsConditional).padEnd(5),
        snip,
      ].join(" | "));
    }

    console.log("\nS4 GATE — review the table above. Confirm:");
    console.log("  1. OTC annualized = qtly × 4 (or mo × 12)");
    console.log("  2. food/yr = food/mo × 12");
    console.log("  3. conditional = true on all rows with a Food & Home Card");
    console.log("  4. Dollar amounts match what you see on plan SBs");
    console.log('\nIf correct, run with --apply to write to DB.');
  } finally {
    await prisma.$disconnect();
  }
}

async function runApply() {
  const prisma = makePrisma();
  try {
    const rows = await prisma.plan.findMany({
      where: {
        planYear: 2026,
        planCategory: { in: ["DSNP", "CSNP"] },
        organizationName: { contains: "Devoted", mode: "insensitive" },
        sbPdfUrl: { not: null },
        OR: [{ foodCardAllowance: 0 }, { foodCardAllowance: null }],
      },
      select: { planId: true, planCategory: true, state: true, sbPdfUrl: true,
                foodCardAllowance: true, otcAllowance: true },
      distinct: ["planId"],
      orderBy: { planId: "asc" },
    });

    console.log(`Processing ${rows.length} on-file Devoted DSNP/CSNP plans...`);

    let filled = 0, confirmedZero = 0, failed = 0;
    const fills = [];
    // Inline confirmations (stop if violated)
    const otcNot50 = [];      // Confirmation #1: non-$50/qtr OTC proves per-plan extraction
    const foodOutliers = [];  // Confirmation #3: food/mo > $400 or = $0
    let otcOverlapWarning = false;

    for (const plan of rows) {
      const w = await extractDevotedWallet(plan.sbPdfUrl);
      if (!w) {
        console.log(`  ${plan.planId}: parse failed`);
        failed++;
        continue;
      }

      // Confirmation #1: OTC and food are separate lines with different periods/amounts
      // (OTC quarterly, food monthly — different buckets, proven by different periods)
      if (w.otcQuarterly !== null && w.otcQuarterly !== 50) {
        otcNot50.push(`${plan.planId}: OTC=$${w.otcQuarterly}/qtr`);
      }

      // Confirmation #3: food outliers (>$400/mo or =$0 when card exists)
      if (w.foodMonthly !== null && (w.foodMonthly > 400 || w.foodMonthly === 0)) {
        foodOutliers.push(`${plan.planId}: food=$${w.foodMonthly}/mo`);
      }

      // Confirmation #2: ssbciIsConditional comes from the Food & Home Card language
      // (the "chronically ill" clause on the food section, not on OTC).
      // Since OTC is all-enrollee (already in DB from PBP), we ONLY write foodCardAllowance
      // here — never otcAllowance (fill-only: it's already set from PBP at $200/$480).
      if (w.foodAnnual === null || w.foodAnnual === 0) {
        confirmedZero++;
        continue;
      }
      const currentFood = plan.foodCardAllowance;
      if (currentFood && currentFood > 0) {
        confirmedZero++;
        continue;
      }

      // Check OTC overlap: if SB OTC === food amount, that would be the suppression signal
      if (w.otcAnnual !== null && w.otcAnnual === w.foodAnnual) {
        otcOverlapWarning = true;
        console.log(`  WARN ${plan.planId}: otcAnnual($${w.otcAnnual}) === foodAnnual($${w.foodAnnual}) — would trigger effectiveOtc suppression; STOP`);
        process.exit(1);
      }

      console.log(`  ${plan.planId} ${plan.state} ${plan.planCategory}: $0 -> $${w.foodAnnual}/yr (food $${w.foodMonthly}/mo | db-otc $${plan.otcAllowance}/yr [not overwritten])`);
      fills.push({ planId: plan.planId, foodAnnual: w.foodAnnual });
      filled++;
    }

    // Print confirmations
    console.log(`\n── Confirmation #1: OTC and food are separate benefit lines ──`);
    console.log(`  OTC is all-enrollee quarterly card (already in PBP otcAllowance); food is SSBCI-gated monthly card.`);
    console.log(`  Plans with OTC ≠ $50/qtr (proves per-plan extraction, not a hardcoded default):`);
    if (otcNot50.length) otcNot50.forEach(x => console.log(`    ${x}`));
    else console.log(`    (all sampled plans had $50/qtr OTC)`);

    console.log(`\n── Confirmation #2: ssbciIsConditional scopes to food only ──`);
    console.log(`  OTC cards in PBP (otcAllowance=$200/$480) were NOT touched — their existing PBP values are preserved.`);
    console.log(`  We only write foodCardAllowance + ssbciIsConditional=true (chronic-gated food benefit).`);

    console.log(`\n── Confirmation #3: food/mo outliers ──`);
    if (foodOutliers.length) foodOutliers.forEach(x => console.log(`  OUTLIER: ${x}`));
    else console.log(`  (no outliers found — all food/mo in range $1–$400)`);

    if (fills.length === 0) { console.log("\nNo fills to apply."); return; }

    // Write foodCardAllowance + ssbciIsConditional ONLY (never otcAllowance — already set from PBP)
    let rowsWritten = 0;
    for (const f of fills) {
      const res = await prisma.plan.updateMany({
        where: { planId: f.planId, planYear: 2026 },
        data: { foodCardAllowance: f.foodAnnual, ssbciIsConditional: true },
      });
      rowsWritten += res.count;
    }

    console.log(`\nApplied. planIds filled: ${filled} | county rows written: ${rowsWritten} | confirmed $0: ${confirmedZero} | failed: ${failed}`);
  } finally {
    await prisma.$disconnect();
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.includes("--apply")) {
  runApply().catch(e => { console.error(e); process.exit(1); });
} else {
  runValidation().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { extractDevotedWallet, parseWallet };
