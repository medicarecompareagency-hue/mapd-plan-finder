// scripts/fix-specialist-typediff-zero.js — flip DB_LIKELY_WRONG specialist coinsurance -> $0 copay.
//   node scripts/fix-specialist-typediff-zero.js            # dry-run: lists the ~82, no writes
//   node scripts/fix-specialist-typediff-zero.js --apply    # writes copay=0 / coins=null for the gated set
const { execFileSync } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const { makePrisma } = require('./prisma-client');
const prisma = makePrisma();
const APPLY = process.argv.includes('--apply');
const CACHE = 'diagnose-specialist-typediff.cache.json';  // reuse the diagnostic's cache if present
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE,'utf8')) : {};

const PDFTOTEXT = process.platform === 'win32'
  ? 'C:\\Program Files\\Git\\mingw64\\bin\\pdftotext.exe'
  : 'pdftotext';

async function sbText(url){
  const res = await fetch(url); if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = path.join(os.tmpdir(), 'sb-' + Math.random().toString(36).slice(2) + '.pdf');
  fs.writeFileSync(tmp, buf);
  try { return execFileSync(PDFTOTEXT, ['-layout', tmp, '-'], { maxBuffer: 64*1024*1024 }).toString(); }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}

// VERBATIM from the diagnostic — identical classification, so the fix targets exactly DB_LIKELY_WRONG.
const QUAL = /telehealth|virtual|tier ?2|preferred|select network|first \d|after (?:the )?deductible|mail order|home visit|in lieu|optional supplemental|supplemental/i;
function analyze(text){
  const lines = text.split(/\r?\n/).map(l => l.replace(/\s+/g,' ').trim());
  const ctx = [];
  for (let i = 0; i < lines.length; i++){
    if (/specialist/i.test(lines[i]) && !/specialist (?:referral|drug|pharmac)/i.test(lines[i]))
      ctx.push({ line: lines[i], prev: lines[i-1] || '', next: lines[i+1] || '' });
  }
  let cleanZero = false, qualifiedZero = false, hasCoins = false, coinsPct = null, zEv = '', cEv = '';
  for (const c of ctx){
    const l = c.line;
    if (/out.?of.?network|\boon\b|non.?network|primary care|\bpcp\b|preventive/i.test(l)) continue;
    const isZero = /\$\s?0\b|no charge|\$0 copay/i.test(l);
    const pctM = l.match(/(\d{1,2})\s?%/);
    if (isZero){ if (QUAL.test(l) || QUAL.test(c.prev) || QUAL.test(c.next)) qualifiedZero = true; else { cleanZero = true; if (!zEv) zEv = l; } }
    if (pctM){ hasCoins = true; coinsPct = parseInt(pctM[1],10); if (!cEv) cEv = l; }
  }
  const sbShowsCopay = cleanZero || qualifiedZero;
  let verdict;
  if (cleanZero && !hasCoins) verdict = 'DB_LIKELY_WRONG';
  else if (cleanZero && hasCoins) verdict = 'MIXED_REVIEW';
  else if (qualifiedZero && !cleanZero) verdict = 'LIKELY_COINS';
  else if (hasCoins) verdict = 'LIKELY_COINS';
  else verdict = 'UNCLEAR';
  return { verdict, sbShowsCopay, cleanZero, qualifiedZero, hasCoins, coinsPct, zeroEvidence: zEv };
}

(async () => {
  const plans = await prisma.plan.findMany({
    where: { planYear: 2026, specialistCopay: null, specialistCoinsPct: { not: null } },
    select: { planId:true, organizationName:true, state:true, planCategory:true, specialistCoinsPct:true, sbPdfUrl:true },
    distinct: ['planId'], orderBy: { planId: 'asc' },
  });
  const byUrl = new Map();
  for (const p of plans){ if (!p.sbPdfUrl) continue; const e = byUrl.get(p.sbPdfUrl) || { url:p.sbPdfUrl, plans:[] }; e.plans.push(p); byUrl.set(p.sbPdfUrl, e); }

  const target = []; let fetched = 0, fail = 0, done = 0; const jobs = [...byUrl.values()];
  for (const job of jobs){
    let a = cache[job.url];
    if (a === undefined){ try { a = analyze(await sbText(job.url)); fetched++; } catch (e){ a = { __err: e.message }; fail++; } cache[job.url] = a; if (fetched % 20 === 0) fs.writeFileSync(CACHE, JSON.stringify(cache)); }
    done++;
    for (const p of job.plans){
      if (a && !a.__err && a.verdict === 'DB_LIKELY_WRONG' && a.cleanZero === true && a.hasCoins === false)
        target.push({ ...p, evidence: a.zeroEvidence });
    }
    if (done % 40 === 0) console.log(`  ...${done}/${jobs.length} PDFs`);
  }
  fs.writeFileSync(CACHE, JSON.stringify(cache));

  console.log(`\nDB_LIKELY_WRONG targets (cleanZero && !hasCoins): ${target.length} (expected ~82). ${APPLY ? 'APPLY' : 'DRY-RUN'}. parse-fail ${fail}.`);
  const byCarrier = {}; for (const t of target) byCarrier[t.organizationName] = (byCarrier[t.organizationName]||0) + 1;
  console.log('by carrier:', JSON.stringify(byCarrier));
  console.log('planId | carrier | state | DBcoins% -> $0 | SB evidence');
  for (const t of target) console.log(`  ${t.planId} | ${t.organizationName} | ${t.state} | ${t.specialistCoinsPct}% -> $0 | ${t.evidence}`);

  if (target.length === 0) { console.log('Nothing to do.'); await prisma.$disconnect(); return; }
  if (target.length > 110) { console.error(`STOP: ${target.length} targets is far above the expected ~82 — re-check the classifier before writing. No writes.`); await prisma.$disconnect(); process.exit(2); }
  if (!APPLY) { console.log('\nDRY-RUN — no writes. Re-run with --apply.'); await prisma.$disconnect(); return; }

  let written = 0;
  for (const t of target){ const r = await prisma.plan.updateMany({ where: { planId: t.planId, planYear: 2026 }, data: { specialistCopay: 0, specialistCoinsPct: null } }); written += r.count; }
  console.log(`\nApplied. planIds ${target.length} | county rows written ${written}.`);
  await prisma.$disconnect();
})().catch(async e => { console.error(e); try{await prisma.$disconnect()}catch{}; process.exit(1); });
