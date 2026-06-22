// scripts/set-uhc-specialist-choice-display.js — DISPLAY ONLY. For UHC plans whose SB states an in-network
// specialist "$0 copay OR NN% coinsurance" member-choice, set specialistDisplay = "$0 or NN%".
// Ranking inputs are untouched (specialistCopay stays null, specialistCoinsPct stays the conservative value).
//   node scripts/set-uhc-specialist-choice-display.js            # dry-run: lists the ~16 with SB evidence
//   node scripts/set-uhc-specialist-choice-display.js --apply    # writes specialistDisplay only
const { execFileSync } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const { makePrisma } = require('./prisma-client');
const prisma = makePrisma();
const APPLY = process.argv.includes('--apply');
const CACHE = 'diagnose-specialist-typediff.cache.json'; // reuse the diagnostic's SB cache if present
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

// Member-choice = within a specialist context (line or its neighbours), BOTH a $0 and an NN% appear joined by "or".
function analyzeChoice(text){
  const lines = text.split(/\r?\n/).map(l => l.replace(/\s+/g,' ').trim());
  for (let i = 0; i < lines.length; i++){
    if (!/specialist/i.test(lines[i]) || /specialist (?:referral|drug|pharmac)/i.test(lines[i])) continue;
    const blk = [lines[i-1]||'', lines[i], lines[i+1]||''].join(' ');
    if (/out.?of.?network|\boon\b|non.?network|primary care|\bpcp\b|preventive/i.test(lines[i])) continue;
    const pctM = blk.match(/(\d{1,2})\s?%/);
    const hasZero = /\$\s?0\b|no charge|\$0 copay/i.test(blk);
    const choice = /\$\s?0\b[^.]{0,40}\bor\b[^.]{0,40}\d{1,2}\s?%|\d{1,2}\s?%[^.]{0,40}\bor\b[^.]{0,40}\$\s?0\b/i.test(blk);
    if (hasZero && pctM && choice) return { match:true, pct: parseInt(pctM[1],10), evidence: blk.slice(0,200) };
  }
  return { match:false };
}

(async () => {
  const F = Object.keys(await prisma.plan.findFirst()); const has = f => F.includes(f);
  if (!has('specialistDisplay')) { console.error('STOP: column specialistDisplay does not exist — run the Phase 2 `prisma db push` first (or reuse the existing display field and adapt this script).'); await prisma.$disconnect(); process.exit(2); }

  const plans = await prisma.plan.findMany({
    where: { planYear: 2026, specialistCopay: null, specialistCoinsPct: { not: null }, organizationName: { contains: 'UnitedHealth', mode: 'insensitive' } },
    select: { planId:true, organizationName:true, state:true, planCategory:true, specialistCoinsPct:true, specialistDisplay:true, sbPdfUrl:true },
    distinct: ['planId'], orderBy: { planId: 'asc' },
  });
  const byUrl = new Map();
  for (const p of plans){ if (!p.sbPdfUrl) continue; const e = byUrl.get(p.sbPdfUrl) || { url:p.sbPdfUrl, plans:[] }; e.plans.push(p); byUrl.set(p.sbPdfUrl, e); }

  const target = []; let fetched = 0, fail = 0, done = 0; const jobs = [...byUrl.values()];
  for (const job of jobs){
    let key = 'CHOICE::' + job.url, a = cache[key];
    if (a === undefined){ try { a = analyzeChoice(await sbText(job.url)); fetched++; } catch (e){ a = { __err:e.message }; fail++; } cache[key] = a; if (fetched % 20 === 0) fs.writeFileSync(CACHE, JSON.stringify(cache)); }
    done++;
    for (const p of job.plans){
      if (a && !a.__err && a.match){ const display = `$0 or ${a.pct}%`; target.push({ ...p, display, evidence:a.evidence }); }
    }
    if (done % 40 === 0) console.log(`  ...${done}/${jobs.length} PDFs`);
  }
  fs.writeFileSync(CACHE, JSON.stringify(cache));

  console.log(`\nUHC member-choice specialists ("$0 or NN%"): ${target.length} (expected ~16). ${APPLY ? 'APPLY' : 'DRY-RUN'}. parse-fail ${fail}.`);
  console.log('planId | state | cat | DBcoins% (unchanged) | -> specialistDisplay | SB evidence');
  for (const t of target) console.log(`  ${t.planId} | ${t.state} | ${t.planCategory} | ${t.specialistCoinsPct}% | "${t.display}" | ${t.evidence}`);
  if (target.length === 0) { console.log('Nothing matched.'); await prisma.$disconnect(); return; }
  if (target.length > 30) { console.error(`STOP: ${target.length} far above the expected ~16 — re-check the member-choice detector before writing. No writes.`); await prisma.$disconnect(); process.exit(2); }
  if (!APPLY) { console.log('\nDRY-RUN — no writes. Re-run with --apply.'); await prisma.$disconnect(); return; }

  let written = 0;
  for (const t of target){ const r = await prisma.plan.updateMany({ where:{ planId:t.planId, planYear:2026 }, data:{ specialistDisplay: t.display } }); written += r.count; }
  console.log(`\nApplied (display only — coins/copay untouched). planIds ${target.length} | county rows written ${written}.`);
  await prisma.$disconnect();
})().catch(async e => { console.error(e); try{await prisma.$disconnect()}catch{}; process.exit(1); });
