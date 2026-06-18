// scripts/audit-ssbci-foodcard.js — find plans whose SB states a food/utilities $ but Food Card is blank.
//   node scripts/audit-ssbci-foodcard.js           # dry-run + CSV (no DB writes)
//   node scripts/audit-ssbci-foodcard.js --apply    # fill clearly-stated amounts (conditional)
const { execFileSync } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const { makePrisma } = require('./prisma-client');
const prisma = makePrisma();
const APPLY = process.argv.includes('--apply');

const PDFTOTEXT = process.platform === 'win32'
  ? 'C:\\Program Files\\Git\\mingw64\\bin\\pdftotext.exe'
  : 'pdftotext';

async function sbText(url){ const res=await fetch(url); if(!res.ok) throw new Error('HTTP '+res.status);
  const buf=Buffer.from(await res.arrayBuffer()); const tmp=path.join(os.tmpdir(),'sb-'+Math.random().toString(36).slice(2)+'.pdf');
  fs.writeFileSync(tmp,buf); try{ return execFileSync(PDFTOTEXT,['-layout',tmp,'-'],{maxBuffer:64*1024*1024}).toString(); } finally{ try{fs.unlinkSync(tmp)}catch{} } }

// pull a food/utilities allowance + period from SB text
function sbFood(text){
  const flat = text.replace(/\s+/g,' ');
  const re = /(?:food|healthy food|utilit|ucard|credit|grocery)[^.$]{0,60}\$\s?(\d[\d,]*)\s*(per|\/|a)?\s*(month|mo|quarter|year|yr)?|\$\s?(\d[\d,]*)\s*(per|\/|a)?\s*(month|mo|quarter|year|yr)?[^.$]{0,40}(?:food|healthy food|utilit|grocery)/i;
  const m = flat.match(re);
  if(!m) return null;
  const amt = parseInt((m[1]||m[4]).replace(/,/g,''),10);
  if(amt === 0) return null; // skip $0 — not a real food allowance
  let per = (m[3]||m[6]||'').toLowerCase();
  // If the period wasn't captured (e.g. "$35 credit every month"), scan the surrounding context
  if(!per){
    const i = flat.search(re);
    const ctx = flat.slice(i, Math.min(flat.length, i+200));
    const pm = ctx.match(/\b(?:per|every|a)\s+(month|mo|quarter|year|yr)\b|\b(month|mo|quarter|year|yr)\b/i);
    if(pm) per = (pm[1]||pm[2]||'').toLowerCase();
  }
  const period = /^month$|^mo$/.test(per)?'month':/^quarter$/.test(per)?'quarter':/^year$|^yr$/.test(per)?'year':null;
  const i = flat.toLowerCase().indexOf((m[0]||'').toLowerCase());
  return { amount: amt, period, evidence: flat.slice(Math.max(0,i-10), i+ (m[0]?m[0].length:0) + 50).trim() };
}

// Period multiplier for annualizing amounts (DB stores annualized; sbVerifiedFoodAmount and foodCardAllowance are both annual)
const MULT = { month: 12, quarter: 4, year: 1 };

(async () => {
  const sample = await prisma.plan.findFirst(); const F = Object.keys(sample); const has = f=>F.includes(f);

  const orClauses = [ has('ssbciOffersFood')?{ssbciOffersFood:true}:null, has('ssbciOffersUtilities')?{ssbciOffersUtilities:true}:null, {planCategory:'DSNP'} ].filter(Boolean);
  const plans = await prisma.plan.findMany({
    where: { planYear: 2026, sbPdfUrl: { not: null }, OR: orClauses },
    select: Object.fromEntries(['planId','organizationName','state','planCategory','sbPdfUrl',
      'foodCardAllowance','foodCardMaxPeriod','ssbciFoodAllowance','sbVerifiedFoodAmount','sbVerifiedFoodPeriod',
      'otcAllowance'].filter(has).map(f=>[f,true])),
    distinct: ['planId'], orderBy: { planId: 'asc' },
  });
  const empty = v => v===null||v===undefined||v===0||v==='';
  const targets = plans.filter(p => empty(p.foodCardAllowance) && empty(p.ssbciFoodAllowance) && empty(p.sbVerifiedFoodAmount));
  console.log(`SSBCI/DSNP food-eligible plans with blank Food Card: ${targets.length} (of ${plans.length}). ${APPLY?'APPLY':'DRY-RUN'}.`);

  const byUrl = new Map();
  for (const p of targets) { const e = byUrl.get(p.sbPdfUrl) || { url:p.sbPdfUrl, plans:[] }; e.plans.push(p); byUrl.set(p.sbPdfUrl, e); }

  const rows=[]; let found=0, none=0, fail=0, written=0, n=0;
  for (const job of byUrl.values()) {
    n++; let food=null, err='';
    try { food = sbFood(await sbText(job.url)); } catch(e){ fail++; err=e.message; }
    for (const p of job.plans) {
      if (food) { found++;
        const annualized = food.period && MULT[food.period] ? food.amount * MULT[food.period] : food.amount;
        rows.push({ planId:p.planId, state:p.state, org:p.organizationName, cat:p.planCategory,
          sb_amount:food.amount, sb_period:food.period||'?', sb_annual:annualized, evidence:food.evidence });
        if (APPLY) {
          const data={};
          // sbVerifiedFoodAmount is highest UI priority and stores annualized value
          if(has('sbVerifiedFoodAmount')) data.sbVerifiedFoodAmount=annualized;
          if(has('sbVerifiedFoodPeriod')&&food.period) data.sbVerifiedFoodPeriod=food.period;
          // foodCardAllowance path (second priority): also annualized
          if(has('foodCardAllowance')) data.foodCardAllowance=annualized;
          if(has('foodCardMaxPeriod')&&food.period) data.foodCardMaxPeriod=food.period;
          // ssbciFoodAllowance: raw (not annualized) per PBP convention
          if(has('ssbciFoodAllowance')) data.ssbciFoodAllowance=food.amount;
          if(has('ssbciIsConditional')) data.ssbciIsConditional=true;
          if(has('ssbciOffersFood')) data.ssbciOffersFood=true;
          const r = await prisma.plan.updateMany({ where:{ planId:p.planId, planYear:2026 }, data }); written+=r.count;
        }
      }
      else { none++; rows.push({ planId:p.planId, state:p.state, org:p.organizationName, cat:p.planCategory, sb_amount:'', sb_period:'', sb_annual:'', evidence: err||'no food/utilities $ found in SB' }); }
    }
    if (n % 50 === 0) console.log(`  ...${n}/${byUrl.size} PDFs`);
  }
  const headers=['planId','state','org','cat','sb_amount','sb_period','sb_annual','evidence'];
  const esc=v=>{const s=v==null?'':String(v); return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;};
  fs.writeFileSync('audit-ssbci-foodcard.csv',[headers.join(',')].concat(rows.map(r=>headers.map(h=>esc(r[h])).join(','))).join('\n'));
  console.log(`SB states an amount: ${found} | none in SB: ${none} | parse-fail ${fail} | wrote audit-ssbci-foodcard.csv`);
  if (APPLY) console.log('Rows written:', written); else console.log('DRY-RUN — review CSV (esp. periods), then --apply.');
  await prisma.$disconnect();
})().catch(async e=>{ console.error(e); try{await prisma.$disconnect()}catch{}; process.exit(1); });
