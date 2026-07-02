// scripts/fill-devoted-foodcard.js
// Devoted Health DSNP/CSNP Food & Home Card sweep (2026-07).
// Covers all Devoted plans at effective-food=$0 that were missed by the 06-29 sweep
// (those lacked sbPdfUrls). Acquires SBs via content.medicareadvantage.com direct
// URL construction or SerpAPI, then ingests to Vercel Blob.
//
// Write target: foodCardAllowance (annual) + ssbciIsConditional=true
//   — identical to extract-devoted-foodcard.js behavior.
//   — sbVerifiedFoodAmount is Humana-only; do NOT write it.
//
//   node scripts/fill-devoted-foodcard.js          # dry-run
//   node scripts/fill-devoted-foodcard.js --apply  # write fills
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

const CHECKPOINT = path.join(__dirname, 'data', 'devoted-wallet-sweep-2026-07.json');
const ARTIFACT   = path.join(__dirname, 'data', 'devoted-wallet-fills-2026-07.json');

// Anchor: H1290-86 FL CSNP = $5916/yr ($493/mo)
const ANCHOR_PLAN_ID       = 'H1290-86';
const ANCHOR_EXPECTED_ANNUAL = 5916;

// ── HTTP helpers ──────────────────────────────────────────────────────────────
async function dlBuf(url, timeout = 35000) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/pdf,*/*' },
      redirect: 'follow', signal: AbortSignal.timeout(timeout),
    });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch { return null; }
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
function pdfToText(buf) {
  const tmp = path.join(os.tmpdir(), 'dv-sb-' + Math.random().toString(36).slice(2) + '.pdf');
  try {
    fs.writeFileSync(tmp, buf);
    return execFileSync(PDFTOTEXT, ['-layout', '-f', '1', '-l', '20', tmp, '-'], {
      maxBuffer: 30 * 1024 * 1024,
    }).toString('utf8');
  } catch { return ''; }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}

function validatePdf(planId, buf, text) {
  if (!buf || buf.length < 800) return [false, 'too_short'];
  if (buf.slice(0, 5).toString('latin1') !== '%PDF-') return [false, 'not_pdf'];
  if (!text || text.length < 300) return [false, 'no_text'];
  // Plan ID check: H2041-7 → check for "H2041" and ("7" or "007") in the text
  const [c, n] = planId.split('-');
  const hayNorm = text.replace(/[\s\-|]/g, '').toUpperCase();
  if (!hayNorm.includes(c.toUpperCase() + n.padStart(3, '0')) && !hayNorm.includes(c.toUpperCase() + n)) {
    return [false, 'planid_missing'];
  }
  if (!/summary.?of.?benefits/i.test(text)) return [false, 'no_sb_title'];
  if (!text.includes('2026')) return [false, 'stale_year'];
  if (/january 1[–\-]december 31, 2025/i.test(text) && !/january 1[–\-]december 31, 2026/i.test(text)) {
    return [false, 'stale_2025'];
  }
  return [true, ''];
}

// ── Devoted wallet parser (mirrors extract-devoted-foodcard.js parseWallet) ──
function parseWallet(text) {
  const lines = text.split(/\r?\n/);
  let foodMonthly = null, foodSnippet = '';
  let otcQuarterly = null, otcMonthly = null, otcSnippet = '';
  let ssbciIsConditional = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/over-the-counter/i.test(line) && otcQuarterly === null && otcMonthly === null) {
      const ctx = lines.slice(Math.max(0, i - 2), i + 8).join(' ');
      const mQ = ctx.match(/\$(\d[\d,]*)\s+per\s+quarter/i);
      const mM = ctx.match(/\$(\d[\d,]*)\s+per\s+month/i);
      if (mQ) otcQuarterly = parseInt(mQ[1].replace(/,/g, ''), 10);
      else if (mM) otcMonthly = parseInt(mM[1].replace(/,/g, ''), 10);
      otcSnippet = ctx.slice(0, 160).replace(/\s+/g, ' ').trim();
    }
    if (/food.*home card|food.*card.*special supplemental|food.*card.*chronically/i.test(line)) {
      const ctx = lines.slice(i, i + 10).join(' ');
      const mM = ctx.match(/\$(\d[\d,]*)\s+per\s+month/i);
      const mQ = ctx.match(/\$(\d[\d,]*)\s+per\s+quarter/i);
      if (mM) { foodMonthly = parseInt(mM[1].replace(/,/g, ''), 10); }
      else if (mQ) { foodMonthly = parseInt(mQ[1].replace(/,/g, ''), 10) / 3; }
      foodSnippet = ctx.slice(0, 200).replace(/\s+/g, ' ').trim();
    }
    if (/chronically ill|special supplemental benefit for the chronically/i.test(line)) ssbciIsConditional = true;
  }
  // Secondary scan: standalone $X/mo lines near food context
  if (foodMonthly === null) {
    for (let i = 0; i < lines.length; i++) {
      if (/\$(\d[\d,]+)\s+per\s+month/i.test(lines[i])) {
        const ctx = lines.slice(Math.max(0, i - 4), i + 4).join(' ');
        if (/food|eligible food|home card|utility|utilities|mortgage|rent/i.test(ctx)) {
          const m = lines[i].match(/\$(\d[\d,]+)\s+per\s+month/i);
          if (m) { foodMonthly = parseInt(m[1].replace(/,/g, ''), 10); foodSnippet = ctx.slice(0, 200).replace(/\s+/g, ' ').trim(); }
        }
      }
    }
  }
  const foodAnnual  = foodMonthly !== null ? foodMonthly * 12 : null;
  const otcAnnual   = otcQuarterly !== null ? otcQuarterly * 4 : otcMonthly !== null ? otcMonthly * 12 : null;
  return { foodMonthly, foodAnnual, otcQuarterly, otcMonthly, otcAnnual, ssbciIsConditional, foodSnippet, otcSnippet };
}

// ── Devoted direct URL construction ───────────────────────────────────────────
// Pattern: content.medicareadvantage.com/2026/2026-{SLUG}-SB-{H}-{NUM3}-ENG-SF20250924.pdf
// SLUG = planName → remove parens, spaces→dashes, uppercase
function buildDevotedUrl(planId, planName) {
  if (!planName || planName === planId) return null;
  const [contract, num] = planId.split('-');
  const numPad = num.padStart(3, '0');
  const slug = planName
    .replace(/[()]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/--+/g, '-')
    .toUpperCase();
  return `https://content.medicareadvantage.com/2026/2026-${slug}-SB-${contract}-${numPad}-ENG-SF20250924.pdf`;
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

// ── SB acquisition ────────────────────────────────────────────────────────────
async function acquireSb(prisma, planId, planName, cp) {
  // 1. Stored URL
  const dbRow = await prisma.plan.findFirst({ where: { planId, planYear: 2026 }, select: { sbPdfUrl: true } });
  if (dbRow?.sbPdfUrl) {
    const buf = await dlBuf(dbRow.sbPdfUrl);
    if (buf) {
      const text = pdfToText(buf);
      const [ok, reason] = validatePdf(planId, buf, text);
      if (ok) return { text, url: dbRow.sbPdfUrl };
      console.log(`  stored URL failed: ${reason}`);
    }
  }

  // 2. Direct construction from plan name
  const directUrl = buildDevotedUrl(planId, planName);
  if (directUrl) {
    console.log(`  direct: ${directUrl.slice(0, 100)}`);
    const buf = await dlBuf(directUrl);
    if (buf) {
      const text = pdfToText(buf);
      const [ok, reason] = validatePdf(planId, buf, text);
      console.log(`    -> ${ok ? 'VALID' : reason}`);
      if (ok) {
        const blobUrl = await blobIngest(prisma, planId, directUrl, buf);
        return { text, url: blobUrl || directUrl };
      }
    }
  }

  // 3. SerpAPI fallback
  if (SERP_KEY) {
    const queries = [
      `"${planId}" 2026 "Summary of Benefits" site:devoted.com OR site:content.medicareadvantage.com`,
      `Devoted "${planId}" 2026 "Summary of Benefits" filetype:pdf`,
    ];
    for (const q of queries) {
      console.log(`  SERP: ${q.slice(0, 90)}`);
      const links = await serpLinks(q);
      const pdfLinks = links.filter(u => /\.(pdf)$/i.test(u) || /medicareadvantage\.com|devoted\.com/i.test(u)).slice(0, 3);
      for (const u of pdfLinks) {
        const buf = await dlBuf(u);
        if (!buf) continue;
        const text = pdfToText(buf);
        const [ok, reason] = validatePdf(planId, buf, text);
        console.log(`    ${u.slice(0, 80)} -> ${ok ? 'VALID' : reason}`);
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
  console.log(`\nAnchor gate: verifying ${ANCHOR_PLAN_ID} = $${ANCHOR_EXPECTED_ANNUAL}/yr...`);
  const anchorRow = await prisma.plan.findFirst({
    where: { planId: ANCHOR_PLAN_ID, planYear: 2026 },
    select: { sbPdfUrl: true, foodCardAllowance: true },
  });
  if (!anchorRow?.sbPdfUrl) { console.error('STOP: anchor has no sbPdfUrl'); await prisma.$disconnect(); process.exit(2); }
  if (anchorRow.foodCardAllowance !== ANCHOR_EXPECTED_ANNUAL) {
    console.error(`STOP: anchor DB value ${anchorRow.foodCardAllowance} != expected ${ANCHOR_EXPECTED_ANNUAL}`);
    await prisma.$disconnect(); process.exit(2);
  }
  if (!cp.anchorVerified) {
    const anchorBuf = await dlBuf(anchorRow.sbPdfUrl);
    if (anchorBuf) {
      const anchorText = pdfToText(anchorBuf);
      const anchorW = parseWallet(anchorText);
      if (anchorW.foodAnnual !== null && anchorW.foodAnnual !== ANCHOR_EXPECTED_ANNUAL) {
        console.error(`STOP: anchor extractor $${anchorW.foodAnnual}/yr != expected $${ANCHOR_EXPECTED_ANNUAL}/yr`);
        await prisma.$disconnect(); process.exit(2);
      }
      console.log(`  Anchor OK: DB=$${anchorRow.foodCardAllowance}/yr extractor=${anchorW.foodAnnual !== null ? '$' + anchorW.foodAnnual + '/yr' : 'not extracted (DB confirmed)'}`);
    } else {
      console.log(`  Anchor DB OK: $${anchorRow.foodCardAllowance}/yr (PDF fetch failed — DB confirmed)`);
    }
    cp.anchorVerified = true;
    saveCp(cp);
  } else {
    console.log(`  Anchor OK (cached from checkpoint): DB=$${anchorRow.foodCardAllowance}/yr`);
  }

  // ── Get all target plans ──
  const targets = await prisma.plan.findMany({
    where: {
      planYear: 2026,
      planCategory: { in: ['DSNP', 'CSNP'] },
      organizationName: { contains: 'devoted', mode: 'insensitive' },
      OR: [
        { AND: [{ sbVerifiedFoodAmount: null }, { foodCardAllowance: null }] },
        { AND: [{ sbVerifiedFoodAmount: 0 },   { foodCardAllowance: null }] },
        { AND: [{ sbVerifiedFoodAmount: null }, { foodCardAllowance: 0 }] },
        { AND: [{ sbVerifiedFoodAmount: 0 },   { foodCardAllowance: 0 }] },
      ],
    },
    select: {
      planId: true, planCategory: true, state: true, planName: true,
      otcAllowance: true, ssbciIsConditional: true, sbPdfUrl: true,
    },
    distinct: ['planId'],
    orderBy: [{ state: 'asc' }, { planId: 'asc' }],
  });
  console.log(`\nTarget plans: ${targets.length}`);

  const fills = [], noWallet = [], notFound = [];
  let written = 0;

  for (const plan of targets) {
    const { planId, planName } = plan;
    const cpKey = `plan_${planId}`;
    if (cp[cpKey]?.done) {
      const r = cp[cpKey];
      process.stdout.write(`  ${planId}: checkpoint (${r.result}${r.monthly ? ' $' + r.monthly + '/mo' : ''})\n`);
      if (r.result === 'FILL') fills.push({ planId, monthly: r.monthly, annual: r.monthly * 12, state: plan.state, cat: plan.planCategory, evidence: r.evidence || '' });
      else if (r.result === 'NOT_FOUND') notFound.push(planId);
      else noWallet.push(planId);
      continue;
    }

    console.log(`\n${planId} ${plan.state} ${plan.planCategory} [${(planName || '').slice(0, 45)}]`);
    const sb = await acquireSb(prisma, planId, planName, cp);
    if (!sb) {
      console.log(`  NOT_FOUND`);
      notFound.push(planId);
      cp[cpKey] = { done: true, result: 'NOT_FOUND' };
      saveCp(cp);
      continue;
    }

    const w = parseWallet(sb.text);
    const monthly = w.foodMonthly;
    const annual  = w.foodAnnual;
    console.log(`  food=$${monthly ?? 'null'}/mo ($${annual ?? 'null'}/yr) otc=${w.otcQuarterly !== null ? '$' + w.otcQuarterly + '/qtr' : '--'} cond=${w.ssbciIsConditional}`);
    if (w.foodSnippet) console.log(`  snippet: ${w.foodSnippet.slice(0, 120)}`);

    if (!annual) {
      console.log(`  -> NO_WALLET`);
      noWallet.push(planId);
      cp[cpKey] = { done: true, result: 'NO_WALLET' };
      saveCp(cp);
    } else {
      console.log(`  -> FILL $${monthly}/mo ($${annual}/yr)`);
      fills.push({ planId, monthly, annual, state: plan.state, cat: plan.planCategory, evidence: w.foodSnippet.slice(0, 120) });
      cp[cpKey] = { done: true, result: 'FILL', monthly, evidence: w.foodSnippet.slice(0, 120) };
      saveCp(cp);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // ── Summary ──
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`SWEEP COMPLETE (${APPLY ? 'APPLY' : 'DRY-RUN'})`);
  console.log(`  Filled: ${fills.length} | No-wallet: ${noWallet.length} | Not-found: ${notFound.length}`);
  if (fills.length) {
    console.log('\nFILL targets:');
    for (const f of fills) console.log(`  ${f.planId} ${f.state} ${f.cat}: $${f.monthly}/mo ($${f.annual}/yr)`);
  }
  if (noWallet.length)  console.log(`\nNo-wallet: ${noWallet.join(', ')}`);
  if (notFound.length)  console.log(`Not-found: ${notFound.join(', ')}`);

  if (!APPLY) { console.log('\nDRY-RUN — no writes.'); await prisma.$disconnect(); return; }
  if (fills.length === 0) { console.log('\nNothing to write.'); await prisma.$disconnect(); return; }

  // ── Apply fills ──
  console.log('\nApplying fills...');
  for (const f of fills) {
    const r = await prisma.plan.updateMany({
      where: {
        planId: f.planId, planYear: 2026,
        OR: [{ foodCardAllowance: null }, { foodCardAllowance: 0 }],
      },
      data: { foodCardAllowance: f.annual, ssbciIsConditional: true },
    });
    written += r.count;
    console.log(`  ${f.planId}: $${f.annual}/yr -> ${r.count} county rows`);
  }
  console.log(`\nApplied: ${fills.length} plans, ${written} county rows.`);

  // ── Artifact ──
  const artifact = {
    note: 'SB-verified Devoted DSNP/CSNP foodCardAllowance fills (2026). fill-devoted-foodcard.js run 2026-07-02. Anchor: H1290-86=$5916/yr.',
    fills: fills.map(f => ({ planId: f.planId, monthly: f.monthly, annual: f.annual, state: f.state, cat: f.cat })),
    noWallet, notFound,
  };
  fs.writeFileSync(ARTIFACT, JSON.stringify(artifact, null, 2));
  console.log(`\nArtifact saved: ${ARTIFACT}`);

  await prisma.$disconnect();
})().catch(async e => {
  console.error(e);
  try { require('./prisma-client').makePrisma().$disconnect(); } catch {}
  process.exit(1);
});
