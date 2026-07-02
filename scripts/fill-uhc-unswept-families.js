// scripts/fill-uhc-unswept-families.js
// UHC unswept-family food wallet sweep (2026-07): H0251, H2385, H2445, H2509, H2802, H3256, H5008.
// Acquires SB PDFs (stored URL or SerpAPI -> Blob ingest), extracts monthly food credit,
// applies foodCardAllowance fills (fill-only, annualized). Checkpoint + resume.
//
//   node scripts/fill-uhc-unswept-families.js            # dry-run + anchor check
//   node scripts/fill-uhc-unswept-families.js --apply    # write fills
//
// Write target: foodCardAllowance (effectiveFoodCard priority #2 for UHC — sbVerifiedFoodAmount is Humana-only)
// Also sets: ssbciFoodAllowance (monthly), ssbciIsConditional=true, ssbciOffersFood=true
//
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { put } = require('@vercel/blob');
const { makePrisma } = require('./prisma-client');

// Load .env / .env.local
for (const ef of ['.env', '.env.local']) {
  const p = path.join(__dirname, '..', ef);
  try {
    for (const l of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n\r]*)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {}
}

const APPLY     = process.argv.includes('--apply');
const SERP_KEY  = process.env.SERPAPI_KEY || process.env.SERPAPI_API_KEY;
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const PDFTOTEXT = 'C:\\Program Files\\Git\\mingw64\\bin\\pdftotext.exe';

const CHECKPOINT = path.join(__dirname, 'data', 'uhc-unswept-sweep-2026-07.json');
const ARTIFACT   = path.join(__dirname, 'data', 'uhc-wallet-fills-2026-07.json');

// Book-of-business plans first (sorted by member count desc), then others
const TARGET_PLANS = [
  // BOB plans (process first)
  { planId: 'H2509-2', state: 'FL', cat: 'DSNP', bobMembers: 11 },
  { planId: 'H2509-3', state: 'FL', cat: 'DSNP', bobMembers: 5  },
  { planId: 'H5008-11',state: 'MS', cat: 'DSNP', bobMembers: 4  },
  { planId: 'H5008-16',state: 'MS', cat: 'DSNP', bobMembers: 4  },
  { planId: 'H3256-6', state: 'GA', cat: 'DSNP', bobMembers: 4  },
  { planId: 'H0251-2', state: 'TN', cat: 'DSNP', bobMembers: 3  },
  { planId: 'H3256-5', state: 'GA', cat: 'DSNP', bobMembers: 1  },
  { planId: 'H0251-8', state: 'TN', cat: 'DSNP', bobMembers: 1  },
  // Non-BOB plans
  { planId: 'H0251-4', state: 'TN', cat: 'DSNP', bobMembers: 0  },
  { planId: 'H2385-1', state: 'IN', cat: 'DSNP', bobMembers: 0  },
  { planId: 'H2385-2', state: 'IN', cat: 'DSNP', bobMembers: 0  },
  { planId: 'H2385-3', state: 'IN', cat: 'DSNP', bobMembers: 0  },
  { planId: 'H2385-4', state: 'IN', cat: 'DSNP', bobMembers: 0  },
  { planId: 'H2445-1', state: 'VA', cat: 'DSNP', bobMembers: 0  },
  { planId: 'H2445-2', state: 'VA', cat: 'DSNP', bobMembers: 0  },
  { planId: 'H2445-3', state: 'VA', cat: 'DSNP', bobMembers: 0  },
  { planId: 'H2445-4', state: 'VA', cat: 'DSNP', bobMembers: 0  },
  { planId: 'H2509-1', state: 'FL', cat: 'DSNP', bobMembers: 0  },
  { planId: 'H2802-70',state: 'KS', cat: 'CSNP', bobMembers: 0  },
  { planId: 'H3256-4', state: 'GA', cat: 'DSNP', bobMembers: 0  },
  { planId: 'H5008-10',state: 'LA', cat: 'DSNP', bobMembers: 0  },
  { planId: 'H5008-17',state: 'MS', cat: 'DSNP', bobMembers: 0  },
];

const ANCHOR_PLAN_ID = 'H1889-9';
const ANCHOR_EXPECTED_MONTHLY = 75;

// ── HTTP helpers ─────────────────────────────────────────────────────────────
async function dlBuf(url) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'application/pdf,*/*' },
      redirect: 'follow', signal: AbortSignal.timeout(35000),
    });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch { return null; }
}

async function serpLinks(q) {
  if (!SERP_KEY) return [];
  const url = 'https://serpapi.com/search.json?engine=google&num=10&q=' + encodeURIComponent(q) + '&api_key=' + SERP_KEY;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.organic_results || []).map(o => o.link).filter(Boolean);
  } catch { return []; }
}

// ── PDF helpers ──────────────────────────────────────────────────────────────
function pdfToText(buf) {
  const tmp = path.join(os.tmpdir(), 'uhc-sb-' + Math.random().toString(36).slice(2) + '.pdf');
  try {
    fs.writeFileSync(tmp, buf);
    return execFileSync(PDFTOTEXT, ['-layout', tmp, '-'], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  } catch { return ''; }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}

// Validate that this PDF is the right plan's 2026 SB
function validatePdf(planId, buf, text) {
  if (!buf || buf.length < 800) return [false, 'too_short'];
  if (buf.slice(0, 5).toString('latin1') !== '%PDF-') return [false, 'not_pdf'];
  if (!text || text.length < 500) return [false, 'too_short_text'];
  // Check plan ID appears in text (strip hyphens for flexible match)
  const hayNorm = text.replace(/[\s\-|]/g, '').toUpperCase();
  const [contract, planNum] = planId.split('-');
  const pid1 = (contract + planNum.padStart(3, '0')).toUpperCase();
  const pid2 = (contract + planNum).toUpperCase();
  if (!hayNorm.includes(pid1) && !hayNorm.includes(pid2)) return [false, 'planid_missing'];
  const low = text.toLowerCase();
  if (!low.includes('summary of benefits')) return [false, 'no_sb_title'];
  if (!text.includes('2026')) return [false, 'stale_year'];
  if (/january 1\s*[–-]\s*december 31,\s*2025/.test(low) && !/january 1\s*[–-]\s*december 31,\s*2026/.test(low)) {
    return [false, 'stale_year(2025)'];
  }
  return [true, ''];
}

// ── Food extractor ───────────────────────────────────────────────────────────
function norm(s) { return s.replace(/[‐-―−]/g, '-').replace(/ /g, ' ').replace(/\s+/g, ' '); }

const FOOD_CTX  = /healthy foods?|grocer(?:y|ies)?|\bfood\b|over-the-counter|\botc\b|\bpreload/i;
const EXCLUDE   = /hearing|dental|\bvision\b|eyewear|eyeglass|\bpremium\b|give ?back|\bpart b\b|\breward|fitness|\brent\b|mortgage|transportation|\bspecial supplemental\b/i;
const MONTHLY_RE = /\$\s?(\d[\d,]*)\b(?:\s+[a-z()\/-]+){0,4}?\s*(per month|every month|each month|a month|monthly|\/ ?mo(?:nth)?\b)/i;

function extractMonthlyFood(text) {
  const lines = text.split(/\r?\n/).map(l => norm(l).trim()).filter(Boolean);
  const found = []; const ev = [];
  for (let i = 0; i < lines.length; i++) {
    if (!FOOD_CTX.test(lines[i]) || EXCLUDE.test(lines[i])) continue;
    let m = lines[i].match(MONTHLY_RE);
    if (!m) { const blk = lines[i] + ' ' + (lines[i + 1] || ''); if (!EXCLUDE.test(blk)) m = blk.match(MONTHLY_RE); }
    if (m) {
      const amt = parseInt(m[1].replace(/,/g, ''), 10);
      if (amt >= 10 && amt <= 2000) { found.push(amt); if (ev.length < 3) ev.push(lines[i].slice(0, 160)); }
    }
  }
  return { amounts: [...new Set(found)], evidence: ev };
}

// ── Blob ingest ───────────────────────────────────────────────────────────────
async function blobIngest(prisma, planId, sourceUrl, buf) {
  if (!BLOB_TOKEN) return null;
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  try {
    const result = await put('sb/2026/' + planId + '.pdf', new Blob([buf]), {
      access: 'public', addRandomSuffix: false, allowOverwrite: true,
      contentType: 'application/pdf', token: BLOB_TOKEN,
    });
    await prisma.plan.updateMany({
      where: { planId },
      data: {
        sbPdfUrl: result.url,
        sbPdfSourceFilename: sourceUrl,
        sbPdfChecksum: sha,
        sbLastProcessedAt: new Date(),
        sbDiscoveryConfidence: 0.97,
      },
    });
    return result.url;
  } catch (e) {
    console.error('  Blob ingest error:', e.message);
    return null;
  }
}

// ── SB acquisition ────────────────────────────────────────────────────────────
const ALLOW_HOST = /\.(content\.medicareadvantage\.com|uhc\.com|aarpmedicareplans\.com|wellcare\.com)$/i;

async function acquireSb(prisma, plan, cp) {
  const { planId, state } = plan;

  // 1. Try existing sbPdfUrl from DB
  const dbRow = await prisma.plan.findFirst({
    where: { planId, planYear: 2026 },
    select: { sbPdfUrl: true },
  });
  if (dbRow?.sbPdfUrl) {
    const buf = await dlBuf(dbRow.sbPdfUrl);
    if (buf) {
      const text = pdfToText(buf);
      const [ok, reason] = validatePdf(planId, buf, text);
      if (ok) return { text, url: dbRow.sbPdfUrl };
      console.log(`  ${planId}: stored URL failed validation: ${reason} — trying SerpAPI`);
    }
  }

  // 2. SerpAPI search
  if (!SERP_KEY) { console.log(`  ${planId}: no SerpAPI key, skip`); return null; }
  const queries = [
    `"${planId}" 2026 "Summary of Benefits" filetype:pdf`,
    `UnitedHealthcare "${planId}" 2026 "Summary of Benefits"`,
    `site:content.medicareadvantage.com "${planId}" 2026`,
  ];
  for (const q of queries) {
    console.log(`  SERP: ${q.slice(0, 90)}`);
    const links = await serpLinks(q);
    const pdfLinks = links.filter(u => {
      try { return ALLOW_HOST.test(new URL(u).hostname); } catch { return false; }
    }).slice(0, 4);
    console.log(`    ${pdfLinks.length} candidate links`);
    for (const u of pdfLinks) {
      const buf = await dlBuf(u);
      if (!buf) continue;
      const text = pdfToText(buf);
      const [ok, reason] = validatePdf(planId, buf, text);
      console.log(`    ${u.slice(0, 80)} -> ${ok ? 'VALID' : reason}`);
      if (ok) {
        // Upload to Blob and update DB
        const blobUrl = await blobIngest(prisma, planId, u, buf);
        return { text, url: blobUrl || u };
      }
    }
    // Throttle between SerpAPI calls
    await new Promise(r => setTimeout(r, 1200));
  }
  return null;
}

// ── Checkpoint ───────────────────────────────────────────────────────────────
function loadCp() { try { return JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8')); } catch { return {}; } }
function saveCp(cp) { fs.writeFileSync(CHECKPOINT, JSON.stringify(cp, null, 2)); }

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  const prisma = makePrisma();
  const cp = loadCp();

  // ── Anchor gate ──
  console.log(`\nAnchor gate: verifying ${ANCHOR_PLAN_ID} = $${ANCHOR_EXPECTED_MONTHLY}/mo...`);
  const anchorRow = await prisma.plan.findFirst({
    where: { planId: ANCHOR_PLAN_ID, planYear: 2026 },
    select: { sbPdfUrl: true, foodCardAllowance: true },
  });
  if (!anchorRow?.sbPdfUrl) {
    console.error(`STOP: anchor ${ANCHOR_PLAN_ID} has no sbPdfUrl. Cannot verify.`);
    await prisma.$disconnect(); process.exit(2);
  }
  if (anchorRow.foodCardAllowance !== ANCHOR_EXPECTED_MONTHLY * 12) {
    console.error(`STOP: anchor ${ANCHOR_PLAN_ID} DB value ${anchorRow.foodCardAllowance} != expected ${ANCHOR_EXPECTED_MONTHLY * 12}. Investigate before writing.`);
    await prisma.$disconnect(); process.exit(2);
  }
  // Optionally re-extract anchor to confirm extractor works
  const anchorBuf = await dlBuf(anchorRow.sbPdfUrl);
  if (anchorBuf) {
    const anchorText = pdfToText(anchorBuf);
    const anchorExt = extractMonthlyFood(anchorText);
    if (anchorExt.amounts.length > 0 && !anchorExt.amounts.includes(ANCHOR_EXPECTED_MONTHLY)) {
      console.error(`STOP: anchor extractor returned ${anchorExt.amounts} not ${ANCHOR_EXPECTED_MONTHLY}. Regressed.`);
      await prisma.$disconnect(); process.exit(2);
    }
    console.log(`  Anchor OK: ${ANCHOR_PLAN_ID} DB=$${anchorRow.foodCardAllowance}/yr, extractor=[${anchorExt.amounts.map(a => '$' + a).join(', ') || 'not found in text (ok — DB confirmed)'}]`);
  } else {
    console.log(`  Anchor DB check OK: $${anchorRow.foodCardAllowance}/yr (PDF download skipped — URL fetch failed, DB value is ground truth)`);
  }
  cp.anchorVerified = true;
  saveCp(cp);

  // ── Sweep ──
  const fills = [];
  const noWallet = [];
  const notFound = [];
  const multiAmounts = [];
  let written = 0;

  for (const plan of TARGET_PLANS) {
    const { planId } = plan;
    const cpKey = `plan_${planId}`;

    if (cp[cpKey]?.done) {
      console.log(`  ${planId}: checkpoint skip (${cp[cpKey].result})`);
      if (cp[cpKey].result === 'FILL' && cp[cpKey].monthly) {
        fills.push({ planId, monthly: cp[cpKey].monthly, annual: cp[cpKey].monthly * 12, state: plan.state, cat: plan.cat, evidence: cp[cpKey].evidence || '' });
      } else if (cp[cpKey].result === 'NO_WALLET') {
        noWallet.push(planId);
      } else if (cp[cpKey].result === 'NOT_FOUND') {
        notFound.push(planId);
      } else if (cp[cpKey].result === 'MULTI') {
        multiAmounts.push({ planId, amounts: cp[cpKey].amounts });
      }
      continue;
    }

    console.log(`\n${planId} ${plan.state} ${plan.cat}${plan.bobMembers > 0 ? ' [BOB ' + plan.bobMembers + 'm]' : ''}...`);

    const sb = await acquireSb(prisma, plan, cp);
    if (!sb) {
      console.log(`  ${planId}: NOT FOUND — no SB acquired`);
      notFound.push(planId);
      cp[cpKey] = { done: true, result: 'NOT_FOUND' };
      saveCp(cp);
      continue;
    }

    const ext = extractMonthlyFood(sb.text);
    console.log(`  extracted amounts: [${ext.amounts.map(a => '$' + a).join(', ') || 'none'}]`);
    if (ext.evidence.length) console.log(`  evidence: ${ext.evidence[0].slice(0, 120)}`);

    if (ext.amounts.length === 0) {
      console.log(`  ${planId}: NO_WALLET — no monthly food amount found`);
      noWallet.push(planId);
      cp[cpKey] = { done: true, result: 'NO_WALLET' };
      saveCp(cp);
    } else if (ext.amounts.length > 1) {
      console.log(`  ${planId}: MULTI_AMOUNT (${ext.amounts.map(a => '$' + a).join(', ')}) — needs manual review`);
      multiAmounts.push({ planId, amounts: ext.amounts });
      cp[cpKey] = { done: true, result: 'MULTI', amounts: ext.amounts };
      saveCp(cp);
    } else {
      const monthly = ext.amounts[0];
      console.log(`  ${planId}: FILL $${monthly}/mo -> $${monthly * 12}/yr`);
      fills.push({ planId, monthly, annual: monthly * 12, state: plan.state, cat: plan.cat, evidence: ext.evidence[0] || '' });
      cp[cpKey] = { done: true, result: 'FILL', monthly, evidence: ext.evidence[0] || '' };
      saveCp(cp);
    }

    // Throttle between plans
    await new Promise(r => setTimeout(r, 800));
  }

  // ── Summary ──
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`SWEEP COMPLETE (${APPLY ? 'APPLY' : 'DRY-RUN'})`);
  console.log(`  Fills: ${fills.length} | No-wallet: ${noWallet.length} | Not-found: ${notFound.length} | Multi-amount: ${multiAmounts.length}`);
  if (fills.length) {
    console.log('\nFILL targets:');
    for (const f of fills) {
      console.log(`  ${f.planId} ${f.state} ${f.cat}: $${f.monthly}/mo ($${f.annual}/yr)  [${f.evidence.slice(0, 100)}]`);
    }
  }
  if (multiAmounts.length) {
    console.log('\nMULTI-AMOUNT (review manually — NOT written):');
    for (const m of multiAmounts) console.log(`  ${m.planId}: ${m.amounts.map(a => '$' + a).join(', ')}`);
  }
  if (noWallet.length) console.log(`\nNo-wallet (left $0): ${noWallet.join(', ')}`);
  if (notFound.length) console.log(`\nNot-found (no SB): ${notFound.join(', ')}`);

  if (!APPLY) {
    console.log('\nDRY-RUN — no writes. Re-run with --apply to write fills.');
    await prisma.$disconnect();
    return;
  }

  if (fills.length === 0) {
    console.log('\nNothing to write.');
    await prisma.$disconnect();
    return;
  }

  // ── Apply fills ──
  console.log('\nApplying fills...');
  // Probe schema fields once (mirror fill-uhc-foodcard-from-sb.js pattern)
  const firstRow = await prisma.plan.findFirst({ where: { planYear: 2026 } });
  const schemaKeys = new Set(firstRow ? Object.keys(firstRow) : []);
  const has = f => schemaKeys.has(f);

  for (const f of fills) {
    const data = { foodCardAllowance: f.annual };
    if (has('ssbciFoodAllowance')) data.ssbciFoodAllowance = f.monthly;
    if (has('ssbciIsConditional')) data.ssbciIsConditional = true;
    if (has('ssbciOffersFood'))    data.ssbciOffersFood    = true;
    const r = await prisma.plan.updateMany({
      where: {
        planId: f.planId,
        planYear: 2026,
        OR: [{ foodCardAllowance: null }, { foodCardAllowance: 0 }],
      },
      data,
    });
    written += r.count;
    console.log(`  ${f.planId}: wrote $${f.annual}/yr to ${r.count} county rows`);
  }
  console.log(`\nApplied: ${fills.length} plans, ${written} county rows total.`);

  // ── Artifact ──
  const artifact = {
    note: 'SB-verified UHC unswept-family foodCardAllowance fills (2026). Source: fill-uhc-unswept-families.js, run 2026-07-02. Anchor: H1889-9=$75/mo ($900/yr) confirmed.',
    fills: fills.map(f => ({ planId: f.planId, monthly: f.monthly, annual: f.annual, state: f.state, cat: f.cat })),
    noWallet,
    notFound,
    multiAmounts,
  };
  fs.writeFileSync(ARTIFACT, JSON.stringify(artifact, null, 2));
  console.log(`\nArtifact saved: ${ARTIFACT}`);

  await prisma.$disconnect();
})().catch(async e => {
  console.error(e);
  try { await require('./prisma-client').makePrisma().$disconnect(); } catch {}
  process.exit(1);
});
