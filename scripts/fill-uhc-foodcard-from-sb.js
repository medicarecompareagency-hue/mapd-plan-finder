// scripts/fill-uhc-foodcard-from-sb.js — extract a monthly food/OTC credit from each SB and annualize into
// foodCardAllowance for UHC/Wellcare converting wallets with foodCardAllowance 0/null. Handles both the clean
// "$X/month" DSNP credits and the "$X credit every month" CSNP credits; excludes hearing/dental/vision noise.
// NULL/0-only on foodCardAllowance. Does NOT set sbVerifiedFoodAmount. Reuses the diagnostic's text cache.
//   node scripts/fill-uhc-foodcard-from-sb.js            # dry-run + EXPECTED-14 sanity check + CSV
//   node scripts/fill-uhc-foodcard-from-sb.js --apply
const { execFileSync } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const { makePrisma } = require('./prisma-client');
const prisma = makePrisma();
const APPLY = process.argv.includes('--apply');
const ci = process.argv.indexOf('--carrier'); const ONE = ci >= 0 ? process.argv[ci+1] : null;
const CARRIERS = ONE ? [ONE] : ['UnitedHealth', 'Wellcare'];
const CACHE = 'uhc-zero-foodcard-sbtext.cache.json';
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE,'utf8')) : {};

const PDFTOTEXT = process.platform === 'win32'
  ? 'C:\\Program Files\\Git\\mingw64\\bin\\pdftotext.exe'
  : 'pdftotext';

// The 14 clean-monthly DSNPs from the diagnostic — used ONLY as a sanity check that the extractor reproduces them.
const EXPECTED = { 'H0074-4':77,'H0174-22':69,'H0174-23':112,'H0174-26':114,'H1032-202':50,'H1112-47':91,'H1416-35':173,'H1416-81':72,'H2491-25':90,'H2491-30':40,'H3975-4':128,'H4537-4':122,'H7518-3':130,'H9730-11':80 };

async function sbText(url){
  const res = await fetch(url); if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = path.join(os.tmpdir(), 'sb-' + Math.random().toString(36).slice(2) + '.pdf');
  fs.writeFileSync(tmp, buf);
  try { return execFileSync(PDFTOTEXT, ['-layout', tmp, '-'], { maxBuffer: 64*1024*1024 }).toString(); }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}
function norm(s){ return s.replace(/[‐-―−]/g,'-').replace(/ /g,' ').replace(/\s+/g,' '); }

const FOODCTX = /healthy foods?|grocer(?:y|ies)?|\bfood\b|over-the-counter|\botc\b|\bpreload/i;
const EXCLUDE = /hearing|dental|\bvision\b|eyewear|eyeglass|\bpremium\b|give ?back|\bpart b\b|\breward|fitness|\brent\b|mortgage|transportation|\bspecial supplemental\b/i;
// $N, then up to 4 filler words (non-greedy), then a MONTHLY cadence phrase. Catches "$40 credit every month".
const MONTHLY_RE = /\$\s?(\d[\d,]*)\b(?:\s+[a-z()\/-]+){0,4}?\s*(per month|every month|each month|a month|monthly|\/ ?mo(?:nth)?\b)/i;

function extractMonthlyFood(text){
  const lines = text.split(/\r?\n/).map(l => norm(l).trim()).filter(Boolean);
  const found = []; const ev = [];
  for (let i = 0; i < lines.length; i++){
    if (!FOODCTX.test(lines[i]) || EXCLUDE.test(lines[i])) continue;
    let m = lines[i].match(MONTHLY_RE);
    if (!m){ const blk = lines[i] + ' ' + (lines[i+1] || ''); if (!EXCLUDE.test(blk)) m = blk.match(MONTHLY_RE); }
    if (m){ const amt = parseInt(m[1].replace(/,/g,''),10); if (amt >= 10 && amt <= 400){ found.push(amt); if (ev.length < 3) ev.push(lines[i].slice(0,170)); } }
  }
  const uniq = [...new Set(found)];
  return { amounts: uniq, evidence: ev };
}

(async () => {
  const F = Object.keys(await prisma.plan.findFirst()); const has = f => F.includes(f);
  const sel = ['planId','organizationName','state','planCategory','otcAllowance','foodCardAllowance','ssbciIsConditional','sbPdfUrl'].filter(has);
  const orFilter = CARRIERS.map(c => ({ organizationName: { contains: c, mode: 'insensitive' } }));
  const where = { planYear: 2026, OR: orFilter, ssbciIsConditional: true, AND: [{ OR: [{ foodCardAllowance: 0 }, { foodCardAllowance: null }] }] };
  const plans = await prisma.plan.findMany({ where, select: Object.fromEntries(sel.map(f=>[f,true])), distinct: ['planId'], orderBy: { planId: 'asc' } });
  console.log(`Target pool (UHC/Wellcare converting wallets, foodCardAllowance 0/null): ${plans.length}. ${APPLY ? 'APPLY' : 'DRY-RUN'}.`);

  const byUrl = new Map(); const noSb = [];
  for (const p of plans){ if (!p.sbPdfUrl){ noSb.push(p); continue; } const e = byUrl.get(p.sbPdfUrl) || { url:p.sbPdfUrl, plans:[] }; e.plans.push(p); byUrl.set(p.sbPdfUrl, e); }
  const jobs = [...byUrl.values()];

  const rows = []; const target = []; const review = []; let done = 0, fetched = 0, fail = 0, none = 0, written = 0;
  for (const job of jobs){
    let text = cache[job.url];
    if (text === undefined){ try { text = await sbText(job.url); fetched++; } catch (e){ text = null; fail++; } cache[job.url] = text; if (fetched % 15 === 0) fs.writeFileSync(CACHE, JSON.stringify(cache)); }
    done++;
    for (const p of job.plans){
      if (!text){ rows.push({ planId:p.planId, carrier:p.organizationName, state:p.state, cat:p.planCategory, monthly:'', annual:'', verdict:'FETCH_FAIL', evidence:'' }); continue; }
      const a = extractMonthlyFood(text);
      if (a.amounts.length === 1){
        const monthly = a.amounts[0];
        target.push({ planId:p.planId, carrier:p.organizationName, state:p.state, cat:p.planCategory, monthly, annual: monthly*12, evidence:a.evidence.join(' || ') });
        rows.push({ planId:p.planId, carrier:p.organizationName, state:p.state, cat:p.planCategory, monthly, annual: monthly*12, verdict:'WRITE', evidence:a.evidence.join(' || ') });
      } else if (a.amounts.length > 1){
        review.push({ planId:p.planId, amounts:a.amounts });
        rows.push({ planId:p.planId, carrier:p.organizationName, state:p.state, cat:p.planCategory, monthly:a.amounts.join('/'), annual:'', verdict:'REVIEW_MULTI', evidence:a.evidence.join(' || ') });
      } else { none++; rows.push({ planId:p.planId, carrier:p.organizationName, state:p.state, cat:p.planCategory, monthly:'', annual:'', verdict:'NONE_left_$0', evidence:'' }); }
    }
    if (done % 20 === 0) console.log(`  ...${done}/${jobs.length} PDFs`);
  }
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  for (const p of noSb) rows.push({ planId:p.planId, carrier:p.organizationName, state:p.state, cat:p.planCategory, monthly:'', annual:'', verdict:'NO_SB', evidence:'' });

  const headers = ['planId','carrier','state','cat','monthly','annual','verdict','evidence'];
  const esc = v => { const s = v==null?'':String(v); return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; };
  fs.writeFileSync('fill-uhc-foodcard-from-sb.csv', [headers.join(',')].concat(rows.map(r => headers.map(h => esc(r[h])).join(','))).join('\n'));

  // ---- EXPECTED-14 sanity check ----
  console.log('\nEXPECTED-14 sanity (extractor must reproduce the diagnostic\'s clean monthly amounts):');
  let okE = 0, badE = 0;
  for (const [pid, amt] of Object.entries(EXPECTED)){
    const t = target.find(x => x.planId === pid);
    if (t && t.monthly === amt){ okE++; }
    else { badE++; console.log(`  MISMATCH ${pid}: expected $${amt}/mo, got ${t ? '$'+t.monthly : '(not extracted: '+(rows.find(r=>r.planId===pid)?.verdict||'absent')+')'}`); }
  }
  console.log(`  EXPECTED-14: ${okE} match, ${badE} mismatch.`);

  const byCat = {}; for (const t of target) byCat[t.cat] = (byCat[t.cat]||0)+1;
  console.log(`\nWRITE targets: ${target.length} | REVIEW_MULTI: ${review.length} | NONE (left $0): ${none} | parse/fetch-fail: ${fail} | no-SB: ${noSb.length}`);
  console.log('WRITE by plan category:', JSON.stringify(byCat));
  console.log('\n-- WRITE targets (eyeball monthly vs evidence) --');
  for (const t of target) console.log(`  ${t.planId} ${t.carrier} ${t.state} ${t.cat}: $${t.monthly}/mo -> $${t.annual}/yr  [${t.evidence.slice(0,130)}]`);
  if (review.length){ console.log('\n-- REVIEW_MULTI (multiple distinct amounts — NOT written, decide manually) --'); for (const r of review) console.log(`  ${r.planId}: ${r.amounts.map(a=>'$'+a).join(', ')}`); }

  if (badE > 0){ console.error(`\nSTOP: ${badE} of the EXPECTED-14 didn't reproduce — the extractor regressed vs the diagnostic. No writes. Fix the regex/context before --apply.`); await prisma.$disconnect(); process.exit(2); }
  if (target.length === 0){ console.log('\nNothing to write.'); await prisma.$disconnect(); return; }
  if (target.length > 60){ console.error(`\nSTOP: ${target.length} WRITE targets is above the sane ceiling (~14 DSNP + ~20 CSNP) — likely false positives. No writes; review the CSV.`); await prisma.$disconnect(); process.exit(2); }
  if (!APPLY){ console.log('\nDRY-RUN — no writes. Confirm EXPECTED-14 all match, eyeball the WRITE list + REVIEW_MULTI, then --apply.'); await prisma.$disconnect(); return; }

  for (const t of target){
    const data = { foodCardAllowance: t.annual };
    if (has('foodCardMaxPeriod')) data.foodCardMaxPeriod = 'month';
    if (has('ssbciFoodAllowance')) data.ssbciFoodAllowance = t.monthly;
    if (has('ssbciOffersFood')) data.ssbciOffersFood = true;
    const u = await prisma.plan.updateMany({ where:{ planId:t.planId, planYear:2026, OR:[{foodCardAllowance:0},{foodCardAllowance:null}] }, data }); written += u.count;
  }
  console.log(`\nApplied. planIds ${target.length} | county rows written ${written}. (sbVerifiedFoodAmount NOT set; otcAllowance untouched.)`);
  await prisma.$disconnect();
})().catch(async e => { console.error(e); try{await prisma.$disconnect()}catch{}; process.exit(1); });
