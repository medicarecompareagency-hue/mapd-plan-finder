// scripts/diagnose-specialist-typediff.js — READ-ONLY. SB $0-copay vs DB coinsurance.
//   node scripts/diagnose-specialist-typediff.js
//   node scripts/diagnose-specialist-typediff.js --carrier "Humana"
const { execFileSync } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const { makePrisma } = require('./prisma-client');
const prisma = makePrisma();
const ci = process.argv.indexOf('--carrier'); const CARRIER = ci >= 0 ? process.argv[ci+1] : null;
const CACHE = 'diagnose-specialist-typediff.cache.json';
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

// qualifiers that make a "$0" a carve-out rather than the standard in-network specialist copay
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
  return { verdict, sbShowsCopay, cleanZero, qualifiedZero, hasCoins, coinsPct, zeroEvidence: zEv, coinsEvidence: cEv, specialistLines: ctx.slice(0,6).map(c => c.line) };
}

(async () => {
  const where = { planYear: 2026, specialistCopay: null, specialistCoinsPct: { not: null } };
  if (CARRIER) where.organizationName = { contains: CARRIER, mode: 'insensitive' };
  const plans = await prisma.plan.findMany({ where,
    select:{ planId:true, organizationName:true, state:true, planCategory:true, specialistCoinsPct:true, sbPdfUrl:true, planName:true },
    distinct:['planId'], orderBy:{ planId:'asc' } });
  console.log(`Coinsurance-specialist plans (copay null, coins set): ${plans.length}${CARRIER?` (carrier~"${CARRIER}")`:''}`);

  const byUrl = new Map(); const noSb = [];
  for (const p of plans){ if (!p.sbPdfUrl){ noSb.push(p); continue; } const e = byUrl.get(p.sbPdfUrl) || { url:p.sbPdfUrl, plans:[] }; e.plans.push(p); byUrl.set(p.sbPdfUrl, e); }
  const jobs = [...byUrl.values()];

  const rows = []; let done = 0, fetched = 0, fail = 0;
  for (const job of jobs){
    let a = cache[job.url];
    if (a === undefined){ try { a = analyze(await sbText(job.url)); fetched++; } catch (e){ a = { __err: e.message }; fail++; } cache[job.url] = a; if (fetched % 20 === 0) fs.writeFileSync(CACHE, JSON.stringify(cache)); }
    done++;
    for (const p of job.plans){
      if (a && a.__err) rows.push({ planId:p.planId, carrier:p.organizationName, state:p.state, cat:p.planCategory, db_coins:p.specialistCoinsPct, sb_shows_copay:'', verdict:'PARSE_FAIL', zero_evidence:a.__err, coins_evidence:'', specialist_lines:'' });
      else rows.push({ planId:p.planId, carrier:p.organizationName, state:p.state, cat:p.planCategory, db_coins:p.specialistCoinsPct,
        sb_shows_copay: a.sbShowsCopay ? 'yes' : 'no', verdict: a.sbShowsCopay ? a.verdict : 'OK_COINS_IN_SB',
        zero_evidence: a.zeroEvidence, coins_evidence: a.coinsEvidence, specialist_lines: (a.specialistLines || []).join(' || ') });
    }
    if (done % 40 === 0) console.log(`  ...${done}/${jobs.length} PDFs (${fetched} fetched, ${fail} fail)`);
  }
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  for (const p of noSb) rows.push({ planId:p.planId, carrier:p.organizationName, state:p.state, cat:p.planCategory, db_coins:p.specialistCoinsPct, sb_shows_copay:'', verdict:'NO_SB', zero_evidence:'', coins_evidence:'', specialist_lines:'' });

  const typediff = rows.filter(r => r.sb_shows_copay === 'yes');
  const tally = {}; for (const r of typediff) tally[r.verdict] = (tally[r.verdict] || 0) + 1;
  const byCarrier = {};
  for (const r of typediff){ const b = byCarrier[r.carrier] || (byCarrier[r.carrier] = {}); b[r.verdict] = (b[r.verdict] || 0) + 1; }

  const headers = ['planId','carrier','state','cat','db_coins','sb_shows_copay','verdict','zero_evidence','coins_evidence','specialist_lines'];
  const esc = v => { const s = v==null?'':String(v); return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; };
  fs.writeFileSync('diagnose-specialist-typediff.csv', [headers.join(',')].concat(rows.map(r => headers.map(h => esc(r[h])).join(','))).join('\n'));

  console.log(`\nTYPE_DIFF (SB shows a $0/flat copay while DB has coinsurance): ${typediff.length}`);
  console.log('verdict split:', JSON.stringify(tally));
  console.log('\nby carrier:');
  for (const [c,b] of Object.entries(byCarrier).sort((a,b) => { const sa = Object.values(a[1]).reduce((x,y)=>x+y,0); const sb2 = Object.values(b[1]).reduce((x,y)=>x+y,0); return sb2-sa; }))
    console.log('  ' + c + ':', JSON.stringify(b));
  console.log('\n-- sample DB_LIKELY_WRONG (up to 20) --');
  for (const r of typediff.filter(r => r.verdict === 'DB_LIKELY_WRONG').slice(0,20)) console.log(`  ${r.planId} ${r.carrier} ${r.state}: DB ${r.db_coins}% | SB: ${r.zero_evidence}`);
  console.log('\n-- sample LIKELY_COINS (up to 10) --');
  for (const r of typediff.filter(r => r.verdict === 'LIKELY_COINS').slice(0,10)) console.log(`  ${r.planId} ${r.carrier}: DB ${r.db_coins}% | $0 line: ${r.zero_evidence||'(none)'} | coins line: ${r.coins_evidence}`);
  console.log('\nREAD: if DB_LIKELY_WRONG dominates -> real bug, worth a fix prompt (set copay 0 / coins null; ranking key #4). If LIKELY_COINS dominates -> DB is right, the $0s are carve-outs, no fix.');
  console.log('CSV: diagnose-specialist-typediff.csv (specialist_lines column has the raw SB lines).');
  await prisma.$disconnect();
})().catch(async e => { console.error(e); try{await prisma.$disconnect()}catch{}; process.exit(1); });
