// scripts/audit-specialist-allcarriers.js — SB-vs-DB Specialist re-verify, all carriers.
//   node scripts/audit-specialist-allcarriers.js                      # dry-run, all carriers
//   node scripts/audit-specialist-allcarriers.js --carrier "UnitedHealthcare"
//   node scripts/audit-specialist-allcarriers.js --limit 200
//   node scripts/audit-specialist-allcarriers.js --apply              # write CLEAR copay mismatches only
const { execFileSync } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const { makePrisma } = require('./prisma-client');
const prisma = makePrisma();
const APPLY = process.argv.includes('--apply');
const ci = process.argv.indexOf('--carrier'); const CARRIER = ci >= 0 ? process.argv[ci+1] : null;
const li = process.argv.indexOf('--limit');   const LIMIT   = li >= 0 ? parseInt(process.argv[li+1],10) : Infinity;
const CACHE = 'audit-specialist-allcarriers.cache.json';
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

// Returns {type:'copay'|'coins', amount?, pct?, confidence:'clear'|'ambiguous', distinct[], evidence} or null.
function sbSpecialist(text){
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.replace(/\s+/g,' ').trim();
    if (!/specialist/i.test(l)) continue;
    if (/primary care|\bpcp\b|preventive|specialist (?:referral|drug|pharmac)/i.test(l)) continue; // not PCP / not Rx
    if (/out.?of.?network|\boon\b|non.?network/i.test(l)) continue;                                 // in-network only
    const dollars = [...l.matchAll(/\$\s?(\d[\d,]*)/g)].map(m => parseInt(m[1].replace(/,/g,''),10));
    const pctM = l.match(/(\d{1,2})\s?%/);
    if (dollars.length) {
      out.push({ type:'copay', amount:dollars[0], dollars, pct: pctM?parseInt(pctM[1],10):null, evidence:l });
      // If the same line also has a %, push a coins entry too so distinct.length > 1 → ambiguous
      if (pctM) out.push({ type:'coins', pct:parseInt(pctM[1],10), dollars:[], evidence:l });
    } else if (pctM)   out.push({ type:'coins', pct:parseInt(pctM[1],10), dollars:[], evidence:l });
    else if (/\$0\b|no charge/i.test(l)) out.push({ type:'copay', amount:0, dollars:[0], pct:null, evidence:l });
  }
  if (!out.length) return null;
  const copay = out.filter(o => o.type === 'copay');
  const chosen = copay[0] || out[0];
  const distinct = [...new Set(out.map(o => o.type==='copay' ? ('$'+o.amount) : (o.pct+'%')))];
  const hasRange = out.some(o => o.dollars.length > 1);
  const confidence = (distinct.length === 1 && !hasRange) ? 'clear' : 'ambiguous';
  return { ...chosen, confidence, distinct, lines: out.length };
}

(async () => {
  const where = { planYear: 2026 };
  if (CARRIER) where.organizationName = { contains: CARRIER, mode: 'insensitive' };
  const plans = await prisma.plan.findMany({ where,
    select:{ planId:true, organizationName:true, state:true, planCategory:true, specialistCopay:true, specialistCoinsPct:true, sbPdfUrl:true, planName:true },
    distinct:['planId'], orderBy:{ planId:'asc' } });

  const byUrl = new Map(); const noSb = [];
  for (const p of plans) { if (!p.sbPdfUrl) { noSb.push(p); continue; } const e = byUrl.get(p.sbPdfUrl) || { url:p.sbPdfUrl, plans:[] }; e.plans.push(p); byUrl.set(p.sbPdfUrl, e); }
  const jobs = [...byUrl.values()].slice(0, LIMIT);
  console.log(`${plans.length} plans${CARRIER?` (carrier~"${CARRIER}")`:''} | ${jobs.length} SB PDFs | ${noSb.length} no-SB | ${APPLY?'APPLY clear mismatches':'DRY-RUN'}`);

  const rows = []; let done = 0, fetched = 0, fail = 0;
  for (const job of jobs) {
    let spec = cache[job.url];
    if (spec === undefined) {
      try { spec = sbSpecialist(await sbText(job.url)); fetched++; }
      catch (e) { spec = { __err: e.message }; fail++; }
      cache[job.url] = spec;
      if (fetched % 25 === 0) fs.writeFileSync(CACHE, JSON.stringify(cache));
    }
    done++;
    for (const p of job.plans) {
      let verdict = 'NO_SPEC_IN_SB', sbStr = '', conf = '';
      if (spec && !spec.__err) {
        conf = spec.confidence;
        if (spec.type === 'coins') { sbStr = spec.pct + '%'; verdict = (p.specialistCoinsPct === spec.pct) ? 'OK' : (p.specialistCopay != null ? 'TYPE_DIFF' : 'MISMATCH_COINS'); }
        else { sbStr = '$' + spec.amount;
          if (p.specialistCopay === spec.amount) { verdict = 'OK'; }
          // SB states a copay but DB only has coinsurance (no copay set) → TYPE_DIFF, never auto-flip
          else if (p.specialistCopay == null && p.specialistCoinsPct != null) { verdict = 'TYPE_DIFF'; }
          else { verdict = 'MISMATCH'; }
        }
      } else if (spec && spec.__err) { verdict = 'PARSE_FAIL'; sbStr = spec.__err; }
      rows.push({ planId:p.planId, state:p.state, carrier:p.organizationName, cat:p.planCategory,
        db_copay:p.specialistCopay, db_coins:p.specialistCoinsPct, sb:sbStr, confidence:conf, verdict,
        candidates: spec && spec.distinct ? spec.distinct.join('|') : '', evidence: spec && !spec.__err ? spec.evidence : '' });
    }
    if (done % 50 === 0) console.log(`  ...${done}/${jobs.length} PDFs (${fetched} fetched, ${fail} fail)`);
  }
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  for (const p of noSb) rows.push({ planId:p.planId, state:p.state, carrier:p.organizationName, cat:p.planCategory, db_copay:p.specialistCopay, db_coins:p.specialistCoinsPct, sb:'', confidence:'', verdict:'NO_SB', candidates:'', evidence:'' });

  // Belt-and-suspenders: also exclude any evidence containing a % (catches old cache entries
  // with the single-line copay+coinsurance false-clear pattern before the parser fix above).
  const toWrite = rows.filter(r => r.verdict === 'MISMATCH' && r.confidence === 'clear' && /^\$\d+$/.test(r.sb) && !/\d+\s*%/.test(r.evidence));
  let written = 0;
  if (APPLY) for (const r of toWrite) { const amt = parseInt(r.sb.slice(1),10); const u = await prisma.plan.updateMany({ where:{ planId:r.planId, planYear:2026 }, data:{ specialistCopay:amt, specialistCoinsPct:null } }); written += u.count; }

  const headers = ['planId','state','carrier','cat','db_copay','db_coins','sb','confidence','verdict','candidates','evidence'];
  const esc = v => { const s = v==null?'':String(v); return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; };
  fs.writeFileSync('audit-specialist-allcarriers.csv', [headers.join(',')].concat(rows.map(r => headers.map(h => esc(r[h])).join(','))).join('\n'));

  const tally = {}; for (const r of rows) tally[r.verdict] = (tally[r.verdict]||0) + 1;
  console.log('\nverdicts:', JSON.stringify(tally));
  console.log(`CLEAR copay mismatches: ${toWrite.length}${APPLY ? ` | rows written: ${written}` : ' (dry-run — not written)'}`);
  console.log('Review AMBIGUOUS / TYPE_DIFF / MISMATCH_COINS by hand in audit-specialist-allcarriers.csv before trusting them.');
  console.log('-- sample clear mismatches (first 25) --');
  for (const r of toWrite.slice(0,25)) console.log(`  ${r.planId} ${r.carrier} ${r.state}: DB $${r.db_copay} -> SB ${r.sb} | ${r.evidence}`);
  await prisma.$disconnect();
})().catch(async e => { console.error(e); try{await prisma.$disconnect()}catch{}; process.exit(1); });
