// scripts/sweep-converting-wallets.js — Humana/UHC/Wellcare "OTC wallet converts to a spending wallet on
// chronic qualification" -> Food Card $ + Chronic-only chips. Mirrors the Aetna Extra Supports / UHC H2802-64
// treatment. CRITICAL: does NOT set sbVerifiedFoodAmount (would trip OTC suppression — see header note).
//   node scripts/sweep-converting-wallets.js                      # dry-run: convention gate + matches + CSV
//   node scripts/sweep-converting-wallets.js --carrier "Humana"   # restrict to one carrier
//   node scripts/sweep-converting-wallets.js --apply              # write
const { execFileSync } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const { makePrisma } = require('./prisma-client');
const prisma = makePrisma();
const APPLY = process.argv.includes('--apply');
const ci = process.argv.indexOf('--carrier'); const ONE = ci >= 0 ? process.argv[ci+1] : null;
const CARRIERS = ONE ? [ONE] : ['Humana', 'UnitedHealth', 'Wellcare'];  // UnitedHealth covers UnitedHealthcare
const CACHE = 'converting-wallets.cache.json';
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

// Generic converting-wallet detector. Anchors on the CONVERSION verb (not a bare wallet header), so plans
// whose header has no category list still match. Carrier-agnostic phrasing.
function analyzeWallet(text){
  const flat = norm(text);
  const convertRe = /(will change to|changes to|converts? to|will convert|replace your (?:otc|over-the-counter)|not get any additional funds|no additional funds|added to your current extra benefits card|repurpos)/i;
  const namedRe = /(extra supports wallet|spending (?:wallet|account)|flex(?:ible)? (?:card|wallet|benefit)|healthy (?:food|groceries) (?:card|benefit)|special supplemental benefit)/i;
  const converts = convertRe.test(flat);
  const named = namedRe.test(flat);
  if (!converts && !named) return { match:false };
  let i = flat.search(convertRe); if (i < 0) i = flat.search(namedRe); if (i < 0) i = 0;
  const win = flat.slice(Math.max(0,i-220), i+650);
  const cats = {
    food: /healthy foods?|grocer|\bfood\b/i.test(win),
    utilities: /utilit/i.test(win),
    transportation: /transportation|\btransport\b|\brides?\b/i.test(win),
    personal: /personal care|personal service/i.test(win),
    meals: /\bmeals?\b|prepared meals/i.test(win),
  };
  const expandsCount = Object.values(cats).filter(Boolean).length;
  const conditional = /after qualifying|qualified members?|once you qualify|if you qualify|chronic/i.test(win);
  const amtM = win.match(/\$\s?(\d[\d,]*)\s*(monthly|per month|\/ ?mo\b|a month|per quarter|quarterly|per year|annually|a year)/i);
  let amount = null, period = null;
  if (amtM){ amount = parseInt(amtM[1].replace(/,/g,''),10); const u = amtM[2].toLowerCase(); period = /month|mo\b/.test(u) ? 'month' : /quarter/.test(u) ? 'quarter' : 'year'; }
  return { match:true, named, converts, conditional, cats, expandsCount, amount, period, evidence: win.slice(0,260) };
}
function buildNote(a){
  const labels=[]; if(a.cats.food)labels.push('healthy food'); if(a.cats.utilities)labels.push('utilities'); if(a.cats.transportation)labels.push('transportation'); if(a.cats.personal)labels.push('personal care'); if(a.cats.meals)labels.push('meals');
  const amt = a.amount && a.period==='month' ? `Up to $${a.amount}/mo ` : '';
  return `${amt}for ${labels.join(', ')} after you qualify with a chronic condition (SSBCI) — your OTC wallet repurposed, not additional funds. Confirm eligibility in the plan's Summary of Benefits.`;
}

(async () => {
  const sample = await prisma.plan.findFirst(); const F = Object.keys(sample); const has = f => F.includes(f);

  // ---- CONVENTION GATE: mirror approved UHC H2802-64 ----
  const refSel = ['planId','otcAllowance','otcMaxPeriod','foodCardAllowance','foodCardMaxPeriod','sbVerifiedFoodAmount','sbVerifiedFoodPeriod','ssbciFoodAllowance','ssbciIsConditional','ssbciIsStandalone','ssbciOffersFood'].filter(has);
  const ref = await prisma.plan.findFirst({ where:{ OR:[{planId:'H2802-64'},{planId:'H2802-064'}], planYear:2026 }, select:Object.fromEntries(refSel.map(f=>[f,true])) });
  console.log('REF H2802-64 (approved food-card treatment to mirror):\n ', JSON.stringify(ref));
  console.log('  expected: foodCardAllowance = ANNUALIZED, foodCardMaxPeriod = month, ssbciFoodAllowance = MONTHLY, ssbciIsConditional = true.');
  console.log('  THIS SCRIPT DELIBERATELY DOES NOT SET sbVerifiedFoodAmount (OTC-suppression gotcha). >> If REF disagrees with the convention, STOP and align before --apply.\n');

  const fields = ['planId','organizationName','state','planCategory','otcAllowance','sbPdfUrl','foodCardAllowance','foodCardMaxPeriod','ssbciFoodAllowance','ssbciOffersFood','ssbciOffersUtilities','ssbciOffersTransportation','ssbciOffersPersonalServices','ssbciOffersMeals','ssbciIsConditional','ssbciIsStandalone'].filter(has);
  const orFilter = CARRIERS.map(c => ({ organizationName: { contains: c, mode: 'insensitive' } }));
  const plans = await prisma.plan.findMany({ where:{ planYear:2026, OR: orFilter }, select:Object.fromEntries(fields.map(f=>[f,true])), distinct:['planId'], orderBy:{ planId:'asc' } });
  const orgSet = [...new Set(plans.map(p=>p.organizationName))];
  console.log(`Carriers matched (${CARRIERS.join(', ')}) -> orgs: ${JSON.stringify(orgSet)}`);
  console.log(`Plans in scope: ${plans.length}. ${APPLY ? 'APPLY' : 'DRY-RUN'}.`);

  const byUrl = new Map(); const noSb = [];
  for (const p of plans){ if (!p.sbPdfUrl){ noSb.push(p); continue; } const e = byUrl.get(p.sbPdfUrl) || { url:p.sbPdfUrl, plans:[] }; e.plans.push(p); byUrl.set(p.sbPdfUrl, e); }
  const jobs = [...byUrl.values()];

  const rows = []; let done = 0, fetched = 0, fail = 0, written = 0, matched = 0, amtReview = 0, clobberSkip = 0;
  for (const job of jobs){
    let a = cache[job.url];
    if (a === undefined){ try { a = analyzeWallet(await sbText(job.url)); fetched++; } catch (e){ a = { __err:e.message }; fail++; } cache[job.url] = a; if (fetched % 20 === 0) fs.writeFileSync(CACHE, JSON.stringify(cache)); }
    done++;
    for (const p of job.plans){
      if (a && a.__err){ rows.push({ planId:p.planId, carrier:p.organizationName, state:p.state, cat:p.planCategory, otc:p.otcAllowance, match:'PARSE_FAIL', categories:a.__err, monthly:'', foodCardSet:'' }); continue; }
      if (!a || !a.match || a.expandsCount === 0 || !a.conditional){ rows.push({ planId:p.planId, carrier:p.organizationName, state:p.state, cat:p.planCategory, otc:p.otcAllowance, match:'no', categories:'', monthly:'', foodCardSet:'' }); continue; }
      matched++;
      const catList = Object.entries(a.cats).filter(([k,v]) => v).map(([k]) => k).join('+');
      const cleanMonthly = (a.amount != null && a.period === 'month') ? a.amount : null;
      if (cleanMonthly == null) amtReview++;
      // clobber guard: don't overwrite an existing, DIFFERENT foodCardAllowance with the converting amount
      const annual = cleanMonthly != null ? cleanMonthly * 12 : null;
      const existingFc = p.foodCardAllowance;
      const wouldClobber = cleanMonthly != null && existingFc != null && Math.abs(existingFc - annual) > 1;
      let foodCardSet = cleanMonthly != null ? (wouldClobber ? 'SKIP-existing-differs' : 'yes') : 'chips-only(review $)';
      if (wouldClobber) clobberSkip++;
      rows.push({ planId:p.planId, carrier:p.organizationName, state:p.state, cat:p.planCategory, otc:p.otc ?? p.otcAllowance, match:'YES', categories:catList, monthly: cleanMonthly ?? `(unclear: ${a.amount}/${a.period})`, foodCardSet, existingFood: existingFc ?? '', evidence:a.evidence });
      if (APPLY){
        const data = { ssbciIsConditional: true };
        if (has('ssbciIsStandalone')) data.ssbciIsStandalone = false;
        if (has('ssbciConditionNote')) data.ssbciConditionNote = buildNote(a);
        if (a.cats.food && has('ssbciOffersFood')) data.ssbciOffersFood = true;
        if (a.cats.utilities && has('ssbciOffersUtilities')) data.ssbciOffersUtilities = true;
        if (a.cats.transportation && has('ssbciOffersTransportation')) data.ssbciOffersTransportation = true;
        if (a.cats.personal && has('ssbciOffersPersonalServices')) data.ssbciOffersPersonalServices = true;
        if (a.cats.meals && has('ssbciOffersMeals')) data.ssbciOffersMeals = true;
        // Food Card $ — annualized on foodCardAllowance, monthly on ssbciFoodAllowance, period=month.
        // DO NOT set sbVerifiedFoodAmount (OTC-suppression gotcha). Skip if it would clobber a different existing value.
        if (cleanMonthly != null && !wouldClobber){
          if (has('foodCardAllowance')) data.foodCardAllowance = annual;
          if (has('foodCardMaxPeriod')) data.foodCardMaxPeriod = 'month';
          if (has('ssbciFoodAllowance')) data.ssbciFoodAllowance = cleanMonthly;
        }
        const u = await prisma.plan.updateMany({ where:{ planId:p.planId, planYear:2026 }, data }); written += u.count;
      }
    }
    if (done % 40 === 0) console.log(`  ...${done}/${jobs.length} PDFs (${matched} matched)`);
  }
  fs.writeFileSync(CACHE, JSON.stringify(cache));

  const headers = ['planId','carrier','state','cat','otc','match','categories','monthly','foodCardSet','existingFood','evidence'];
  const esc = v => { const s = v==null?'':String(v); return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; };
  fs.writeFileSync('converting-wallets.csv', [headers.join(',')].concat(rows.map(r => headers.map(h => esc(r[h])).join(','))).join('\n'));

  console.log(`\nMatched (converting wallet): ${matched} | clean monthly $ -> Food Card: ${matched - amtReview - clobberSkip} | chips-only (amount review): ${amtReview} | skipped existing-differs: ${clobberSkip} | parse-fail ${fail} | no-SB ${noSb.length}`);
  const byCarrier = {}; for (const r of rows.filter(r=>r.match==='YES')) byCarrier[r.carrier] = (byCarrier[r.carrier]||0)+1;
  console.log('matched by carrier:', JSON.stringify(byCarrier));
  const catYes = {}; for (const r of rows.filter(r=>r.match==='YES')) catYes[r.cat] = (catYes[r.cat]||0)+1;
  console.log('matched by plan category:', JSON.stringify(catYes));
  if (APPLY) console.log('County rows written:', written); else console.log('DRY-RUN — no writes. Confirm REF + review converting-wallets.csv, then --apply.');
  console.log('-- sample matches (up to 25) --');
  for (const r of rows.filter(r => r.match === 'YES').slice(0,25)) console.log(`  ${r.planId} ${r.carrier} ${r.state} ${r.cat} | OTC ${r.otc} | ${r.categories} | $${r.monthly}/mo -> FoodCard ${r.foodCardSet}`);
  await prisma.$disconnect();
})().catch(async e => { console.error(e); try{await prisma.$disconnect()}catch{}; process.exit(1); });
