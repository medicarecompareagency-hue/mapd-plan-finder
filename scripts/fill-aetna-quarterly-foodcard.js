// scripts/fill-aetna-quarterly-foodcard.js — annualize Aetna Extra Supports QUARTERLY amounts onto the Food Card.
// Fills foodCardAllowance (= quarterly x 4) + foodCardMaxPeriod='quarter' for the ~62 chips-only plans.
// DOES NOT set sbVerifiedFoodAmount (OTC-suppression gotcha) or ssbciFoodAllowance (monthly-named field).
// 0/null-only on foodCardAllowance. Re-proves the quarterly amount from the SB (reuses the sweep's cache).
//   node scripts/fill-aetna-quarterly-foodcard.js            # dry-run + CSV
//   node scripts/fill-aetna-quarterly-foodcard.js --apply
const { execFileSync } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const { makePrisma } = require('./prisma-client');
const prisma = makePrisma();
const APPLY = process.argv.includes('--apply');
const CACHE = 'aetna-extra-supports.cache.json'; // reuse the original Aetna sweep cache
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
function norm(s){ return s.replace(/[‐-―−]/g,'-').replace(/ /g,' ').replace(/\s+/g,' '); }
// IDENTICAL to the original Aetna sweep's analyzeWallet (so cache + period detection match).
function analyzeWallet(text){
  const flat = norm(text);
  const named = /extra supports wallet/i.test(flat);
  const converts = /(will change to|replace your otc|replace your over-the-counter|not get any additional funds|added to your current extra benefits card)/i.test(flat);
  if (!named && !converts) return { match:false };
  let i = flat.search(/extra supports wallet|will change to/i); if (i < 0) i = 0;
  const win = flat.slice(Math.max(0,i-220), i+650);
  const cats = {
    food: /healthy foods?|grocer|\bfood\b/i.test(win),
    utilities: /utilit/i.test(win),
    transportation: /transportation|\btransport\b|\brides?\b/i.test(win),
    personal: /personal care|personal service/i.test(win),
    meals: /\bmeals?\b|prepared meals/i.test(win),
  };
  const expandsCount = Object.values(cats).filter(Boolean).length;
  const amtM = win.match(/\$\s?(\d[\d,]*)\s*(monthly|per month|\/ ?mo\b|a month|per quarter|quarterly|per year|annually|a year)/i);
  let amount = null, period = null;
  if (amtM){ amount = parseInt(amtM[1].replace(/,/g,''),10); const u = amtM[2].toLowerCase(); period = /month|mo\b/.test(u) ? 'month' : /quarter/.test(u) ? 'quarter' : 'year'; }
  return { match:true, named, converts, cats, expandsCount, amount, period, evidence: win.slice(0,260) };
}

(async () => {
  const F = Object.keys(await prisma.plan.findFirst()); const has = f => F.includes(f);
  const fields = ['planId','organizationName','state','planCategory','otcAllowance','sbPdfUrl','foodCardAllowance','foodCardMaxPeriod','ssbciIsConditional','ssbciOffersFood'].filter(has);
  // chips-only conditional Aetna plans with no food-card $ yet (CMS import sets 0, not null — accept both)
  const plans = await prisma.plan.findMany({
    where: { planYear:2026, organizationName:{ contains:'Aetna', mode:'insensitive' }, ssbciIsConditional:true, AND:[{ OR:[{foodCardAllowance:null},{foodCardAllowance:0}] }] },
    select: Object.fromEntries(fields.map(f=>[f,true])), distinct:['planId'], orderBy:{ planId:'asc' },
  });
  console.log(`Aetna chips-only (conditional, no food-card $): ${plans.length}. ${APPLY ? 'APPLY' : 'DRY-RUN'}.`);

  const byUrl = new Map();
  for (const p of plans){ if (!p.sbPdfUrl) continue; const e = byUrl.get(p.sbPdfUrl) || { url:p.sbPdfUrl, plans:[] }; e.plans.push(p); byUrl.set(p.sbPdfUrl, e); }
  const jobs = [...byUrl.values()];

  const rows = []; const target = []; let done = 0, fetched = 0, fail = 0, written = 0, notQuarter = 0;
  for (const job of jobs){
    let a = cache[job.url];
    if (a === undefined){ try { a = analyzeWallet(await sbText(job.url)); fetched++; } catch (e){ a = { __err:e.message }; fail++; } cache[job.url] = a; if (fetched % 20 === 0) fs.writeFileSync(CACHE, JSON.stringify(cache)); }
    done++;
    for (const p of job.plans){
      if (a && a.__err){ rows.push({ planId:p.planId, state:p.state, cat:p.planCategory, period:'PARSE_FAIL', quarterly:'', annual:'' }); continue; }
      const isQuarter = a && a.match && a.amount != null && a.period === 'quarter';
      if (!isQuarter){ notQuarter++; rows.push({ planId:p.planId, state:p.state, cat:p.planCategory, period:(a&&a.period)||'(none)', quarterly:'', annual:'', note:'not a clean quarterly $ — left chips-only' }); continue; }
      const annual = a.amount * 4;
      target.push({ planId:p.planId, state:p.state, cat:p.planCategory, quarterly:a.amount, annual, food:a.cats.food, evidence:a.evidence });
      rows.push({ planId:p.planId, state:p.state, cat:p.planCategory, period:'quarter', quarterly:a.amount, annual, evidence:a.evidence });
    }
    if (done % 40 === 0) console.log(`  ...${done}/${jobs.length} PDFs`);
  }
  fs.writeFileSync(CACHE, JSON.stringify(cache));

  const headers = ['planId','state','cat','period','quarterly','annual','note','evidence'];
  const esc = v => { const s = v==null?'':String(v); return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; };
  fs.writeFileSync('aetna-quarterly-foodcard.csv', [headers.join(',')].concat(rows.map(r => headers.map(h => esc(r[h])).join(','))).join('\n'));

  console.log(`\nQuarterly -> Food Card targets: ${target.length} (expected ~62) | not-clean-quarterly left chips-only: ${notQuarter} | parse-fail ${fail}.`);
  console.log('planId | state | cat | $quarterly -> $annual (foodCardMaxPeriod=quarter) | SB evidence');
  for (const t of target) console.log(`  ${t.planId} | ${t.state} | ${t.cat} | $${t.quarterly}/qtr -> $${t.annual}/yr | ${t.evidence}`);
  if (target.length === 0){ console.log('Nothing to fill.'); await prisma.$disconnect(); return; }
  if (target.length > 90){ console.error(`STOP: ${target.length} far above the expected ~62 — re-check before writing. No writes.`); await prisma.$disconnect(); process.exit(2); }
  if (!APPLY){ console.log('\nDRY-RUN — no writes. Confirm Phase 0 gate (cell renders /quarter), review aetna-quarterly-foodcard.csv, then --apply.'); await prisma.$disconnect(); return; }

  for (const t of target){
    const data = { foodCardAllowance: t.annual };
    if (has('foodCardMaxPeriod')) data.foodCardMaxPeriod = 'quarter';
    if (t.food && has('ssbciOffersFood')) data.ssbciOffersFood = true;
    const u = await prisma.plan.updateMany({ where:{ planId:t.planId, planYear:2026, AND:[{ OR:[{foodCardAllowance:null},{foodCardAllowance:0}] }] }, data }); written += u.count;
  }
  console.log(`\nApplied. planIds ${target.length} | county rows written ${written}. (sbVerifiedFoodAmount + ssbciFoodAllowance deliberately NOT set.)`);
  await prisma.$disconnect();
})().catch(async e => { console.error(e); try{await prisma.$disconnect()}catch{}; process.exit(1); });
