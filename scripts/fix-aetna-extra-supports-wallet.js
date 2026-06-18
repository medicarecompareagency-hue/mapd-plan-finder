// scripts/fix-aetna-extra-supports-wallet.js — Aetna Extra Supports Wallet -> Food Card $ + Chronic-only chips.
//   node scripts/fix-aetna-extra-supports-wallet.js            # dry-run: convention check + matches + CSV
//   node scripts/fix-aetna-extra-supports-wallet.js --apply    # write (mirrors the UHC H2802-64 fields)
const { execFileSync } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const { makePrisma } = require('./prisma-client');
const prisma = makePrisma();
const APPLY = process.argv.includes('--apply');
const CACHE = 'aetna-extra-supports.cache.json';
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE,'utf8')) : {};

async function sbText(url){
  const res = await fetch(url); if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = path.join(os.tmpdir(), 'sb-' + Math.random().toString(36).slice(2) + '.pdf');
  fs.writeFileSync(tmp, buf);
  try {
    const pyScript = 'import pdfplumber,sys\nsys.stdout.reconfigure(encoding="utf-8",errors="replace")\nwith pdfplumber.open(sys.argv[1]) as pdf:\n  print("\\n".join(page.extract_text(layout=True) or "" for page in pdf.pages))';
    return execFileSync('python', ['-c', pyScript, tmp], { maxBuffer: 64*1024*1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }).toString('utf-8');
  }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}
function norm(s){ return s.replace(/[‐-―−]/g,'-').replace(/ /g,' ').replace(/\s+/g,' '); }

function analyzeWallet(text){
  const flat = norm(text);
  const named = /extra supports wallet/i.test(flat);
  const converts = /(will change to|replace your otc|replace your over-the-counter|not get any additional funds|added to your current extra benefits card)/i.test(flat);
  if (!named && !converts) return { match:false };
  // Prefer "will change to" as the window anchor — it sits adjacent to the category list.
  // "Extra Supports Wallet" often appears first in an eligibility-header section without categories.
  let i = flat.search(/will change to/i);
  if (i < 0) i = flat.search(/extra supports wallet/i);
  if (i < 0) i = 0;
  const win = flat.slice(Math.max(0,i-300), i+900);
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
  return { match:true, named, converts, cats, expandsCount, conditional, amount, period, evidence: win.slice(0,260) };
}
function buildNote(a){
  const labels=[]; if(a.cats.food)labels.push('healthy food'); if(a.cats.utilities)labels.push('utilities'); if(a.cats.transportation)labels.push('transportation'); if(a.cats.personal)labels.push('personal care'); if(a.cats.meals)labels.push('meals');
  const amt = a.amount && a.period==='month' ? `Up to $${a.amount}/mo ` : '';
  return `${amt}for ${labels.join(', ')} after you qualify with a chronic condition (SSBCI) — your OTC wallet repurposed, not additional funds. Confirm eligibility in the plan's Summary of Benefits.`;
}

(async () => {
  const sample = await prisma.plan.findFirst(); const F = Object.keys(sample); const has = f => F.includes(f);

  // ---- CONVENTION CHECK: mirror the approved UHC example H2802-64 exactly ----
  const refSel = ['planId','otcAllowance','otcMaxPeriod','foodCardAllowance','foodCardMaxPeriod','sbVerifiedFoodAmount','sbVerifiedFoodPeriod','ssbciFoodAllowance','ssbciIsConditional','ssbciIsStandalone','ssbciOffersFood','ssbciOffersUtilities'].filter(has);
  const ref = await prisma.plan.findFirst({ where:{ OR:[{planId:'H2802-64'},{planId:'H2802-064'}], planYear:2026 }, select:Object.fromEntries(refSel.map(f=>[f,true])) });
  console.log('REF H2802-64 (approved UHC food-card treatment to mirror):\n ', JSON.stringify(ref));
  console.log('  expected: foodCardAllowance & sbVerifiedFoodAmount = ANNUALIZED, *Period = month, ssbciFoodAllowance = MONTHLY, ssbciIsConditional = true.');
  console.log('  >> If REF does not match that, STOP and align this script to REF before --apply.\n');

  const fields = ['planId','organizationName','state','planCategory','otcAllowance','otcMaxPeriod','sbPdfUrl','foodCardAllowance','sbVerifiedFoodAmount','ssbciFoodAllowance','ssbciOffersFood','ssbciOffersUtilities','ssbciOffersTransportation','ssbciOffersPersonalServices','ssbciOffersMeals','ssbciIsConditional','ssbciIsStandalone'].filter(has);
  const plans = await prisma.plan.findMany({ where:{ planYear:2026, organizationName:{ contains:'Aetna', mode:'insensitive' } }, select:Object.fromEntries(fields.map(f=>[f,true])), distinct:['planId'], orderBy:{ planId:'asc' } });
  console.log(`Aetna 2026 plans: ${plans.length}. ${APPLY ? 'APPLY' : 'DRY-RUN'}.`);

  const byUrl = new Map(); const noSb = [];
  for (const p of plans){ if (!p.sbPdfUrl){ noSb.push(p); continue; } const e = byUrl.get(p.sbPdfUrl) || { url:p.sbPdfUrl, plans:[] }; e.plans.push(p); byUrl.set(p.sbPdfUrl, e); }
  const jobs = [...byUrl.values()];

  const rows = []; let done = 0, fetched = 0, fail = 0, written = 0, matched = 0, amtReview = 0;
  for (const job of jobs){
    let a = cache[job.url];
    if (a === undefined || a.__err){ try { a = analyzeWallet(await sbText(job.url)); fetched++; } catch (e){ a = { __err:e.message }; fail++; } cache[job.url] = a; if (fetched % 20 === 0) fs.writeFileSync(CACHE, JSON.stringify(cache)); }
    done++;
    for (const p of job.plans){
      if (a && a.__err){ rows.push({ planId:p.planId, state:p.state, cat:p.planCategory, otc:p.otcAllowance, match:'PARSE_FAIL', categories:a.__err, monthly:'', foodCardSet:'' }); continue; }
      if (!a || !a.match || a.expandsCount === 0){ rows.push({ planId:p.planId, state:p.state, cat:p.planCategory, otc:p.otcAllowance, match:'no', categories:'', monthly:'', foodCardSet:'' }); continue; }
      matched++;
      const catList = Object.entries(a.cats).filter(([k,v]) => v).map(([k]) => k).join('+');
      const cleanMonthly = (a.amount != null && a.period === 'month') ? a.amount : null;
      if (cleanMonthly == null) amtReview++;
      rows.push({ planId:p.planId, state:p.state, cat:p.planCategory, otc:p.otcAllowance, match:'YES', categories:catList, monthly: cleanMonthly ?? `(amount/period unclear: ${a.amount}/${a.period})`, foodCardSet: cleanMonthly != null ? 'yes' : 'chips-only(review $)', evidence:a.evidence });
      if (APPLY){
        const data = { ssbciIsConditional: true };
        if (has('ssbciIsStandalone')) data.ssbciIsStandalone = false;
        if (has('ssbciConditionNote')) data.ssbciConditionNote = buildNote(a);
        if (a.cats.food && has('ssbciOffersFood')) data.ssbciOffersFood = true;
        if (a.cats.utilities && has('ssbciOffersUtilities')) data.ssbciOffersUtilities = true;
        if (a.cats.transportation && has('ssbciOffersTransportation')) data.ssbciOffersTransportation = true;
        if (a.cats.personal && has('ssbciOffersPersonalServices')) data.ssbciOffersPersonalServices = true;
        if (a.cats.meals && has('ssbciOffersMeals')) data.ssbciOffersMeals = true;
        // Food Card $ — set foodCardAllowance (annualized) + ssbciFoodAllowance (monthly).
        // Do NOT set sbVerifiedFoodAmount: the Aetna Extra Supports Wallet IS the OTC wallet
        // repurposed, so sbVerifiedFoodAmount === otcAllowance. Setting it would trigger the
        // effectiveOtc suppression (gated && sbFood===direct), hiding OTC from non-qualifying
        // members. foodCardAllowance alone is sufficient for effectiveFoodCard priority 2.
        if (cleanMonthly != null){
          const annual = cleanMonthly * 12;
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

  const headers = ['planId','state','cat','otc','match','categories','monthly','foodCardSet','evidence'];
  const esc = v => { const s = v==null?'':String(v); return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; };
  fs.writeFileSync('aetna-extra-supports.csv', [headers.join(',')].concat(rows.map(r => headers.map(h => esc(r[h])).join(','))).join('\n'));

  console.log(`\nAetna matched (Extra Supports Wallet): ${matched} | with clean monthly $ -> Food Card: ${matched - amtReview} | chips-only (amount needs review): ${amtReview} | parse-fail ${fail} | no-SB ${noSb.length}`);
  if (APPLY) console.log('County rows written:', written); else console.log('DRY-RUN — no writes. Confirm REF convention + review aetna-extra-supports.csv, then --apply.');
  const h = rows.find(r => r.planId === 'H1609-79'); console.log('H1609-79:', h ? JSON.stringify(h) : 'NOT in Aetna set — check planId');
  // ---- coverage by plan category + Aetna DSNP plans that did NOT match (catch wallets phrased differently) ----
  const catYes = {}; for (const r of rows.filter(r => r.match === 'YES')) catYes[r.cat] = (catYes[r.cat] || 0) + 1;
  console.log('matched by plan category:', JSON.stringify(catYes));
  const isDsnp = c => /d-?snp|dual/i.test(String(c));
  const dsnpAll = rows.filter(r => isDsnp(r.cat));
  const dsnpMissed = dsnpAll.filter(r => r.match !== 'YES');
  console.log(`Aetna DSNP plans: ${dsnpAll.length} total | matched ${dsnpAll.length - dsnpMissed.length} | NOT matched ${dsnpMissed.length}`);
  if (dsnpMissed.length){ console.log('  DSNP NOT matched (review — SB may phrase the wallet differently, or it genuinely has none):'); for (const r of dsnpMissed) console.log(`    ${r.planId} ${r.state} ${r.cat} (match=${r.match})`); }
  console.log('-- sample matches (up to 20) --');
  for (const r of rows.filter(r => r.match === 'YES').slice(0,20)) console.log(`  ${r.planId} ${r.state} ${r.cat} | OTC ${r.otc} | ${r.categories} | $${r.monthly}/mo -> FoodCard ${r.foodCardSet}`);
  await prisma.$disconnect();
})().catch(async e => { console.error(e); try{await prisma.$disconnect()}catch{}; process.exit(1); });
