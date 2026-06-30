// scripts/fill-aetna-dsnp-csnp-converting-wallet.js
// S4 sweep: Aetna DSNP/CSNP converting-wallet food fill (verify-first).
//
// For each plan with foodCardAllowance=$0 and an otcAllowance already set:
//   1. Find 2026 SB via SerpAPI (throttled, checkpointed)
//   2. Validate SB (plan ID, year, "Summary of Benefits")
//   3. Confirm food-eligibility language ("Extra Supports Wallet" + "healthy foods" + food-eligible pattern)
//   4. Verify monthly $ in SB ≈ otcAllowance / 12 (tolerance: ±2 for rounding)
//   5. Only then: upload SB to Blob, write sbPdfUrl to DB, write foodCardAllowance=otcAllowance +
//      ssbciIsConditional=true + foodCardMaxPeriod='month'
//
// Plans with no SB found → left $0, listed as residual.
// Plans whose SB shows OTC-only (no food language) → left $0, listed as OTC-only.
// NEVER writes otcAllowance or ssbciFoodAllowance.
//
// Run:
//   node scripts/fill-aetna-dsnp-csnp-converting-wallet.js           # dry-run + checkpoint
//   node scripts/fill-aetna-dsnp-csnp-converting-wallet.js --apply   # write to DB

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { put } = require("@vercel/blob");
const { makePrisma } = require("./prisma-client");

// Load env
for (const envFile of [".env", ".env.local"]) {
  const p = path.join(__dirname, "..", envFile);
  try {
    const c = fs.readFileSync(p, "utf8");
    for (const l of c.split(/\r?\n/)) {
      const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n\r]*)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {}
}

const KEY = process.env.SERPAPI_KEY || process.env.SERPAPI_API_KEY;
if (!KEY) { console.error("SERPAPI_KEY not set"); process.exit(1); }

const APPLY = process.argv.includes("--apply");

// Plans where the SB food amount differs from otcAllowance (PBP/food are different benefits).
// foodCardAllowance must be set to this amount, NOT otcAllowance.
// These plans are reprocessed from their already-ingested sbPdfUrl (no SerpAPI re-spend).
// H8597 2026 SBs show $70/$60/mo which equals otcAllowance/12 — amounts match.
// These entries exist so the script can re-apply from sbPdfUrl (bypassing SerpAPI + stale MISMATCH
// checkpoint) on a CMS re-import without spending quota.
const FOOD_AMOUNT_OVERRIDES = {
  "H8597-2": 840, // 2026 SB $70/mo × 12 = $840 = otcAllowance
  "H8597-3": 720, // 2026 SB $60/mo × 12 = $720 = otcAllowance
};
const PDFTOTEXT = "C:\\Program Files\\Git\\mingw64\\bin\\pdftotext.exe";
const PROG = "aetna-converting-wallet-progress.json";

// Allowed domains for SB PDFs (same as serpapi-sb-sweep.js)
const ALLOW = /(^|\.)(content\.medicareadvantage\.com|aetna\.com|aetnamedicare\.com|cms\.gov|medicare\.gov)$/i;
function host(u) { try { return new URL(u).hostname; } catch { return ""; } }

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function dlBuf(url) {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Accept": "application/pdf,*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(35000),
    });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch { return null; }
}

async function serpLinks(q) {
  const url = "https://serpapi.com/search.json?engine=google&num=10&q=" + encodeURIComponent(q) + "&api_key=" + KEY;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) { console.error("  SerpAPI HTTP", r.status); return []; }
    const j = await r.json();
    if (j.error) { console.error("  SerpAPI error:", j.error); return []; }
    return (j.organic_results || []).map(o => o.link).filter(Boolean);
  } catch (e) { console.error("  SerpAPI fetch:", e.message); return []; }
}

// ─── PDF helpers ──────────────────────────────────────────────────────────────

function pdfToText(buf) {
  const tmp = path.join(os.tmpdir(), "at_" + Math.random().toString(36).slice(2) + ".pdf");
  try {
    fs.writeFileSync(tmp, buf);
    return execFileSync(PDFTOTEXT, ["-layout", "-f", "1", "-l", "25", tmp, "-"], {
      maxBuffer: 30 * 1024 * 1024,
    }).toString("utf8");
  } catch { return ""; } finally { try { fs.unlinkSync(tmp); } catch {} }
}

function idVariants(planId) {
  const m = String(planId).match(/([A-Za-z]\d{4})\D*(\d{1,3})/);
  if (!m) return [String(planId).toUpperCase()];
  const c = m[1].toUpperCase(), p = String(parseInt(m[2], 10)), p3 = p.padStart(3, "0");
  return [c + "-" + p3, c + "-" + p, c + " " + p3, c + p3, c + "|" + p3];
}

function classifySB(planId, buf, txt) {
  if (!buf || buf.length < 800) return ["BAD", "too_short"];
  if (buf.slice(0, 5).toString("latin1") !== "%PDF-") return ["BAD", "not_pdf"];
  if (!txt || txt.length < 500) return ["BAD", "too_short_text"];
  const hay = txt.replace(/[\s\-|]/g, "").toUpperCase();
  if (!idVariants(planId).some(v => hay.includes(v.replace(/[\s\-|]/g, "").toUpperCase()))) return ["BAD", "planid_missing"];
  const low = txt.toLowerCase(), head = low.slice(0, 3000);
  if (/(commission|partnership plan|producer|enrollment (form|request|kit)|frequently asked|\bfaq\b)/.test(head) && !head.includes("summary of benefits"))
    return ["BAD", "wrong_doctype"];
  if (!low.includes("summary of benefits")) return ["BAD", "no_sb_title"];
  if (!txt.includes("2026")) return ["BAD", "stale_year"];
  if (/january 1\s*[–-]\s*december 31,\s*2025/.test(low) && !/january 1\s*[–-]\s*december 31,\s*2026/.test(low))
    return ["BAD", "stale_year(2025)"];
  return ["GOOD", ""];
}

// ─── Food wallet detector ─────────────────────────────────────────────────────

/**
 * Detect converting-wallet food language in SB text.
 *
 * Pattern A (DSNP): OTC Wallet converts to Extra Supports Wallet (same $, adds food/utilities).
 *   Key phrases: "Extra Supports Wallet" + "will change to" or "not get any additional funds"
 *   + "healthy foods" (food-eligible confirmed).
 *
 * Pattern B (CSNP H1206): Extra Supports Wallet granted on enrollment (includes food).
 *   Key phrases: "Extra Supports Wallet" + "you get" or "get an Extra Supports Wallet"
 *   + "healthy foods".
 *
 * Returns:
 *   { confirmed: boolean, pattern: 'A'|'B'|null, monthlyExtracted: number|null,
 *     reason: string, snippet: string }
 */
function detectFoodWallet(txt, planCategory, dbOtcAllowance) {
  const low = txt.toLowerCase();
  const norm = txt.replace(/\s+/g, " ");

  // Must have "Extra Supports Wallet" at all
  if (!low.includes("extra supports wallet")) {
    return { confirmed: false, pattern: null, monthlyExtracted: null, reason: "no_extra_supports_wallet", snippet: "" };
  }

  // Must mention food
  const hasFood = /healthy foods?|eligible food|\bfood\b/i.test(norm);
  if (!hasFood) {
    return { confirmed: false, pattern: null, monthlyExtracted: null, reason: "no_food_language", snippet: "" };
  }

  // Pattern A: converting (OTC → Extra Supports Wallet, same $, no additional funds)
  const converting = /(will change to|replace your otc|replace your over-the-counter|not get any additional funds|this will replace your otc wallet)/i.test(norm);

  // Pattern B: CSNP granted on enrollment
  const granted = /(by qualifying for enrollment|get an extra supports wallet|you get.*extra supports wallet|qualifying.*get.*extra supports wallet)/i.test(norm);

  let pattern = null;
  if (converting) pattern = "A";
  else if (granted || planCategory === "CSNP") pattern = "B";

  if (!pattern) {
    return { confirmed: false, pattern: null, monthlyExtracted: null, reason: "no_converting_or_granted_pattern", snippet: norm.slice(0, 200) };
  }

  // Extract monthly $ from Extra Supports Wallet section
  // Find the section and extract the $ amount
  let monthlyExtracted = null;
  const idx = norm.toLowerCase().indexOf("extra supports wallet");
  if (idx >= 0) {
    const win = norm.slice(Math.max(0, idx - 50), idx + 600);
    // Look for "$X monthly benefit amount" or "$X per month"
    const mMo = win.match(/\$\s*(\d[\d,]*)\s*(?:monthly benefit amount|per month)/i);
    if (mMo) monthlyExtracted = parseInt(mMo[1].replace(/,/g, ""), 10);
  }

  // Verify monthly amount matches dbOtcAllowance/12 (tolerance ±2 for rounding)
  let amountMatch = true;
  let amountNote = "";
  if (monthlyExtracted !== null && dbOtcAllowance > 0) {
    const expected = dbOtcAllowance / 12;
    const diff = Math.abs(monthlyExtracted - expected);
    if (diff > 2) {
      amountMatch = false;
      amountNote = ` (SB $${monthlyExtracted}/mo × 12 = $${monthlyExtracted * 12} ≠ DB otc $${dbOtcAllowance})`;
    }
  }

  const snippetIdx = norm.toLowerCase().indexOf("extra supports wallet");
  const snippet = norm.slice(Math.max(0, snippetIdx - 20), snippetIdx + 300).replace(/\s+/g, " ").trim();

  if (!amountMatch) {
    return { confirmed: false, pattern, monthlyExtracted, reason: "amount_mismatch" + amountNote, snippet };
  }

  return {
    confirmed: true,
    pattern,
    monthlyExtracted,
    reason: `pattern_${pattern}_confirmed` + (monthlyExtracted ? ` $${monthlyExtracted}/mo × 12 = $${monthlyExtracted * 12}/yr` : ""),
    snippet,
  };
}

// ─── Blob / DB ingest ─────────────────────────────────────────────────────────

async function ingestSB(prisma, planId, sourceUrl, buf) {
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  let blobUrl;
  try {
    blobUrl = (await put(
      "sb/2026/" + planId + ".pdf",
      new Blob([buf]),
      { access: "public", addRandomSuffix: false, allowOverwrite: true, contentType: "application/pdf", token: process.env.BLOB_READ_WRITE_TOKEN }
    )).url;
  } catch (e) {
    console.error("  Blob upload error:", e.message);
    return null;
  }
  await prisma.plan.updateMany({
    where: { planId },
    data: { sbPdfUrl: blobUrl, sbPdfSourceFilename: sourceUrl, sbPdfChecksum: sha, sbLastProcessedAt: new Date(), sbDiscoveryConfidence: 0.97 },
  });
  return blobUrl;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  const prisma = makePrisma();
  const done = fs.existsSync(PROG) ? JSON.parse(fs.readFileSync(PROG, "utf8")) : {};

  const plans = await prisma.plan.findMany({
    where: {
      planYear: 2026,
      planCategory: { in: ["DSNP", "CSNP"] },
      organizationName: { contains: "Aetna", mode: "insensitive" },
      OR: [{ foodCardAllowance: 0 }, { foodCardAllowance: null }],
      otcAllowance: { gt: 0 },
    },
    select: { planId: true, planCategory: true, state: true, otcAllowance: true,
              foodCardAllowance: true, ssbciFoodAllowance: true, organizationName: true },
    distinct: ["planId"],
    orderBy: { planId: "asc" },
  });

  console.log(`Aetna DSNP/CSNP with food=$0 and otcAllowance>0: ${plans.length} plans`);
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY-RUN (--apply to write)"}`);
  console.log(`Checkpoint: ${Object.keys(done).filter(k => done[k].status === "GOOD").length} already done\n`);

  const results = { filled: [], otcOnly: [], missedSB: [], amountMismatch: [], parseError: [] };

  for (const plan of plans) {
    const { planId, planCategory, state, otcAllowance } = plan;
    if (done[planId]?.status === "GOOD") {
      console.log(`  SKIP (checkpoint) ${planId}`);
      results.filled.push({ planId, state, planCategory, otcAllowance, note: "from_checkpoint" });
      continue;
    }

    console.log(`\n  → ${planId} (${planCategory} ${state}) otc=$${otcAllowance}/yr`);

    // OVERRIDE PATH: plans where foodCardAllowance ≠ otcAllowance (SB is authoritative)
    if (FOOD_AMOUNT_OVERRIDES[planId] !== undefined) {
      const overrideAmt = FOOD_AMOUNT_OVERRIDES[planId];
      // Reload from DB to get sbPdfUrl (not in the initial query)
      const dbFull = await prisma.plan.findFirst({ where: { planId, planYear: 2026 }, select: { sbPdfUrl: true } });
      if (!dbFull?.sbPdfUrl) {
        console.log(`  OVERRIDE ${planId}: sbPdfUrl not yet set — run residual-sb-apply.js first`);
        done[planId] = { status: "NEEDS_INGEST" };
        fs.writeFileSync(PROG, JSON.stringify(done));
        continue;
      }
      console.log(`  OVERRIDE ${planId}: using on-file SB, foodCardAllowance=${overrideAmt}`);
      if (APPLY) {
        const buf = await dlBuf(dbFull.sbPdfUrl);
        if (!buf) { console.error(`  FAIL — could not re-fetch blob ${dbFull.sbPdfUrl}`); continue; }
        const txt = pdfToText(buf);
        const low = txt.toLowerCase(), norm = txt.replace(/\s+/g, " ");
        const ok = low.includes("extra supports wallet") && /healthy foods?|eligible food|\bfood\b/i.test(norm)
                   && /(will change to|not get any additional funds)/i.test(norm);
        if (!ok) { console.error(`  FAIL — converting-wallet food language not found in blob SB`); continue; }
        await prisma.plan.updateMany({
          where: { planId, planYear: 2026, OR: [{ foodCardAllowance: 0 }, { foodCardAllowance: null }] },
          data: { foodCardAllowance: overrideAmt, ssbciIsConditional: true, foodCardMaxPeriod: "month" },
        });
        console.log(`  FILLED ${planId} override $${overrideAmt}/yr`);
      } else {
        console.log(`  DRY-RUN ${planId}: would write foodCardAllowance=$${overrideAmt}/yr`);
      }
      done[planId] = { status: "GOOD", foodAllowance: overrideAmt, monthly: overrideAmt / 12 };
      results.filled.push({ planId, state, planCategory, otcAllowance, foodAllowance: overrideAmt, monthly: overrideAmt / 12, pattern: "A" });
      fs.writeFileSync(PROG, JSON.stringify(done));
      continue;
    }

    // SerpAPI: try 2 queries
    const queries = [
      `"${planId}" 2026 "Summary of Benefits" filetype:pdf`,
      `Aetna "${planId}" 2026 "Summary of Benefits"`,
    ];
    let foundUrl = null, foundBuf = null, foundTxt = null;

    for (const q of queries) {
      if (foundUrl) break;
      console.log(`  SERP: ${q}`);
      const links = await serpLinks(q);
      const pdfLinks = links.filter(u => /\.pdf($|\?)/i.test(u) && ALLOW.test(host(u))).slice(0, 4);
      // Also try non-PDF links from allowed domains (some SBs served without .pdf ext)
      const allowedLinks = links.filter(u => ALLOW.test(host(u)) && !pdfLinks.includes(u)).slice(0, 2);
      const candidates = [...pdfLinks, ...allowedLinks];
      console.log(`    hits: ${candidates.length}`);

      for (const u of candidates) {
        const buf = await dlBuf(u);
        if (!buf) continue;
        const txt = pdfToText(buf);
        const [verdict, reason] = classifySB(planId, buf, txt);
        console.log(`    ${u.slice(0, 80)} → ${verdict} ${reason}`);
        if (verdict === "GOOD") { foundUrl = u; foundBuf = buf; foundTxt = txt; break; }
      }
      if (!foundUrl) await new Promise(r => setTimeout(r, 1500)); // throttle between queries
    }

    if (!foundUrl) {
      console.log(`  MISS ${planId} — no valid SB found, leaving $0`);
      done[planId] = { status: "MISS" };
      results.missedSB.push({ planId, state, planCategory, otcAllowance });
      fs.writeFileSync(PROG, JSON.stringify(done));
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }

    // Detect food-eligible wallet language
    const detection = detectFoodWallet(foundTxt, planCategory, otcAllowance);
    console.log(`  Food detect: confirmed=${detection.confirmed} pattern=${detection.pattern} monthly=$${detection.monthlyExtracted} reason=${detection.reason}`);

    if (!detection.confirmed) {
      if (detection.reason === "no_food_language" || detection.reason === "no_converting_or_granted_pattern") {
        console.log(`  OTC-ONLY ${planId} — SB found but no food-eligible wallet, leaving $0`);
        results.otcOnly.push({ planId, state, planCategory, otcAllowance, reason: detection.reason, snippet: detection.snippet });
        done[planId] = { status: "OTC_ONLY" };
      } else if (detection.reason.startsWith("amount_mismatch")) {
        console.log(`  MISMATCH ${planId} — ${detection.reason}`);
        results.amountMismatch.push({ planId, state, planCategory, otcAllowance, reason: detection.reason });
        done[planId] = { status: "MISMATCH", reason: detection.reason };
      } else {
        console.log(`  SKIP ${planId} — ${detection.reason}`);
        done[planId] = { status: "SKIP", reason: detection.reason };
      }
      fs.writeFileSync(PROG, JSON.stringify(done));
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }

    // Confirmed — ingest SB + apply fill
    const foodAllowance = otcAllowance; // converting wallet: full OTC amount becomes food-eligible
    const monthlyForLog = detection.monthlyExtracted || Math.round(otcAllowance / 12);

    if (APPLY) {
      // 1. Upload SB to Blob + write sbPdfUrl to DB
      const blobUrl = await ingestSB(prisma, planId, foundUrl, foundBuf);
      if (!blobUrl) {
        console.log(`  ERROR ${planId} — blob upload failed`);
        results.parseError.push({ planId, state, reason: "blob_upload_failed" });
        done[planId] = { status: "BLOB_FAIL" };
        fs.writeFileSync(PROG, JSON.stringify(done));
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      // 2. Write food fill (fill-only: only if still $0)
      await prisma.plan.updateMany({
        where: { planId, planYear: 2026, OR: [{ foodCardAllowance: 0 }, { foodCardAllowance: null }] },
        data: { foodCardAllowance: foodAllowance, ssbciIsConditional: true, foodCardMaxPeriod: "month" },
      });
      console.log(`  FILLED ${planId} ${state} ${planCategory}: $0 → $${foodAllowance}/yr (food $${monthlyForLog}/mo | pattern ${detection.pattern})`);
    } else {
      console.log(`  DRY-RUN ${planId} ${state} ${planCategory}: would write foodCardAllowance=$${foodAllowance}/yr (food $${monthlyForLog}/mo | pattern ${detection.pattern})`);
    }

    done[planId] = { status: "GOOD", foodAllowance, monthly: monthlyForLog };
    results.filled.push({ planId, state, planCategory, otcAllowance, foodAllowance, monthly: monthlyForLog, pattern: detection.pattern });
    fs.writeFileSync(PROG, JSON.stringify(done));
    await new Promise(r => setTimeout(r, 2500)); // throttle between plans
  }

  // ─── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(70)}`);
  console.log(`AETNA CONVERTING-WALLET SWEEP SUMMARY (${APPLY ? "APPLIED" : "DRY-RUN"})`);
  console.log(`${"═".repeat(70)}`);
  console.log(`SB-verified fills:    ${results.filled.length}`);
  console.log(`SB not found ($0):    ${results.missedSB.length}`);
  console.log(`OTC-only / no food:   ${results.otcOnly.length}`);
  console.log(`Amount mismatch:      ${results.amountMismatch.length}`);
  console.log(`Other errors:         ${results.parseError.length}`);

  if (results.filled.length) {
    console.log(`\nFilled plans:`);
    for (const f of results.filled) {
      console.log(`  ${f.planId.padEnd(14)} ${f.planCategory} ${f.state}  $0 → $${f.foodAllowance}/yr ($${f.monthly}/mo, pattern ${f.pattern})`);
    }
  }
  if (results.missedSB.length) {
    console.log(`\nResidual (SB not found — left $0):`);
    for (const f of results.missedSB) console.log(`  ${f.planId.padEnd(14)} ${f.planCategory} ${f.state}  otc=$${f.otcAllowance}`);
  }
  if (results.otcOnly.length) {
    console.log(`\nOTC-only (SB found but no food conversion):`);
    for (const f of results.otcOnly) console.log(`  ${f.planId.padEnd(14)} ${f.planCategory} ${f.state}  reason=${f.reason}`);
  }
  if (results.amountMismatch.length) {
    console.log(`\nAmount mismatches (NOT filled):`);
    for (const f of results.amountMismatch) console.log(`  ${f.planId.padEnd(14)} ${f.planCategory} ${f.state}  ${f.reason}`);
  }

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
