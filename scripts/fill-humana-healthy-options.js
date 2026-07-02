// scripts/fill-humana-healthy-options.js
// Humana Healthy Options wallet sweep — sets sbVerifiedFoodAmount for the
// 34 remaining Humana DSNP/CSNP plans where the extractor was not yet run.
//
// Prior session: sweep-converting-wallets.js + extract-sb-benefits.ts set
// sbVerifiedFoodAmount for 104/138 Humana DSNP/CSNP plans. These 34 remain
// (mostly H7617 family and VA/SC/IN/IL contracts without stored SBs).
//
// Write targets (fill-only, never overwrite non-zero):
//   sbVerifiedFoodAmount  = monthly × 12
//   sbVerifiedFoodPeriod  = 'month'
//   ssbciIsConditional    = true  (for ssbci_conditional or deep_gated gating)
//   ssbciOffersFood       = true  (for all plans with food confirmed)
//   (foodCardAllowance and otcAllowance left untouched — sbVerifiedFoodAmount
//    takes priority in effectiveFoodCard(); effectiveOtc() also reads
//    sbVerifiedFoodAmount for Humana combined-card plans)
//
// Usage:
//   node scripts/fill-humana-healthy-options.js          # dry-run
//   node scripts/fill-humana-healthy-options.js --apply  # write fills
//
// Checkpoint: scripts/data/humana-wallet-sweep-2026-07.json
// Anchor: H0028-32, expect $105/mo ($1260/yr) — already in DB, re-verified from SB.
//
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const { execFileSync } = require('child_process');
const { makePrisma } = require('./prisma-client');

const prisma = makePrisma();
const APPLY = process.argv.includes('--apply');
const CHECKPOINT = 'scripts/data/humana-wallet-sweep-2026-07.json';
const ANCHOR_PLAN_ID = 'H0028-32';
const ANCHOR_EXPECTED_MONTHLY = 105;
const TMP_DIR = path.join(os.tmpdir(), 'humana-wallet-sweep');
fs.mkdirSync(TMP_DIR, { recursive: true });

// SF date fallback list (Humana SB pattern)
const SF_DATES = ['20251001','20250928','20250924','20251008','20250930','20251002','20250922','20251015'];

function pad(n, len = 3) {
  return String(parseInt(n) || 0).padStart(len, '0');
}

function humanaUrl(planId, segId, sfDate) {
  const [contract, planNum] = planId.split('-');
  return `https://content.medicareadvantage.com/2026/Humana-${contract}${pad(planNum)}${pad(segId || '0')}SB26pdf-2026-SF${sfDate}.pdf`;
}

function downloadPdf(url, dest) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, { method: 'GET', timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { fs.writeFileSync(dest, Buffer.concat(chunks)); resolve(); });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function headOk(url) {
  return new Promise(resolve => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, { method: 'HEAD', timeout: 8000 }, res => resolve(res.statusCode === 200));
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function resolveSbUrl(plan) {
  // 1. Stored URL
  if (plan.sbPdfUrl) {
    const ok = await headOk(plan.sbPdfUrl);
    if (ok) return { url: plan.sbPdfUrl, source: 'stored' };
  }
  // 2. Deterministic pattern with date fallbacks
  const segId = plan.segmentId || '0';
  for (const date of SF_DATES) {
    const url = humanaUrl(plan.planId, segId, date);
    const ok = await headOk(url);
    if (ok) return { url, source: `pattern/${date}` };
    await new Promise(r => setTimeout(r, 250));
  }
  return { url: null, source: 'not_found' };
}

function runExtractor(pdfPath) {
  try {
    const out = execFileSync('python', ['scripts/extract-humana-healthy-options.py', pdfPath], {
      maxBuffer: 2 * 1024 * 1024,
      timeout: 60000,
    }).toString('utf8');
    return JSON.parse(out);
  } catch (e) {
    return { found: false, error: 'extractor_failed: ' + e.message.slice(0, 120) };
  }
}

function loadCheckpoint() {
  if (fs.existsSync(CHECKPOINT)) {
    try { return JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8')); } catch {}
  }
  return { anchorVerified: false, processed: {}, retryList: [] };
}

function saveCheckpoint(cp) {
  fs.writeFileSync(CHECKPOINT, JSON.stringify(cp, null, 2));
}

async function main() {
  console.log(`\n${'='.repeat(70)}`);
  console.log('HUMANA HEALTHY OPTIONS WALLET SWEEP');
  console.log(`Mode: ${APPLY ? 'APPLY (writes to Neon)' : 'DRY-RUN'}`);
  console.log('='.repeat(70));

  // Load checkpoint
  const cp = loadCheckpoint();
  console.log(`Checkpoint: ${Object.keys(cp.processed).length} plans already processed.`);

  // --- Step 1: Query target plans ---
  const targetRows = await prisma.$queryRaw`
    SELECT DISTINCT "planId", "organizationName", "planCategory", "state",
           "segmentId", "sbPdfUrl",
           "foodCardAllowance", "otcAllowance",
           "sbVerifiedFoodAmount", "sbVerifiedOtcAmount",
           "ssbciIsConditional", "ssbciOffersFood"
    FROM "Plan"
    WHERE "planYear" = 2026
      AND "organizationName" ILIKE '%Humana%'
      AND "planCategory" IN ('DSNP', 'CSNP')
      AND ("sbVerifiedFoodAmount" IS NULL OR "sbVerifiedFoodAmount" = 0)
    ORDER BY "planId", "segmentId"
  `;

  // Dedupe: one row per planId (take first segment)
  const seen = new Set();
  const targets = [];
  for (const r of targetRows) {
    if (!seen.has(r.planId)) { seen.add(r.planId); targets.push(r); }
  }
  console.log(`\nTarget plans (sbVerifiedFoodAmount=null/0): ${targets.length}`);

  // --- Step 2: Anchor gate (verify H0028-32 before any writes) ---
  if (!cp.anchorVerified) {
    console.log(`\n--- ANCHOR GATE: re-extracting ${ANCHOR_PLAN_ID} ---`);
    const anchorRow = await prisma.plan.findFirst({
      where: { planId: ANCHOR_PLAN_ID, planYear: 2026 },
      select: { planId: true, sbPdfUrl: true, segmentId: true, sbVerifiedFoodAmount: true },
    });
    if (!anchorRow) {
      console.error('ANCHOR PLAN NOT FOUND — aborting.');
      process.exit(1);
    }
    console.log(`  Current DB sbVerifiedFoodAmount: $${anchorRow.sbVerifiedFoodAmount}/yr`);

    const anchorSb = await resolveSbUrl(anchorRow);
    if (!anchorSb.url) {
      console.error(`  ANCHOR SB NOT FOUND — aborting.`);
      process.exit(1);
    }
    const anchorPdf = path.join(TMP_DIR, 'anchor.pdf');
    await downloadPdf(anchorSb.url, anchorPdf);
    const anchorResult = runExtractor(anchorPdf);
    console.log(`  Extractor result: monthly=$${anchorResult.monthly} gating=${anchorResult.gating}`);

    if (!anchorResult.found || anchorResult.monthly !== ANCHOR_EXPECTED_MONTHLY) {
      console.error(`  ANCHOR GATE FAILED: expected $${ANCHOR_EXPECTED_MONTHLY}/mo, got ${JSON.stringify(anchorResult)}`);
      console.error('  No writes will be applied. Fix the extractor before --apply.');
      process.exit(1);
    }
    cp.anchorVerified = true;
    saveCheckpoint(cp);
    console.log(`  ANCHOR GATE PASSED: $${anchorResult.monthly}/mo confirmed.\n`);
  } else {
    console.log(`  Anchor already verified (checkpoint). Proceeding.\n`);
  }

  // --- Step 3: Process each plan ---
  const fills = [];      // {planId, monthly, annual, gating, sbUrl}
  const deepGated = [];  // {planId, snippet} — SSBCI beyond plan eligibility
  const noSb = [];       // {planId} — SB not found
  const noAmount = [];   // {planId, snippet} — section found but no $ amount
  const errors = [];     // {planId, error}

  let done = 0;
  for (const p of targets) {
    if (cp.processed[p.planId]) {
      console.log(`  [skip] ${p.planId} (checkpointed: ${cp.processed[p.planId].status})`);
      // Restore from checkpoint
      const res = cp.processed[p.planId];
      if (res.status === 'WRITE') fills.push({ planId: p.planId, monthly: res.monthly, annual: res.annual, gating: res.gating, sbUrl: res.sbUrl });
      else if (res.status === 'DEEP_GATED') deepGated.push({ planId: p.planId, snippet: res.snippet || '' });
      else if (res.status === 'NO_SB') noSb.push({ planId: p.planId });
      else if (res.status === 'NO_AMOUNT') noAmount.push({ planId: p.planId, snippet: res.snippet || '', dollars: res.dollars || [] });
      else if (res.status === 'ERROR') errors.push({ planId: p.planId, error: res.error });
      continue;
    }

    done++;
    process.stdout.write(`  [${done}/${targets.length}] ${p.planId} (${p.planCategory} ${p.state}) ... `);

    // Resolve SB URL
    const sbInfo = await resolveSbUrl(p);
    if (!sbInfo.url) {
      process.stdout.write(`NO SB FOUND\n`);
      noSb.push({ planId: p.planId });
      cp.processed[p.planId] = { status: 'NO_SB' };
      saveCheckpoint(cp);
      continue;
    }

    // Download PDF
    const pdfDest = path.join(TMP_DIR, `${p.planId.replace('-', '_')}.pdf`);
    try {
      await downloadPdf(sbInfo.url, pdfDest);
    } catch (e) {
      process.stdout.write(`DOWNLOAD FAILED (${e.message})\n`);
      errors.push({ planId: p.planId, error: e.message });
      cp.processed[p.planId] = { status: 'ERROR', error: e.message };
      saveCheckpoint(cp);
      continue;
    }

    // Run Python extractor
    const result = runExtractor(pdfDest);

    if (!result.found && !result.monthly) {
      if (result.error) {
        process.stdout.write(`EXTRACTOR ERROR: ${result.error}\n`);
        errors.push({ planId: p.planId, error: result.error });
        cp.processed[p.planId] = { status: 'ERROR', error: result.error, sbUrl: sbInfo.url };
      } else {
        process.stdout.write(`SECTION NOT FOUND\n`);
        // Check if sbVerifiedOtcAmount is set (combined card already set, food side missed)
        if (p.sbVerifiedOtcAmount && p.sbVerifiedOtcAmount > 0) {
          const monthly = Math.round(p.sbVerifiedOtcAmount / 12);
          process.stdout.write(`  -> OTC side confirmed ($${p.sbVerifiedOtcAmount}/yr). Using sbVerifiedOtcAmount as food (combined card).\n`);
          fills.push({ planId: p.planId, monthly, annual: Math.round(p.sbVerifiedOtcAmount), gating: 'ssbci_conditional', sbUrl: sbInfo.url, source: 'otc_mirror' });
          cp.processed[p.planId] = { status: 'WRITE', monthly, annual: Math.round(p.sbVerifiedOtcAmount), gating: 'ssbci_conditional', sbUrl: sbInfo.url, source: 'otc_mirror' };
        } else {
          noSb.push({ planId: p.planId });
          cp.processed[p.planId] = { status: 'NO_SB', sbUrl: sbInfo.url };
        }
      }
      saveCheckpoint(cp);
      continue;
    }

    if (result.found && result.monthly === null) {
      process.stdout.write(`SECTION FOUND but no $ extracted (page ${result.page})\n`);
      noAmount.push({ planId: p.planId, snippet: result.snippet, dollars: result.dollars_nearby || [] });
      cp.processed[p.planId] = { status: 'NO_AMOUNT', snippet: result.snippet, dollars: result.dollars_nearby, sbUrl: sbInfo.url };
      saveCheckpoint(cp);
      continue;
    }

    if (result.gating === 'deep_gated') {
      process.stdout.write(`DEEP_GATED ($${result.monthly}/mo — beyond plan eligibility, SSBCI chips only)\n`);
      deepGated.push({ planId: p.planId, snippet: result.snippet, monthly: result.monthly });
      cp.processed[p.planId] = { status: 'DEEP_GATED', monthly: result.monthly, snippet: result.snippet, sbUrl: sbInfo.url };
      saveCheckpoint(cp);
      continue;
    }

    process.stdout.write(`$${result.monthly}/mo -> $${result.annual}/yr (${result.gating})\n`);
    fills.push({ planId: p.planId, monthly: result.monthly, annual: result.annual, gating: result.gating, sbUrl: sbInfo.url });
    cp.processed[p.planId] = { status: 'WRITE', monthly: result.monthly, annual: result.annual, gating: result.gating, sbUrl: sbInfo.url };
    saveCheckpoint(cp);

    // Throttle
    await new Promise(r => setTimeout(r, 500));
  }

  // --- Step 4: Summary ---
  console.log(`\n${'='.repeat(70)}`);
  console.log('SUMMARY');
  console.log('='.repeat(70));
  console.log(`Total target plans: ${targets.length}`);
  console.log(`WRITE (sbVerifiedFoodAmount to fill): ${fills.length}`);
  console.log(`DEEP_GATED (SSBCI chips, no food $): ${deepGated.length}`);
  console.log(`NO SB / not found: ${noSb.length}`);
  console.log(`SECTION FOUND but no $ extracted: ${noAmount.length}`);
  console.log(`ERRORS: ${errors.length}`);

  if (fills.length > 0) {
    console.log(`\nWRITE targets (eyeball amounts):`);
    for (const f of fills) {
      const src = f.source === 'otc_mirror' ? ' [OTC mirror]' : '';
      console.log(`  ${f.planId}  $${f.monthly}/mo -> $${f.annual}/yr  (${f.gating})${src}`);
    }
  }

  if (deepGated.length > 0) {
    console.log(`\nDEEP_GATED (will set ssbciIsConditional + ssbciOffersFood, no food $):`);
    for (const d of deepGated) {
      console.log(`  ${d.planId}  $${d.monthly}/mo  "${d.snippet?.slice(0, 80)}"`);
    }
  }

  if (noAmount.length > 0) {
    console.log(`\nNO_AMOUNT (section found but $ not extracted — manual review):`);
    for (const n of noAmount) {
      console.log(`  ${n.planId}  dollars nearby: ${n.dollars?.join(', ')}  snippet: "${n.snippet?.slice(0, 70)}"`);
    }
  }

  if (noSb.length > 0) {
    console.log(`\nNO_SB / retry list (2026 SB not found):`);
    for (const n of noSb) console.log(`  ${n.planId}`);
  }

  if (errors.length > 0) {
    console.log(`\nERRORS:`);
    for (const e of errors) console.log(`  ${e.planId}: ${e.error}`);
  }

  // Write audit record to JSON
  const auditData = {
    runDate: new Date().toISOString().slice(0, 10),
    mode: APPLY ? 'apply' : 'dry-run',
    totalTargets: targets.length,
    fills: fills.map(f => ({ ...f, sbUrl: undefined })), // omit URL for brevity
    deepGated: deepGated.map(d => ({ planId: d.planId, monthly: d.monthly })),
    noSb: noSb.map(n => n.planId),
    noAmount: noAmount.map(n => ({ planId: n.planId, dollars: n.dollars })),
    errors: errors.map(e => ({ planId: e.planId, error: e.error })),
  };
  fs.writeFileSync('scripts/data/humana-wallet-sweep-2026-07.json', JSON.stringify(auditData, null, 2));

  // --- Step 5: Apply ---
  if (!APPLY) {
    console.log(`\nDRY-RUN only. Checkpoint saved to ${CHECKPOINT}`);
    console.log('Re-run with --apply to write fills to Neon.');
    await prisma.$disconnect();
    return;
  }

  if (fills.length === 0) {
    console.log('\nNo fills to apply.');
    await prisma.$disconnect();
    return;
  }

  console.log(`\n--- APPLYING ${fills.length} fills ---`);
  let rowsWritten = 0;
  const results = [];

  for (const f of fills) {
    const data = {
      sbVerifiedFoodAmount: f.annual,
      sbVerifiedFoodPeriod: 'month',
      ssbciOffersFood: true,
      // Force conditional for all Humana Healthy Options plans — the SB asterisk
      // ("specific health conditions") is consistently present per the 07-02 sample
      // check deep probe, but falls outside the pdfplumber context window so the
      // extractor classifies it as all_members. The 104 already-filled Humana plans
      // all have ssbciIsConditional=true; maintain that convention here.
      ssbciIsConditional: true,
    };

    const res = await prisma.plan.updateMany({
      where: {
        planId: f.planId,
        planYear: 2026,
        OR: [{ sbVerifiedFoodAmount: null }, { sbVerifiedFoodAmount: 0 }],
      },
      data,
    });
    rowsWritten += res.count;
    results.push(`  ${f.planId}: $${f.monthly}/mo ($${f.annual}/yr) -> ${res.count} county rows`);
  }

  // For deep_gated: set SSBCI chips but no food $
  let deepRows = 0;
  for (const d of deepGated) {
    const res = await prisma.plan.updateMany({
      where: { planId: d.planId, planYear: 2026 },
      data: { ssbciIsConditional: true, ssbciOffersFood: true },
    });
    deepRows += res.count;
  }

  console.log(`\nFILLS APPLIED:`);
  for (const r of results) console.log(r);
  if (deepRows > 0) console.log(`Deep-gated chips: ${deepGated.length} plans, ${deepRows} county rows updated.`);
  console.log(`\nTotal county rows updated: ${rowsWritten + deepRows}`);
  console.log(`sbVerifiedFoodAmount fills: ${fills.length} plans, ${rowsWritten} rows`);

  await prisma.$disconnect();
}

main().catch(async e => {
  console.error('Fatal:', e);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
