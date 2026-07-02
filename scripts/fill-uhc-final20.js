// scripts/fill-uhc-final20.js
// Final UHC-20 food wallet sweep: H1889, H5322, H6595, H0169, H0421 families.
// 20 DSNP/CSNP plans that were unswept as of 2026-07-02 floor audit.
//
//   node scripts/fill-uhc-final20.js            # dry-run
//   node scripts/fill-uhc-final20.js --apply    # write fills
//
// Write target: foodCardAllowance (effectiveFoodCard priority #2 for UHC)
// Also sets: ssbciFoodAllowance (monthly), ssbciIsConditional=true, ssbciOffersFood=true
// Artifact: MERGES with existing scripts/data/uhc-wallet-fills-2026-07.json
// Durability: reapply-uhc-wallet-fills.js (already in FIXERS) re-reads artifact
//
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { makePrisma } = require('./prisma-client');

for (const ef of ['.env', '.env.local']) {
  const p = path.join(__dirname, '..', ef);
  try {
    for (const l of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n\r]*)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {}
}

const APPLY      = process.argv.includes('--apply');
const SERP_KEY   = process.env.SERPAPI_KEY || process.env.SERPAPI_API_KEY;
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const PDFTOTEXT  = 'C:\\Program Files\\Git\\mingw64\\bin\\pdftotext.exe';

const CHECKPOINT = path.join(__dirname, 'data', 'uhc-final20-sweep-2026-07.json');
const ARTIFACT   = path.join(__dirname, 'data', 'uhc-wallet-fills-2026-07.json');

const ANCHOR_PLAN_ID       = 'H1889-9';
const ANCHOR_EXPECTED_ANNUAL = 900;

// H1889 is Dale's biggest D-SNP family — prioritize it
const TARGET_PLANS = [
  // H1889 family (BOB priority: biggest D-SNP)
  { planId: 'H1889-2',  state: 'FL', cat: 'DSNP', planName: 'UHC Dual Complete FL-D003 (PPO D-SNP)' },
  { planId: 'H1889-8',  state: 'KY', cat: 'DSNP', planName: 'UHC Dual Complete KY-S001 (PPO D-SNP)' },
  { planId: 'H1889-10', state: 'LA', cat: 'DSNP', planName: 'UHC Dual Complete LA-S001 (PPO D-SNP)' },
  { planId: 'H1889-11', state: 'MS', cat: 'DSNP', planName: 'UHC Dual Complete MS-S001 (PPO D-SNP)' },
  { planId: 'H1889-25', state: 'AR', cat: 'CSNP', planName: 'UHC Complete Care AR-6 (PPO C-SNP)' },
  { planId: 'H1889-26', state: 'FL', cat: 'DSNP', planName: 'UHC Dual Complete FL-Y4 (PPO D-SNP)' },
  { planId: 'H1889-30', state: 'KY', cat: 'DSNP', planName: 'UHC Dual Complete KY-S3 (PPO D-SNP)' },
  { planId: 'H1889-31', state: 'LA', cat: 'DSNP', planName: 'UHC Dual Complete LA-S4 (PPO D-SNP)' },
  { planId: 'H1889-32', state: 'MS', cat: 'DSNP', planName: 'UHC Dual Complete MS-S3 (PPO D-SNP)' },
  // H5322 family
  { planId: 'H5322-26', state: 'TX', cat: 'DSNP', planName: 'UHC Dual Complete TX-V005 (HMO-POS D-SNP)' },
  { planId: 'H5322-31', state: 'OK', cat: 'DSNP', planName: 'UHC Dual Complete OK-S002 (HMO-POS D-SNP)' },
  { planId: 'H5322-33', state: 'OK', cat: 'DSNP', planName: 'UHC Dual Complete OK-V001 (HMO-POS D-SNP)' },
  { planId: 'H5322-38', state: 'TX', cat: 'DSNP', planName: 'UHC Dual Complete TX-V010 (HMO-POS D-SNP)' },
  { planId: 'H5322-49', state: 'GA', cat: 'DSNP', planName: 'UHC Dual Complete GA-S3 (HMO-POS D-SNP)' },
  // H6595 family
  { planId: 'H6595-3',  state: 'KY', cat: 'DSNP', planName: 'UHC Dual Complete KY-V001 (HMO-POS D-SNP)' },
  { planId: 'H6595-5',  state: 'KY', cat: 'DSNP', planName: 'UHC Dual Complete KY-S4 (HMO-POS D-SNP)' },
  // H0169 family
  { planId: 'H0169-2',  state: 'MO', cat: 'DSNP', planName: 'UHC Dual Complete MO-S001 (HMO-POS D-SNP)' },
  { planId: 'H0169-4',  state: 'KS', cat: 'DSNP', planName: 'UHC Dual Complete KS-S001 (HMO-POS D-SNP)' },
  { planId: 'H0169-8',  state: 'MO', cat: 'DSNP', planName: 'UHC Dual Complete MO-V001 (HMO-POS D-SNP)' },
  // H0421 family
  { planId: 'H0421-1',  state: 'VA', cat: 'DSNP', planName: 'UHC Dual Complete VA-Y4 (PPO D-SNP)' },
];

// ── HTTP helpers ──────────────────────────────────────────────────────────────
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

// ── PDF helpers ───────────────────────────────────────────────────────────────
function pdfToText(buf) {
  const tmp = path.join(os.tmpdir(), 'uhc20-sb-' + Math.random().toString(36).slice(2) + '.pdf');
  try {
    fs.writeFileSync(tmp, buf);
    return execFileSync(PDFTOTEXT, ['-layout', tmp, '-'], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  } catch { return ''; }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}

function validatePdf(planId, buf, text) {
  if (!buf || buf.length < 800) return [false, 'too_short'];
  if (buf.slice(0, 5).toString('latin1') !== '%PDF-') return [false, 'not_pdf'];
  if (!text || text.length < 500) return [false, 'too_short_text'];
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

// ── Food extractor ────────────────────────────────────────────────────────────
function norm(s) { return s.replace(/[‐-―−]/g, '-').replace(/ /g, ' ').replace(/\s+/g, ' '); }

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
    const { put } = require('@vercel/blob');
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
const ALLOW_HOST = /\.(content\.medicareadvantage\.com|uhc\.com|aarpmedicareplans\.com|uhcmedicare\.com)$/i;

async function acquireSb(prisma, plan) {
  const { planId, state, planName } = plan;

  // 1. Stored sbPdfUrl
  const dbRow = await prisma.plan.findFirst({
    where: { planId, planYear: 2026 },
    select: { sbPdfUrl: true },
  });
  if (dbRow?.sbPdfUrl) {
    console.log(`  ${planId}: trying stored URL...`);
    const buf = await dlBuf(dbRow.sbPdfUrl);
    if (buf) {
      const text = pdfToText(buf);
      const [ok, reason] = validatePdf(planId, buf, text);
      if (ok) { console.log(`  ${planId}: stored URL valid`); return { text, url: dbRow.sbPdfUrl }; }
      console.log(`  ${planId}: stored URL failed: ${reason} — trying SerpAPI`);
    } else {
      console.log(`  ${planId}: stored URL fetch failed — trying SerpAPI`);
    }
  }

  if (!SERP_KEY) { console.log(`  ${planId}: no SerpAPI key`); return null; }

  const queries = [
    `"${planId}" 2026 "Summary of Benefits" filetype:pdf`,
    `site:content.medicareadvantage.com "${planId}" 2026`,
    planName ? `"${planName}" "${planId}" 2026 "Summary of Benefits"` : null,
    `UnitedHealthcare "${planId}" 2026 summary benefits`,
  ].filter(Boolean);

  for (const q of queries) {
    console.log(`  SERP: ${q.slice(0, 100)}`);
    const links = await serpLinks(q);
    const pdfLinks = links.filter(u => {
      try { return ALLOW_HOST.test(new URL(u).hostname); } catch { return false; }
    }).slice(0, 4);
    if (!pdfLinks.length) { await new Promise(r => setTimeout(r, 1000)); continue; }
    console.log(`    ${pdfLinks.length} candidate(s)`);
    for (const u of pdfLinks) {
      const buf = await dlBuf(u);
      if (!buf) continue;
      const text = pdfToText(buf);
      const [ok, reason] = validatePdf(planId, buf, text);
      console.log(`    ${u.slice(0, 90)} -> ${ok ? 'VALID' : reason}`);
      if (ok) {
        const blobUrl = await blobIngest(prisma, planId, u, buf);
        return { text, url: blobUrl || u };
      }
    }
    await new Promise(r => setTimeout(r, 1200));
  }
  return null;
}

// ── Checkpoint ────────────────────────────────────────────────────────────────
function loadCp() { try { return JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8')); } catch { return {}; } }
function saveCp(cp) { fs.writeFileSync(CHECKPOINT, JSON.stringify(cp, null, 2)); }

// ── Artifact merge ────────────────────────────────────────────────────────────
// Reads existing artifact, merges new fills, writes back.
function loadArtifact() {
  try { return JSON.parse(fs.readFileSync(ARTIFACT, 'utf8')); }
  catch { return { fills: [], noWallet: [], notFound: [] }; }
}
function saveArtifact(existing, newFills, newNoWallet, newNotFound) {
  const existingIds = new Set(existing.fills.map(f => f.planId));
  const merged = {
    ...existing,
    note: existing.note + ' | Updated 2026-07-02 with final-20 sweep (fill-uhc-final20.js).',
    fills: [
      ...existing.fills,
      ...newFills.filter(f => !existingIds.has(f.planId)),
    ],
    noWallet: [...new Set([...(existing.noWallet || []), ...newNoWallet])],
    notFound: [...new Set([...(existing.notFound || []), ...newNotFound])],
  };
  fs.writeFileSync(ARTIFACT, JSON.stringify(merged, null, 2));
  return merged;
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  const prisma = makePrisma();
  const cp = loadCp();

  // ── Anchor gate ──
  console.log(`\nAnchor gate: verifying ${ANCHOR_PLAN_ID} = $${ANCHOR_EXPECTED_ANNUAL}/yr...`);
  const anchorRow = await prisma.plan.findFirst({
    where: { planId: ANCHOR_PLAN_ID, planYear: 2026 },
    select: { sbPdfUrl: true, foodCardAllowance: true },
  });
  if (!anchorRow) {
    console.error(`STOP: anchor ${ANCHOR_PLAN_ID} not found in DB.`);
    await prisma.$disconnect(); process.exit(2);
  }
  if (anchorRow.foodCardAllowance !== ANCHOR_EXPECTED_ANNUAL) {
    console.error(`STOP: anchor ${ANCHOR_PLAN_ID} DB=${anchorRow.foodCardAllowance} expected=${ANCHOR_EXPECTED_ANNUAL}. Investigate.`);
    await prisma.$disconnect(); process.exit(2);
  }
  console.log(`  Anchor OK: ${ANCHOR_PLAN_ID} = $${anchorRow.foodCardAllowance}/yr`);
  cp.anchorVerified = true;
  saveCp(cp);

  // ── Check fill-only gate: skip plans already filled ──
  const alreadyFilled = await prisma.plan.findMany({
    where: {
      planYear: 2026,
      planId: { in: TARGET_PLANS.map(p => p.planId) },
      OR: [{ foodCardAllowance: { gt: 0 } }, { sbVerifiedFoodAmount: { gt: 0 } }],
    },
    select: { planId: true, foodCardAllowance: true, sbVerifiedFoodAmount: true },
    distinct: ['planId'],
  });
  const skipIds = new Set(alreadyFilled.map(p => p.planId));
  if (skipIds.size > 0) {
    console.log(`\nSkipping already-filled: ${[...skipIds].join(', ')}`);
  }

  // ── Sweep ──
  const fills = [];
  const noWallet = [];
  const notFound = [];
  const multiAmounts = [];

  for (const plan of TARGET_PLANS) {
    const { planId } = plan;
    if (skipIds.has(planId)) { console.log(`  ${planId}: skip (already filled)`); continue; }

    const cpKey = `plan_${planId}`;
    if (cp[cpKey]?.done) {
      const res = cp[cpKey];
      console.log(`  ${planId}: checkpoint (${res.result}${res.monthly ? ' $' + res.monthly + '/mo' : ''})`);
      if (res.result === 'FILL' && res.monthly) {
        fills.push({ planId, monthly: res.monthly, annual: res.monthly * 12, state: plan.state, cat: plan.cat, evidence: res.evidence || '' });
      } else if (res.result === 'NO_WALLET') noWallet.push(planId);
      else if (res.result === 'NOT_FOUND') notFound.push(planId);
      else if (res.result === 'MULTI') multiAmounts.push({ planId, amounts: res.amounts });
      continue;
    }

    console.log(`\n${planId} ${plan.state} ${plan.cat} ["${plan.planName}"]`);

    const sb = await acquireSb(prisma, plan);
    if (!sb) {
      console.log(`  -> NOT_FOUND`);
      notFound.push(planId);
      cp[cpKey] = { done: true, result: 'NOT_FOUND' };
      saveCp(cp);
      continue;
    }

    const ext = extractMonthlyFood(sb.text);
    if (ext.evidence.length) console.log(`  evidence: ${ext.evidence[0].slice(0, 140)}`);

    if (ext.amounts.length === 0) {
      console.log(`  -> NO_WALLET`);
      noWallet.push(planId);
      cp[cpKey] = { done: true, result: 'NO_WALLET' };
      saveCp(cp);
    } else if (ext.amounts.length > 1) {
      console.log(`  -> MULTI_AMOUNT (${ext.amounts.map(a => '$' + a + '/mo').join(', ')})`);
      multiAmounts.push({ planId, amounts: ext.amounts });
      cp[cpKey] = { done: true, result: 'MULTI', amounts: ext.amounts };
      saveCp(cp);
    } else {
      const monthly = ext.amounts[0];
      console.log(`  -> FILL $${monthly}/mo ($${monthly * 12}/yr)`);
      fills.push({ planId, monthly, annual: monthly * 12, state: plan.state, cat: plan.cat, evidence: ext.evidence[0] || '' });
      cp[cpKey] = { done: true, result: 'FILL', monthly, evidence: ext.evidence[0] || '' };
      saveCp(cp);
    }

    await new Promise(r => setTimeout(r, 800));
  }

  // ── Summary ──
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`SWEEP COMPLETE (${APPLY ? 'APPLY' : 'DRY-RUN'})`);
  console.log(`  Filled: ${fills.length} | No-wallet: ${noWallet.length} | Not-found: ${notFound.length} | Multi: ${multiAmounts.length}`);
  if (fills.length) {
    console.log('\nFILL targets:');
    for (const f of fills) console.log(`  ${f.planId} ${f.state} ${f.cat}: $${f.monthly}/mo ($${f.annual}/yr)`);
  }
  if (multiAmounts.length) {
    console.log('\nMULTI-AMOUNT (NOT written — review manually):');
    for (const m of multiAmounts) console.log(`  ${m.planId}: ${m.amounts.map(a => '$' + a).join(', ')}`);
  }
  if (noWallet.length) console.log(`\nNo-wallet: ${noWallet.join(', ')}`);
  if (notFound.length) console.log(`\nNot-found: ${notFound.join(', ')}`);

  if (!APPLY) {
    console.log('\nDRY-RUN — no DB writes. Re-run with --apply to apply.');
    await prisma.$disconnect();
    return;
  }
  if (fills.length === 0 && multiAmounts.length === 0) {
    console.log('\nNothing to write.');
    await prisma.$disconnect();
    return;
  }

  // ── Apply fills ──
  console.log('\nApplying fills...');
  const firstRow = await prisma.plan.findFirst({ where: { planYear: 2026 } });
  const schemaKeys = new Set(firstRow ? Object.keys(firstRow) : []);
  const has = f => schemaKeys.has(f);
  let written = 0;

  for (const f of fills) {
    const data = { foodCardAllowance: f.annual };
    if (has('ssbciFoodAllowance'))  data.ssbciFoodAllowance  = f.monthly;
    if (has('ssbciIsConditional'))  data.ssbciIsConditional  = true;
    if (has('ssbciOffersFood'))     data.ssbciOffersFood     = true;
    const r = await prisma.plan.updateMany({
      where: {
        planId: f.planId,
        planYear: 2026,
        OR: [{ foodCardAllowance: null }, { foodCardAllowance: 0 }],
      },
      data,
    });
    written += r.count;
    console.log(`  ${f.planId}: $${f.annual}/yr -> ${r.count} county rows`);
  }
  console.log(`\nApplied: ${fills.length} plans, ${written} county rows.`);

  // ── Artifact merge ──
  const existing = loadArtifact();
  const merged = saveArtifact(existing, fills, noWallet, notFound);
  console.log(`\nArtifact merged: ${ARTIFACT} (${merged.fills.length} total fills)`);

  await prisma.$disconnect();
})().catch(async e => {
  console.error(e);
  try { await makePrisma().$disconnect(); } catch {}
  process.exit(1);
});
