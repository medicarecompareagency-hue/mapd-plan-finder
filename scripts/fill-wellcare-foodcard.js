// scripts/fill-wellcare-foodcard.js
// Wellcare DSNP/CSNP food wallet sweep (2026-07).
// Acquires SBs (stored URL or Centene DAM docnum probe or SerpAPI),
// extracts monthly food credit, applies foodCardAllowance fills (fill-only).
// Checkpoint + resume. Idempotent.
//
//   node scripts/fill-wellcare-foodcard.js            # dry-run
//   node scripts/fill-wellcare-foodcard.js --apply    # write fills
//
// Write target: foodCardAllowance (effectiveFoodCard priority #2; sbVerifiedFoodAmount is Humana-only)
//
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { put } = require('@vercel/blob');
const { makePrisma } = require('./prisma-client');

// Load env
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

const CHECKPOINT = path.join(__dirname, 'data', 'wellcare-wallet-sweep-2026-07.json');
const ARTIFACT   = path.join(__dirname, 'data', 'wellcare-wallet-fills-2026-07.json');

// Anchor: H3868-1 TX Wellcare = $185/mo = $2220/yr (validated in 06-29 sweep)
const ANCHOR_PLAN_ID       = 'H3868-1';
const ANCHOR_EXPECTED_MONTHLY = 185;

// ── HTTP helpers ──────────────────────────────────────────────────────────────
async function dlBuf(url, timeout = 30000) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/pdf,*/*' },
      redirect: 'follow', signal: AbortSignal.timeout(timeout),
    });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch { return null; }
}

async function headOk(url) {
  try {
    const r = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      redirect: 'follow', signal: AbortSignal.timeout(1500),
    });
    return r.ok;
  } catch { return false; }
}

async function serpLinks(q) {
  if (!SERP_KEY) return [];
  const url = `https://serpapi.com/search.json?engine=google&num=10&q=${encodeURIComponent(q)}&api_key=${SERP_KEY}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.organic_results || []).map(o => o.link).filter(Boolean);
  } catch { return []; }
}

// ── PDF helpers ───────────────────────────────────────────────────────────────
function pdfToText(buf, pages = []) {
  const tmp = path.join(os.tmpdir(), 'wc-sb-' + Math.random().toString(36).slice(2) + '.pdf');
  try {
    fs.writeFileSync(tmp, buf);
    const args = ['-layout', ...pages.flatMap(p => ['-f', String(p), '-l', String(p)]), tmp, '-'];
    if (pages.length === 0) { args.splice(0, 1, '-layout'); }
    return execFileSync(PDFTOTEXT, ['-layout', tmp, '-'], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  } catch { return ''; }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}

function validatePdf(planId, buf, text) {
  if (!buf || buf.length < 800) return [false, 'too_short'];
  if (buf.slice(0, 5).toString('latin1') !== '%PDF-') return [false, 'not_pdf'];
  if (!text || text.length < 300) return [false, 'no_text'];
  const hayNorm = text.replace(/[\s\-|]/g, '').toUpperCase();
  const [c, n] = planId.split('-');
  if (!hayNorm.includes((c + n.padStart(3, '0')).toUpperCase()) && !hayNorm.includes((c + n).toUpperCase())) {
    return [false, 'planid_missing'];
  }
  if (!/summary.?of.?benefits/i.test(text)) return [false, 'no_sb_title'];
  if (!text.includes('2026')) return [false, 'stale_year'];
  if (/january 1[–-]december 31, 2025/i.test(text) && !/january 1[–-]december 31, 2026/i.test(text)) {
    return [false, 'stale_2025'];
  }
  return [true, ''];
}

// ── Food extractor ────────────────────────────────────────────────────────────
function norm(s) { return s.replace(/[‐‐-―−]/g, '-').replace(/ /g, ' ').replace(/\s+/g, ' '); }

const FOOD_CTX   = /healthy foods?|grocer(?:y|ies)?|\bfood\b|over-the-counter|\botc\b|\bpreload/i;
const EXCLUDE    = /hearing|dental|\bvision\b|eyewear|\bpremium\b|give.?back|\bpart b\b|\breward|fitness|\brent\b|mortgage|transportation|\bspecial supplemental\b/i;
const MONTHLY_RE = /\$\s?(\d[\d,]*)\b(?:\s+[a-z()\/-]+){0,4}?\s*(per month|every month|each month|a month|monthly|\/ ?mo(?:nth)?\b)/i;

function extractMonthlyFood(text) {
  const lines = text.split(/\r?\n/).map(l => norm(l).trim()).filter(Boolean);
  const found = [], ev = [];
  for (let i = 0; i < lines.length; i++) {
    if (!FOOD_CTX.test(lines[i]) || EXCLUDE.test(lines[i])) continue;
    let m = lines[i].match(MONTHLY_RE);
    if (!m) {
      const blk = lines[i] + ' ' + (lines[i + 1] || '');
      if (!EXCLUDE.test(blk)) m = blk.match(MONTHLY_RE);
    }
    if (m) {
      const amt = parseInt(m[1].replace(/,/g, ''), 10);
      if (amt >= 10 && amt <= 2000) { found.push(amt); if (ev.length < 3) ev.push(lines[i].slice(0, 160)); }
    }
  }
  return { amounts: [...new Set(found)], evidence: ev };
}

// Heuristic: classify a no-wallet plan
function classifyNoWallet(plan, text) {
  const low = (text || '').toLowerCase();
  if (/giveback|give.back|part b premium reduction/i.test(low)) return 'GIVEBACK';
  if (/flex card|spending card|OTC-only/i.test(low) && !/food|grocer/i.test(low)) return 'OTC_ONLY';
  if ((plan.otcAllowance || 0) > 0) return 'OTC_ONLY';
  return 'NO_WALLET';
}

// ── Centene DAM URL probe ─────────────────────────────────────────────────────
// Known docnum range from 06-29 sweep: ~4626664–4626940
const DAM_RANGE_START = 4626664;
const DAM_RANGE_END   = 4626950;
// Only DSNP and HMO types; omit Buckeye variants (slow CDN, wrong contract scope)
const DAM_TYPES_FAST = ['dsnp', 'hmo', 'cmapd'];

// Contracts confirmed-unposted as of 06-30; skip DAM probe, go straight to SerpAPI
const KNOWN_UNPOSTED_CONTRACTS = new Set(['H0908', 'H1664', 'H6550']);

function buildCenteneUrlsFast(contract, state, num) {
  const st = state.toLowerCase(), hl = contract.toLowerCase();
  return DAM_TYPES_FAST.map(ty =>
    `https://www.wellcare.com/-/media/pdfs/medicare-2026/sb/${hl}_2026_${st}_sb_${ty}_${num}eng_m.ashx`
  );
}

async function probeCenteneContract(contract, state) {
  process.stdout.write(`  DAM probe ${contract} (${state}) docnums ${DAM_RANGE_START}-${DAM_RANGE_END}: `);
  for (let num = DAM_RANGE_START; num <= DAM_RANGE_END; num++) {
    const urls = buildCenteneUrlsFast(contract, state, num);
    // 12 in parallel — 404s return in <50ms from wellcare CDN
    for (let j = 0; j < urls.length; j += 12) {
      const batch = urls.slice(j, j + 12);
      const res = await Promise.all(batch.map(headOk));
      for (let k = 0; k < batch.length; k++) {
        if (res[k]) {
          console.log(`\n    FOUND docnum=${num}: ${batch[k].slice(0, 90)}`);
          return batch[k];
        }
      }
    }
    if ((num - DAM_RANGE_START) % 50 === 49) process.stdout.write('.');
  }
  console.log(' MISS');
  return null;
}

// ── Blob ingest ───────────────────────────────────────────────────────────────
async function blobIngest(prisma, planId, sourceUrl, buf) {
  if (!BLOB_TOKEN) return null;
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  try {
    const result = await put(`sb/2026/${planId}.pdf`, new Blob([buf]), {
      access: 'public', addRandomSuffix: false, allowOverwrite: true,
      contentType: 'application/pdf', token: BLOB_TOKEN,
    });
    await prisma.plan.updateMany({
      where: { planId },
      data: { sbPdfUrl: result.url, sbPdfSourceFilename: sourceUrl, sbPdfChecksum: sha, sbLastProcessedAt: new Date(), sbDiscoveryConfidence: 0.97 },
    });
    return result.url;
  } catch (e) { console.error('  Blob error:', e.message); return null; }
}

const ALLOW_WC = /\.(wellcare\.com|buckeye-healthplan\.com|wellcareok\.com|wellcare\.superiorhealthplan\.com|content\.medicareadvantage\.com)$/i;

async function acquireSb(prisma, planId, state, cp) {
  const cpKey = `sb_${planId}`;

  // Try stored URL first
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
      console.log(`  stored URL failed: ${reason} — continuing to discovery`);
    }
  }

  // Centene DAM probe (per-contract, share across plans in same contract)
  // Skip for confirmed-unposted contracts (verified unposted 06-30, 2 days prior)
  const contract = planId.split('-')[0];
  const damKey = `dam_${contract}`;
  if (!cp[damKey]) {
    if (KNOWN_UNPOSTED_CONTRACTS.has(contract)) {
      console.log(`  DAM probe skipped: ${contract} confirmed-unposted 06-30`);
      cp[damKey] = 'MISS';
      saveCp(cp);
    } else {
      const found = await probeCenteneContract(contract, state);
      cp[damKey] = found || 'MISS';
      saveCp(cp);
    }
  }
  if (cp[damKey] && cp[damKey] !== 'MISS') {
    const damUrl = cp[damKey];
    const buf = await dlBuf(damUrl);
    if (buf) {
      const text = pdfToText(buf);
      const [ok, reason] = validatePdf(planId, buf, text);
      if (ok) {
        const blobUrl = await blobIngest(prisma, planId, damUrl, buf);
        return { text, url: blobUrl || damUrl };
      }
      console.log(`  DAM URL failed validation: ${reason}`);
    }
  }

  // SerpAPI fallback
  if (SERP_KEY) {
    const queries = [
      `Wellcare "${planId}" 2026 "Summary of Benefits" filetype:pdf`,
      `"${planId}" 2026 Summary Benefits site:wellcare.com`,
    ];
    for (const q of queries) {
      console.log(`  SERP: ${q.slice(0, 80)}`);
      const links = await serpLinks(q);
      const pdfLinks = links.filter(u => {
        try { return ALLOW_WC.test(new URL(u).hostname) || /\.pdf$/i.test(u); } catch { return false; }
      }).slice(0, 3);
      for (const u of pdfLinks) {
        const buf = await dlBuf(u);
        if (!buf) continue;
        const text = pdfToText(buf);
        const [ok, reason] = validatePdf(planId, buf, text);
        console.log(`    ${u.slice(0, 70)} -> ${ok ? 'VALID' : reason}`);
        if (ok) {
          const blobUrl = await blobIngest(prisma, planId, u, buf);
          return { text, url: blobUrl || u };
        }
      }
      await new Promise(r => setTimeout(r, 1200));
    }
  }
  return null;
}

// ── Checkpoint ────────────────────────────────────────────────────────────────
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
  if (!anchorRow?.sbPdfUrl) { console.error('STOP: anchor has no sbPdfUrl'); await prisma.$disconnect(); process.exit(2); }
  if (anchorRow.foodCardAllowance !== ANCHOR_EXPECTED_MONTHLY * 12) {
    console.error(`STOP: anchor DB value ${anchorRow.foodCardAllowance} != expected ${ANCHOR_EXPECTED_MONTHLY * 12}`);
    await prisma.$disconnect(); process.exit(2);
  }
  const anchorBuf = await dlBuf(anchorRow.sbPdfUrl);
  if (anchorBuf) {
    const anchorText = pdfToText(anchorBuf);
    const anchorExt = extractMonthlyFood(anchorText);
    if (anchorExt.amounts.length > 0 && !anchorExt.amounts.includes(ANCHOR_EXPECTED_MONTHLY)) {
      console.error(`STOP: anchor extractor returned [${anchorExt.amounts}], expected $${ANCHOR_EXPECTED_MONTHLY}/mo`);
      await prisma.$disconnect(); process.exit(2);
    }
    console.log(`  Anchor OK: ${ANCHOR_PLAN_ID} DB=$${anchorRow.foodCardAllowance}/yr extractor=[${anchorExt.amounts.map(a => '$' + a + '/mo').join(', ') || 'not extracted (DB confirmed)'}]`);
  } else {
    console.log(`  Anchor DB OK: $${anchorRow.foodCardAllowance}/yr (PDF fetch failed — DB value confirmed)`);
  }
  cp.anchorVerified = true;
  saveCp(cp);

  // ── Get all target plans from DB ──
  const targets = await prisma.plan.findMany({
    where: {
      planYear: 2026,
      planCategory: { in: ['DSNP', 'CSNP'] },
      organizationName: { contains: 'wellcare', mode: 'insensitive' },
      AND: [
        { OR: [{ sbVerifiedFoodAmount: null }, { sbVerifiedFoodAmount: 0 }] },
        { OR: [{ foodCardAllowance: null }, { foodCardAllowance: 0 }] },
      ],
    },
    select: {
      planId: true, planCategory: true, state: true, planName: true,
      otcAllowance: true, ssbciIsConditional: true, ssbciOffersFood: true,
    },
    distinct: ['planId'],
    orderBy: [{ state: 'asc' }, { planId: 'asc' }],
  });
  console.log(`\nTarget plans: ${targets.length}`);

  // BOB plans first
  const BOB = new Set(['H2509-2','H2509-3','H5008-11','H5008-16','H3256-5','H3256-6','H0251-2','H0251-8']);
  targets.sort((a, b) => {
    const ba = BOB.has(a.planId) ? 1 : 0, bb = BOB.has(b.planId) ? 1 : 0;
    return bb - ba || a.planId.localeCompare(b.planId);
  });

  // ── Sweep ──
  const fills = [], noWallet = [], giveback = [], otcOnly = [], gated = [], notFound = [], multiAmt = [];
  let written = 0;

  for (const plan of targets) {
    const { planId } = plan;
    const cpKey = `plan_${planId}`;

    if (cp[cpKey]?.done) {
      console.log(`  ${planId}: checkpoint (${cp[cpKey].result}${cp[cpKey].monthly ? ' $' + cp[cpKey].monthly + '/mo' : ''})`);
      const r = cp[cpKey];
      if (r.result === 'FILL') fills.push({ planId, monthly: r.monthly, annual: r.monthly * 12, state: plan.state, cat: plan.planCategory, evidence: r.evidence || '' });
      else if (r.result === 'GIVEBACK') giveback.push(planId);
      else if (r.result === 'OTC_ONLY') otcOnly.push(planId);
      else if (r.result === 'NO_WALLET') noWallet.push(planId);
      else if (r.result === 'NOT_FOUND') notFound.push(planId);
      else if (r.result === 'MULTI') multiAmt.push({ planId, amounts: r.amounts });
      continue;
    }

    console.log(`\n${planId} ${plan.state} ${plan.planCategory} [${plan.planName?.slice(0, 40) || ''}]`);

    const sb = await acquireSb(prisma, planId, plan.state, cp);
    if (!sb) {
      console.log(`  NOT_FOUND`);
      notFound.push(planId);
      cp[cpKey] = { done: true, result: 'NOT_FOUND' };
      saveCp(cp);
      continue;
    }

    const ext = extractMonthlyFood(sb.text);
    console.log(`  amounts: [${ext.amounts.map(a => '$' + a).join(', ') || 'none'}]`);
    if (ext.evidence[0]) console.log(`  evidence: ${ext.evidence[0].slice(0, 120)}`);

    if (ext.amounts.length === 0) {
      const cat = classifyNoWallet(plan, sb.text);
      console.log(`  -> ${cat}`);
      if (cat === 'GIVEBACK') giveback.push(planId);
      else if (cat === 'OTC_ONLY') otcOnly.push(planId);
      else noWallet.push(planId);
      cp[cpKey] = { done: true, result: cat };
      saveCp(cp);
    } else if (ext.amounts.length > 1) {
      console.log(`  -> MULTI_AMOUNT`);
      multiAmt.push({ planId, amounts: ext.amounts });
      cp[cpKey] = { done: true, result: 'MULTI', amounts: ext.amounts };
      saveCp(cp);
    } else {
      const monthly = ext.amounts[0];
      console.log(`  -> FILL $${monthly}/mo ($${monthly * 12}/yr)`);
      fills.push({ planId, monthly, annual: monthly * 12, state: plan.state, cat: plan.planCategory, evidence: ext.evidence[0] || '' });
      cp[cpKey] = { done: true, result: 'FILL', monthly, evidence: ext.evidence[0] || '' };
      saveCp(cp);
    }
    await new Promise(r => setTimeout(r, 600));
  }

  // ── Summary ──
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`SWEEP COMPLETE (${APPLY ? 'APPLY' : 'DRY-RUN'})`);
  console.log(`  Filled: ${fills.length} | Giveback: ${giveback.length} | OTC-only: ${otcOnly.length} | No-wallet: ${noWallet.length} | Not-found: ${notFound.length} | Multi: ${multiAmt.length}`);
  if (fills.length) {
    console.log('\nFILL targets:');
    for (const f of fills) console.log(`  ${f.planId} ${f.state} ${f.cat}: $${f.monthly}/mo ($${f.annual}/yr)  [${f.evidence.slice(0, 100)}]`);
  }
  if (giveback.length)  console.log(`\nGiveback (no food card by design): ${giveback.join(', ')}`);
  if (otcOnly.length)   console.log(`OTC-only (food=$0 correct): ${otcOnly.join(', ')}`);
  if (noWallet.length)  console.log(`No wallet found: ${noWallet.join(', ')}`);
  if (notFound.length)  console.log(`Not-found (SB unposted): ${notFound.join(', ')}`);
  if (multiAmt.length) { console.log('\nMULTI-AMOUNT (NOT written):'); multiAmt.forEach(m => console.log(`  ${m.planId}: ${m.amounts.map(a => '$' + a).join(', ')}`)); }

  if (!APPLY) { console.log('\nDRY-RUN — no writes.'); await prisma.$disconnect(); return; }
  if (fills.length === 0) { console.log('\nNothing to write.'); await prisma.$disconnect(); return; }

  // ── Apply fills ──
  console.log('\nApplying fills...');
  const firstRow = await prisma.plan.findFirst({ where: { planYear: 2026, organizationName: { contains: 'wellcare', mode: 'insensitive' } } });
  const schemaKeys = new Set(firstRow ? Object.keys(firstRow) : []);
  const has = f => schemaKeys.has(f);

  for (const f of fills) {
    const data = { foodCardAllowance: f.annual };
    if (has('ssbciFoodAllowance')) data.ssbciFoodAllowance = f.monthly;
    if (has('ssbciIsConditional')) data.ssbciIsConditional = true;
    if (has('ssbciOffersFood'))    data.ssbciOffersFood    = true;
    const r = await prisma.plan.updateMany({
      where: { planId: f.planId, planYear: 2026, OR: [{ foodCardAllowance: null }, { foodCardAllowance: 0 }] },
      data,
    });
    written += r.count;
    console.log(`  ${f.planId}: $${f.annual}/yr -> ${r.count} county rows`);
  }
  console.log(`\nApplied: ${fills.length} plans, ${written} county rows.`);

  // ── Artifact ──
  const artifact = {
    note: 'SB-verified Wellcare DSNP/CSNP foodCardAllowance fills (2026). fill-wellcare-foodcard.js run 2026-07-02. Anchor: H3868-1=$185/mo ($2220/yr).',
    fills: fills.map(f => ({ planId: f.planId, monthly: f.monthly, annual: f.annual, state: f.state, cat: f.cat })),
    noWallet, giveback, otcOnly, notFound: notFound,
  };
  fs.writeFileSync(ARTIFACT, JSON.stringify(artifact, null, 2));
  console.log(`\nArtifact saved: ${ARTIFACT}`);

  await prisma.$disconnect();
})().catch(async e => {
  console.error(e);
  try { await require('./prisma-client').makePrisma().$disconnect(); } catch {}
  process.exit(1);
});
