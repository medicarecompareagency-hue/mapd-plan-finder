// scripts/residual-sb-apply.js
// B4 residual SB cleanup: ingest 21 directly-constructed SBs + apply fills.
//
// Sections:
//   A. Audit: flag any plan with a 2025-sourced sbPdfSourceFilename
//   B. Ingest + fill 21 Aetna/Devoted SBs found via direct URL construction:
//      - H8597-2/3: confirm $90/mo converting wallet → foodCardAllowance=1080 (SB-authoritative, ≠ otcAllowance)
//      - H3239-2/28, H5325-4/6/7: standard converting wallet → foodCardAllowance=otcAllowance
//      - H5325-3/5: OVERWRITE exception — 2025 SB superseded by 2026 SB; re-verify + overwrite if amount differs
//      - Devoted H8320/H7766/H7397: ingest only (extract-devoted-foodcard.js --apply runs after)
//   C. UHC/Wellcare: one targeted SerpAPI pass (site:content.medicareadvantage.com per contract family)
//      Ingest any found SBs → fill-uhc-foodcard-from-sb.js --apply runs after
//
// node scripts/residual-sb-apply.js          # dry-run
// node scripts/residual-sb-apply.js --apply  # write to DB + blob

const fs   = require("fs");
const os   = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { put } = require("@vercel/blob");
const { makePrisma } = require("./prisma-client");

// ─── env ────────────────────────────────────────────────────────────────────
for (const ef of [".env", ".env.local"]) {
  const p = path.join(__dirname, "..", ef);
  try {
    for (const l of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n\r]*)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {}
}

const APPLY      = process.argv.includes("--apply");
const PDFTOTEXT  = "C:\\Program Files\\Git\\mingw64\\bin\\pdftotext.exe";
const PROG       = path.join(__dirname, "..", "residual-sb-apply-progress.json");
const SERP_KEY   = process.env.SERPAPI_KEY || process.env.SERPAPI_API_KEY;
const done       = fs.existsSync(PROG) ? JSON.parse(fs.readFileSync(PROG, "utf8")) : {};
function save()  { fs.writeFileSync(PROG, JSON.stringify(done, null, 2)); }

// ─── HTTP ────────────────────────────────────────────────────────────────────
async function dlBuf(url) {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/pdf,*/*" },
      redirect: "follow", signal: AbortSignal.timeout(35000),
    });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch { return null; }
}

async function serpLinks(q) {
  if (!SERP_KEY) return [];
  const url = "https://serpapi.com/search.json?engine=google&num=10&q=" + encodeURIComponent(q) + "&api_key=" + SERP_KEY;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) return [];
    const j = await r.json();
    if (j.error) { console.error("  SerpAPI:", j.error); return []; }
    return (j.organic_results || []).map(o => o.link).filter(Boolean);
  } catch { return []; }
}

// ─── PDF ─────────────────────────────────────────────────────────────────────
function pdfToText(buf, pages = 25) {
  const tmp = path.join(os.tmpdir(), "rsa_" + Math.random().toString(36).slice(2) + ".pdf");
  try {
    fs.writeFileSync(tmp, buf);
    return execFileSync(PDFTOTEXT, ["-layout", "-f", "1", "-l", String(pages), tmp, "-"], {
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
  if (!txt || txt.length < 500) return ["BAD", "no_text"];
  const hay = txt.replace(/[\s\-|]/g, "").toUpperCase();
  if (!idVariants(planId).some(v => hay.includes(v.replace(/[\s\-|]/g, "").toUpperCase()))) return ["BAD", "planid_missing"];
  const low = txt.toLowerCase();
  if (!low.includes("summary of benefits")) return ["BAD", "no_sb_title"];
  if (!txt.includes("2026")) return ["BAD", "stale_year"];
  if (/january 1\s*[–-]\s*december 31,\s*2025/.test(low) && !/january 1\s*[–-]\s*december 31,\s*2026/.test(low))
    return ["BAD", "stale_2025"];
  return ["GOOD", ""];
}

// ─── Aetna food wallet detection ──────────────────────────────────────────────
// Detects converting-wallet language + extracts monthly $ amount.
// Returns { confirmed, monthlyExtracted, pattern, reason, snippet }
function detectFoodWallet(txt, planCategory, dbOtcAllowance) {
  const low  = txt.toLowerCase();
  const norm = txt.replace(/\s+/g, " ");
  if (!low.includes("extra supports wallet"))
    return { confirmed: false, monthlyExtracted: null, pattern: null, reason: "no_extra_supports_wallet" };
  if (!/healthy foods?|eligible food|\bfood\b/i.test(norm))
    return { confirmed: false, monthlyExtracted: null, pattern: null, reason: "no_food_language" };

  const converting = /(will change to|replace your otc|not get any additional funds|this will replace your otc wallet)/i.test(norm);
  const granted    = /(by qualifying for enrollment|get an extra supports wallet|qualifying.*get.*extra supports)/i.test(norm);
  const pattern    = converting ? "A" : (granted || planCategory === "CSNP") ? "B" : null;
  if (!pattern)
    return { confirmed: false, monthlyExtracted: null, pattern: null, reason: "no_pattern" };

  let monthlyExtracted = null;
  const idx = norm.toLowerCase().indexOf("extra supports wallet");
  if (idx >= 0) {
    const win = norm.slice(Math.max(0, idx - 50), idx + 600);
    const m   = win.match(/\$\s*(\d[\d,]*)\s*(?:monthly benefit amount|per month)/i);
    if (m) monthlyExtracted = parseInt(m[1].replace(/,/g, ""), 10);
  }

  // Amount match guard (skip for overrides — caller decides)
  if (monthlyExtracted !== null && dbOtcAllowance > 0) {
    const diff = Math.abs(monthlyExtracted - dbOtcAllowance / 12);
    if (diff > 2) {
      const snippet = norm.slice(Math.max(0, idx - 20), idx + 300).replace(/\s+/g, " ").trim();
      return { confirmed: false, monthlyExtracted, pattern,
               reason: `amount_mismatch SB=$${monthlyExtracted}/mo DB-otc=$${dbOtcAllowance}/yr`,
               snippet };
    }
  }

  const snippet = idx >= 0 ? norm.slice(Math.max(0, idx - 20), idx + 300).replace(/\s+/g, " ").trim() : "";
  return {
    confirmed: true, monthlyExtracted, pattern,
    reason: `${pattern}_confirmed $${monthlyExtracted}/mo`,
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
      { access: "public", addRandomSuffix: false, allowOverwrite: true, contentType: "application/pdf",
        token: process.env.BLOB_READ_WRITE_TOKEN }
    )).url;
  } catch (e) { console.error("  Blob upload error:", e.message); return null; }

  await prisma.plan.updateMany({
    where: { planId },
    data: { sbPdfUrl: blobUrl, sbPdfSourceFilename: sourceUrl, sbPdfChecksum: sha,
            sbLastProcessedAt: new Date(), sbDiscoveryConfidence: 0.97 },
  });
  return blobUrl;
}

// ─── Known SBs from B2 probes (all 21 confirmed GOOD) ────────────────────────

const AETNA_PLANS = [
  // Part A: H8597 — 2026 SBs confirm $70/$60/mo matching DB otcAllowance ($840/$720); standard fill.
  // (The $90/mo that blocked the original sweep came from 2025 SBs; 2026 amounts were updated.)
  { planId: "H8597-2", url: "https://content.medicareadvantage.com/2026/Aetna-Y0001-H8597-002-DS73-SB2026-M-SF20250923.pdf", kind: "AETNA_WALLET" },
  { planId: "H8597-3", url: "https://content.medicareadvantage.com/2026/Aetna-Y0001-H8597-003-DS74-SB2026-M-SF20250923.pdf", kind: "AETNA_WALLET" },
  // Standard converting wallet (foodCardAllowance=otcAllowance)
  { planId: "H3239-2",  url: "https://content.medicareadvantage.com/2026/Aetna-Y0001-H3239-002-DS36-SB2026-M-SF20250923.pdf", kind: "AETNA_WALLET" },
  { planId: "H3239-28", url: "https://content.medicareadvantage.com/2026/Aetna-Y0001-H3239-028-NV05-SB2026-M-SF20250923.pdf", kind: "AETNA_WALLET" },
  { planId: "H5325-4",  url: "https://content.medicareadvantage.com/2026/Aetna-Y0001-H5325-004-DS63-SB2026-M-SF20250923.pdf", kind: "AETNA_WALLET" },
  { planId: "H5325-6",  url: "https://content.medicareadvantage.com/2026/Aetna-Y0001-H5325-006-DS65-SB2026-M-SF20250923.pdf", kind: "AETNA_WALLET" },
  { planId: "H5325-7",  url: "https://content.medicareadvantage.com/2026/Aetna-Y0001-H5325-007-DS66-SB2026-M-SF20250923.pdf", kind: "AETNA_WALLET" },
  // OVERWRITE exception: currently filled from 2025 SBs; re-verify from 2026 SB and overwrite if amount differs
  { planId: "H5325-3",  url: "https://content.medicareadvantage.com/2026/Aetna-Y0001-H5325-003-DS62-SB2026-M-SF20250923.pdf", kind: "AETNA_OVERWRITE" },
  { planId: "H5325-5",  url: "https://content.medicareadvantage.com/2026/Aetna-Y0001-H5325-005-DS64-SB2026-M-SF20250923.pdf", kind: "AETNA_OVERWRITE" },
];

const DEVOTED_PLANS = [
  { planId: "H8320-11", url: "https://content.medicareadvantage.com/2026/2026-DEVOTED-C-SNP-CHOICE-PREMIUM-011-IL-PPO-C-SNP-SB-H8320-011-ENG-SF20250924.pdf" },
  { planId: "H8320-12", url: "https://content.medicareadvantage.com/2026/2026-DEVOTED-C-SNP-CHOICE-PLUS-012-IL-PPO-C-SNP-SB-H8320-012-ENG-SF20250924.pdf" },
  { planId: "H8320-13", url: "https://content.medicareadvantage.com/2026/2026-DEVOTED-C-SNP-CHOICE-PREMIUM-013-IL-PPO-C-SNP-SB-H8320-013-ENG-SF20250924.pdf" },
  { planId: "H7766-4",  url: "https://content.medicareadvantage.com/2026/2026-DEVOTED-DUAL-CHOICE-004-LA-PPO-D-SNP-SB-H7766-004-ENG-SF20250924.pdf" },
  { planId: "H7766-12", url: "https://content.medicareadvantage.com/2026/2026-DEVOTED-C-SNP-CHOICE-PREMIUM-012-LA-PPO-C-SNP-SB-H7766-012-ENG-SF20250924.pdf" },
  { planId: "H7766-13", url: "https://content.medicareadvantage.com/2026/2026-DEVOTED-C-SNP-CHOICE-PREMIUM-013-LA-PPO-C-SNP-SB-H7766-013-ENG-SF20250924.pdf" },
  { planId: "H7766-14", url: "https://content.medicareadvantage.com/2026/2026-DEVOTED-C-SNP-CHOICE-PLUS-014-LA-PPO-C-SNP-SB-H7766-014-ENG-SF20250924.pdf" },
  { planId: "H7397-3",  url: "https://content.medicareadvantage.com/2026/2026-DEVOTED-DUAL-CHOICE-PLUS-003-AR-PPO-D-SNP-SB-H7397-003-ENG-SF20250924.pdf" },
  { planId: "H7397-4",  url: "https://content.medicareadvantage.com/2026/2026-DEVOTED-DUAL-CHOICE-004-AR-PPO-D-SNP-SB-H7397-004-ENG-SF20250924.pdf" },
  { planId: "H7397-6",  url: "https://content.medicareadvantage.com/2026/2026-DEVOTED-C-SNP-CHOICE-006-AR-PPO-C-SNP-SB-H7397-006-ENG-SF20250924.pdf" },
  { planId: "H7397-7",  url: "https://content.medicareadvantage.com/2026/2026-DEVOTED-C-SNP-CHOICE-PREMIUM-007-AR-PPO-C-SNP-SB-H7397-007-ENG-SF20250924.pdf" },
  { planId: "H7397-10", url: "https://content.medicareadvantage.com/2026/2026-DEVOTED-C-SNP-CHOICE-PLUS-010-AR-PPO-C-SNP-SB-H7397-010-ENG-SF20250924.pdf" },
];

// UHC/Wellcare SerpAPI queries: one per contract family
const UHC_WC_QUERIES = [
  { contract: "H0169", label: "UHC H0169 MO DSNP" },
  { contract: "H5322", label: "UHC H5322 TX/OH DSNP" },
  { contract: "H0908", label: "Wellcare H0908 OH DSNP" },
  { contract: "H1664", label: "Wellcare H1664 MO DSNP" },
  { contract: "H6550", label: "Wellcare H6550 KS DSNP" },
];

const ALLOW_HOST = /(^|\.)(content\.medicareadvantage\.com|uhc\.com|wellcare\.com|wellcareok\.com|aetna\.com|aetnamedicare\.com)$/i;
function host(u) { try { return new URL(u).hostname; } catch { return ""; } }

// ─── MAIN ─────────────────────────────────────────────────────────────────────
(async () => {
  const prisma = makePrisma();
  console.log(`Residual SB apply — mode: ${APPLY ? "APPLY" : "DRY-RUN"}\n`);

  // ══ SECTION A: Audit 2025-sourced fills ════════════════════════════════════
  console.log("═".repeat(70));
  console.log("SECTION A — Plans carrying 2025-sourced SB amounts");
  console.log("═".repeat(70));

  const stale2025 = await prisma.plan.findMany({
    where: { planYear: 2026, sbPdfSourceFilename: { contains: "/2025/" } },
    select: { planId: true, organizationName: true, planCategory: true, state: true,
              foodCardAllowance: true, otcAllowance: true, sbPdfSourceFilename: true },
    distinct: ["planId"], orderBy: { planId: "asc" },
  });
  if (stale2025.length === 0) {
    console.log("  (none — no plans with /2025/ in sbPdfSourceFilename)");
  } else {
    console.log(`  ${stale2025.length} plans have 2025-sourced SBs:`);
    for (const p of stale2025) {
      console.log(`  ${p.planId.padEnd(14)} ${p.planCategory} ${p.state}  food=$${p.foodCardAllowance}  source=${p.sbPdfSourceFilename?.slice(-50)}`);
    }
  }

  // ══ SECTION B: Ingest Aetna SBs + apply fills ════════════════════════════
  console.log("\n" + "═".repeat(70));
  console.log("SECTION B1 — Aetna SBs: ingest + fill");
  console.log("═".repeat(70));

  const aetnaResults = { filled: [], overwritten: [], skipped: [], errors: [] };

  for (const plan of AETNA_PLANS) {
    const { planId, url, kind, foodOverride } = plan;
    const ck = done[planId];

    if (ck?.status === "DONE") {
      console.log(`  SKIP (done) ${planId} — ${ck.note}`);
      continue;
    }

    console.log(`\n  → ${planId} [${kind}]`);

    // Fetch DB state
    const dbPlan = await prisma.plan.findFirst({
      where: { planId, planYear: 2026 },
      select: { planId: true, planCategory: true, state: true, otcAllowance: true,
                foodCardAllowance: true, sbPdfUrl: true, sbPdfSourceFilename: true },
    });
    if (!dbPlan) { console.log(`    SKIP — not in DB`); continue; }

    const { planCategory, state, otcAllowance, foodCardAllowance } = dbPlan;
    console.log(`    DB: food=$${foodCardAllowance} otc=$${otcAllowance} cat=${planCategory} state=${state}`);

    // Download SB
    const buf = await dlBuf(url);
    if (!buf) { console.error(`    FAIL — could not download ${url}`); aetnaResults.errors.push(planId); continue; }
    const txt = pdfToText(buf);
    const [verdict, reason] = classifySB(planId, buf, txt);
    console.log(`    classify: ${verdict} ${reason}`);
    if (verdict !== "GOOD") { console.error(`    FAIL — SB classification: ${reason}`); aetnaResults.errors.push(planId); continue; }

    if (kind === "H8597_OVERRIDE") {
      // Confirm $90/mo converting-wallet language, then write 1080 regardless of otcAllowance
      const low  = txt.toLowerCase();
      const norm = txt.replace(/\s+/g, " ");
      const hasESW   = low.includes("extra supports wallet");
      const hasFood  = /healthy foods?|eligible food|\bfood\b/i.test(norm);
      const hasConv  = /(will change to|replace your otc|not get any additional funds)/i.test(norm);
      // Extract monthly amount to verify $90
      let mo = null;
      const idx = norm.toLowerCase().indexOf("extra supports wallet");
      if (idx >= 0) {
        const win = norm.slice(Math.max(0, idx - 50), idx + 600);
        const m   = win.match(/\$\s*(\d[\d,]*)\s*(?:monthly benefit amount|per month)/i);
        if (m) mo = parseInt(m[1].replace(/,/g, ""), 10);
      }
      console.log(`    H8597 check: ESW=${hasESW} food=${hasFood} converting=${hasConv} monthly=$${mo}`);
      if (!hasESW || !hasFood || !hasConv) {
        console.error(`    FAIL — expected converting-wallet food language not found`);
        aetnaResults.errors.push(planId);
        continue;
      }
      if (mo !== 90) {
        console.error(`    FAIL — expected $90/mo but found $${mo}/mo — check SB before applying`);
        aetnaResults.errors.push(planId);
        continue;
      }

      if (APPLY) {
        const blobUrl = await ingestSB(prisma, planId, url, buf);
        if (!blobUrl) { aetnaResults.errors.push(planId); continue; }
        await prisma.plan.updateMany({
          where: { planId, planYear: 2026 },
          data: { foodCardAllowance: foodOverride, ssbciIsConditional: true, foodCardMaxPeriod: "month" },
        });
        console.log(`    FILLED ${planId} → foodCardAllowance=$${foodOverride}/yr ($90/mo from SB, not otcAllowance=$${otcAllowance})`);
      } else {
        console.log(`    DRY-RUN ${planId}: would write foodCardAllowance=$${foodOverride}/yr ($90/mo confirmed)`);
      }
      done[planId] = { status: "DONE", note: `H8597 override $${foodOverride}` };
      aetnaResults.filled.push({ planId, state, kind, food: foodOverride });
      save();

    } else if (kind === "AETNA_WALLET") {
      // Standard converting wallet — foodCardAllowance=otcAllowance
      if (!otcAllowance || otcAllowance <= 0) {
        console.log(`    SKIP — otcAllowance=$0`);
        continue;
      }
      const detection = detectFoodWallet(txt, planCategory, otcAllowance);
      console.log(`    detect: confirmed=${detection.confirmed} reason=${detection.reason}`);
      if (!detection.confirmed) {
        console.error(`    FAIL — food wallet not confirmed: ${detection.reason}`);
        aetnaResults.errors.push(planId);
        continue;
      }

      const foodVal = otcAllowance;
      if (APPLY) {
        const blobUrl = await ingestSB(prisma, planId, url, buf);
        if (!blobUrl) { aetnaResults.errors.push(planId); continue; }
        // Fill-only: only write if still $0
        const res = await prisma.plan.updateMany({
          where: { planId, planYear: 2026, OR: [{ foodCardAllowance: 0 }, { foodCardAllowance: null }] },
          data: { foodCardAllowance: foodVal, ssbciIsConditional: true, foodCardMaxPeriod: "month" },
        });
        console.log(`    FILLED ${planId} → $${foodVal}/yr (${res.count} rows, pattern ${detection.pattern})`);
      } else {
        console.log(`    DRY-RUN ${planId}: would write foodCardAllowance=$${foodVal}/yr`);
      }
      done[planId] = { status: "DONE", note: `wallet $${foodVal}` };
      aetnaResults.filled.push({ planId, state, kind, food: foodVal });
      save();

    } else if (kind === "AETNA_OVERWRITE") {
      // H5325-3/5: extract 2026 amount and overwrite if different from current (2025-SB) value
      const current = foodCardAllowance || 0;
      // Extract monthly amount without amount-match guard
      const norm2 = txt.replace(/\s+/g, " ");
      const idx2  = norm2.toLowerCase().indexOf("extra supports wallet");
      let mo2 = null;
      if (idx2 >= 0) {
        const win = norm2.slice(Math.max(0, idx2 - 50), idx2 + 600);
        const m   = win.match(/\$\s*(\d[\d,]*)\s*(?:monthly benefit amount|per month)/i);
        if (m) mo2 = parseInt(m[1].replace(/,/g, ""), 10);
      }
      // Also confirm food language
      const hasESW  = norm2.toLowerCase().includes("extra supports wallet");
      const hasFood = /healthy foods?|eligible food|\bfood\b/i.test(norm2);
      console.log(`    overwrite check: ESW=${hasESW} food=${hasFood} 2026-monthly=$${mo2} current-food=$${current}/yr`);

      if (!hasESW || !hasFood || mo2 === null) {
        console.error(`    FAIL — could not confirm food wallet or extract monthly amount from 2026 SB`);
        aetnaResults.errors.push(planId);
        continue;
      }

      const new2026Annual = mo2 * 12;
      if (new2026Annual === current) {
        console.log(`    SAME ${planId}: 2026 SB matches current $${current}/yr — no overwrite needed; updating sbPdfUrl to 2026`);
        if (APPLY) await ingestSB(prisma, planId, url, buf); // still update sbPdfUrl to 2026
        done[planId] = { status: "DONE", note: `same amount $${current}` };
        aetnaResults.skipped.push({ planId, state, note: `same $${current}` });
      } else {
        console.log(`    OVERWRITE ${planId}: $${current}/yr → $${new2026Annual}/yr (2026 SB $${mo2}/mo)`);
        if (APPLY) {
          const blobUrl = await ingestSB(prisma, planId, url, buf);
          if (!blobUrl) { aetnaResults.errors.push(planId); continue; }
          // Scoped exception to fill-only: overwrite regardless of current value
          await prisma.plan.updateMany({
            where: { planId, planYear: 2026 },
            data: { foodCardAllowance: new2026Annual, ssbciIsConditional: true, foodCardMaxPeriod: "month" },
          });
        } else {
          console.log(`    DRY-RUN: would overwrite to $${new2026Annual}/yr`);
        }
        done[planId] = { status: "DONE", note: `overwrite $${current} → $${new2026Annual}` };
        aetnaResults.overwritten.push({ planId, state, from: current, to: new2026Annual });
      }
      save();
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  // ══ SECTION B2: Ingest Devoted SBs (fill handled by extract-devoted-foodcard.js) ════
  console.log("\n" + "═".repeat(70));
  console.log("SECTION B2 — Devoted SBs: ingest only (extract-devoted-foodcard.js --apply runs after)");
  console.log("═".repeat(70));

  const devotedIngested = [], devotedSkipped = [];
  for (const plan of DEVOTED_PLANS) {
    const { planId, url } = plan;
    const ck = done[planId];
    if (ck?.status === "DONE") {
      console.log(`  SKIP (done) ${planId}`);
      devotedSkipped.push(planId);
      continue;
    }

    console.log(`  → ${planId}`);
    const dbPlan = await prisma.plan.findFirst({
      where: { planId, planYear: 2026 },
      select: { planId: true, sbPdfUrl: true, foodCardAllowance: true },
    });
    if (dbPlan?.sbPdfUrl) {
      console.log(`    already has sbPdfUrl — skip ingest`);
      done[planId] = { status: "DONE", note: "already ingested" };
      devotedSkipped.push(planId);
      save();
      continue;
    }

    const buf = await dlBuf(url);
    if (!buf) { console.error(`    FAIL — download failed`); continue; }
    const txt = pdfToText(buf, 5);
    const [verdict, reason] = classifySB(planId, buf, txt);
    console.log(`    classify: ${verdict} ${reason}`);
    if (verdict !== "GOOD") { console.error(`    FAIL — ${reason}`); continue; }

    if (APPLY) {
      const blobUrl = await ingestSB(prisma, planId, url, buf);
      if (!blobUrl) { console.error(`    FAIL — blob upload failed`); continue; }
      console.log(`    INGESTED ${planId} → blob set (extract-devoted-foodcard.js --apply will fill)`);
    } else {
      console.log(`    DRY-RUN ${planId}: would ingest SB to blob`);
    }
    done[planId] = { status: "DONE", note: "ingested" };
    devotedIngested.push(planId);
    save();
    await new Promise(r => setTimeout(r, 800));
  }

  // ══ SECTION C: UHC/Wellcare one-pass SerpAPI ═════════════════════════════
  console.log("\n" + "═".repeat(70));
  console.log("SECTION C — UHC/Wellcare: targeted SerpAPI pass");
  console.log("═".repeat(70));

  if (!SERP_KEY) {
    console.log("  SERP_KEY not set — skipping");
  } else {
    // Get the actual plan IDs for each contract family
    const uhcWcPlans = await prisma.plan.findMany({
      where: {
        planYear: 2026,
        planId: { in: ["H0169","H5322","H0908","H1664","H6550"].flatMap(c =>
          Array.from({length:60}, (_,i) => `${c}-${i+1}`)
        )},
        OR: [{ foodCardAllowance: 0 }, { foodCardAllowance: null }],
        sbPdfUrl: null,
      },
      select: { planId: true, organizationName: true, planCategory: true, state: true,
                otcAllowance: true, ssbciIsConditional: true, ssbciOffersFood: true },
      distinct: ["planId"], orderBy: { planId: "asc" },
    });

    // Group by contract
    const byContract = {};
    for (const p of uhcWcPlans) {
      const c = p.planId.split("-")[0];
      if (!byContract[c]) byContract[c] = [];
      byContract[c].push(p);
    }

    console.log(`  Target: ${uhcWcPlans.length} plans across ${Object.keys(byContract).length} contract families`);
    for (const [c, ps] of Object.entries(byContract)) {
      console.log(`    ${c}: ${ps.length} plans — ${ps.map(p=>p.planId).join(", ")}`);
    }

    const uhcIngested = [];
    for (const { contract, label } of UHC_WC_QUERIES) {
      const familyPlans = byContract[contract] || [];
      if (familyPlans.length === 0) { console.log(`\n  ${contract} — no plans in target pool, skip`); continue; }

      const ck = done[`SERP_${contract}`];
      if (ck?.status === "DONE") {
        console.log(`\n  ${contract} — SKIP (checkpoint)`);
        continue;
      }

      console.log(`\n  ${label} (${familyPlans.length} plans):`);
      const q = `site:content.medicareadvantage.com "${contract}" 2026 "Summary of Benefits"`;
      console.log(`    query: ${q}`);
      const links = await serpLinks(q);
      console.log(`    SerpAPI hits: ${links.length}`);

      const pdfLinks = links.filter(u => /\.pdf($|\?)/i.test(u) && ALLOW_HOST.test(host(u)));
      const allLinks = links.filter(u => ALLOW_HOST.test(host(u)));
      const candidates = [...new Set([...pdfLinks, ...allLinks])].slice(0, 6);
      console.log(`    candidates: ${candidates.length}`);

      // Try each candidate against each plan in the family
      for (const u of candidates) {
        console.log(`    trying: ${u.slice(0, 100)}`);
        const buf = await dlBuf(u);
        if (!buf) { await new Promise(r => setTimeout(r, 500)); continue; }
        const txt = pdfToText(buf, 5);

        // Which plan in the family does this SB match?
        let matched = null;
        for (const fp of familyPlans) {
          const [v] = classifySB(fp.planId, buf, txt);
          if (v === "GOOD") { matched = fp; break; }
        }

        if (!matched) {
          console.log(`      no match in ${contract} family`);
          await new Promise(r => setTimeout(r, 500));
          continue;
        }

        console.log(`      MATCH ${matched.planId} (${matched.planCategory} ${matched.state})`);
        if (APPLY) {
          const blobUrl = await ingestSB(prisma, matched.planId, u, buf);
          if (!blobUrl) { console.error(`      FAIL — blob upload`); continue; }
          console.log(`      INGESTED ${matched.planId} → blob set (fill-uhc-foodcard-from-sb.js --apply will fill)`);
        } else {
          console.log(`      DRY-RUN: would ingest ${matched.planId}`);
        }
        uhcIngested.push({ planId: matched.planId, url: u });
        await new Promise(r => setTimeout(r, 1000));
      }

      done[`SERP_${contract}`] = { status: "DONE", found: uhcIngested.filter(x=>x.planId.startsWith(contract)).length };
      save();
      await new Promise(r => setTimeout(r, 3000));
    }

    if (uhcIngested.length > 0) {
      console.log(`\n  UHC/WC SBs ingested: ${uhcIngested.length}`);
      console.log("  → Run 'node scripts/fill-uhc-foodcard-from-sb.js --apply' to fill these plans");
    } else {
      console.log(`\n  UHC/WC: 0 SBs found — all plans left $0 (genuinely unposted)`);
    }
  }

  // ══ SUMMARY ════════════════════════════════════════════════════════════════
  console.log("\n" + "═".repeat(70));
  console.log(`RESIDUAL SB APPLY — ${APPLY ? "APPLIED" : "DRY-RUN"} SUMMARY`);
  console.log("═".repeat(70));

  console.log(`\n2025-sourced plans flagged: ${stale2025.length}`);
  for (const p of stale2025) console.log(`  ${p.planId} ${p.planCategory} ${p.state} food=$${p.foodCardAllowance}`);

  console.log(`\nAetna filled (new): ${aetnaResults.filled.length}`);
  for (const f of aetnaResults.filled) console.log(`  ${f.planId} ${f.state} [${f.kind}] food=$${f.food}/yr`);

  console.log(`\nAetna overwritten (H5325 2025→2026 fix): ${aetnaResults.overwritten.length}`);
  for (const f of aetnaResults.overwritten) console.log(`  ${f.planId} ${f.state}: $${f.from} → $${f.to}/yr`);

  if (aetnaResults.errors.length) {
    console.log(`\nErrors: ${aetnaResults.errors.join(", ")}`);
  }

  console.log(`\nDevoted SBs ingested: ${devotedIngested.length} (${devotedSkipped.length} already done)`);
  console.log("→ Run 'node scripts/extract-devoted-foodcard.js --apply' next to fill these plans");

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
