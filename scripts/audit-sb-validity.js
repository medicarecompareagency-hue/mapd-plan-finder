// scripts/audit-sb-validity.js — READ-ONLY. Validates every plan's stored SB against the strict rule.
const fs=require('fs'), os=require('os'), path=require('path');
const { execFileSync }=require('child_process');
const { makePrisma }=require('./prisma-client');
const prisma=makePrisma();
const PROG='sb-validation-progress.json', OUT='sb-validation-results.csv';
const CONC=5;

function csvEsc(v){ if(v==null) return ''; const s=String(v); return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; }
function pdftext(buf){
  const tmp=path.join(os.tmpdir(),'sbchk_'+Math.random().toString(36).slice(2)+'.pdf');
  try{ fs.writeFileSync(tmp,buf); return execFileSync('pdftotext',['-layout','-f','1','-l','2',tmp,'-'],{maxBuffer:20*1024*1024}).toString('utf8'); }
  catch{ return ''; } finally{ try{fs.unlinkSync(tmp)}catch{} }
}
function idVariants(planId){
  // planId like "H2802-044" or "H2802-44" or "R0759-1"; build flexible matchers.
  // Extend to handle any letter prefix (R/S for RPPO/PFFS as well as H).
  const m=String(planId).match(/([A-Za-z]\d{4})\D*(\d{1,3})/); if(!m) return [String(planId)];
  const c=m[1].toUpperCase(), p=m[2], p3=p.padStart(3,'0'), p2=String(parseInt(p,10));
  return [c+'-'+p3, c+'-'+p2, c+' '+p3, c+p3, c+'-'+p];
}
function classify(planId, buf, txt){
  if(!buf || buf.length<200) return ['BAD','too_short'];
  if(buf.slice(0,5).toString('latin1')!=='%PDF-') return ['BAD','not_pdf'];
  if(!txt || txt.length<500) return ['BAD','too_short'];
  const low=txt.toLowerCase();
  // Strip pipes too — Wellcare prints IDs as "H1416 | 072 | 000" so the pipe
  // would otherwise survive the space/dash strip and block the ID match.
  const hay=txt.replace(/[\s\-|]/g,'').toUpperCase();
  const hasId=idVariants(planId).some(v=>hay.includes(v.replace(/[\s\-]/g,'').toUpperCase()));
  if(!hasId) return ['BAD','planid_missing'];
  const head=low.slice(0,2000);
  const badType=/(commission|partnership plan|producer|enrollment (form|request)|frequently asked|\bfaq\b)/.test(head) && !head.includes('summary of benefits');
  if(badType) return ['BAD','wrong_doctype'];
  // "Summary of\nBenefits" split across lines (Devoted cover pages) — also catch.
  const hasSBTitle = low.includes('summary of benefits') || /summary\s+of\s+benefits/i.test(txt);
  if(!hasSBTitle) return ['SUSPECT','no_sb_title'];
  if(!txt.includes('2026')){ const yr=(txt.match(/20(2[0-5]|1\d)/)||[])[0]; if(yr) return ['BAD','stale_year('+yr+')']; }
  return ['GOOD',''];
}

(async()=>{
  const sample=await prisma.plan.findFirst();
  const F=Object.keys(sample);
  const urlField=['sbPdfUrl','sbUrl','summaryOfBenefitsUrl','sbBlobUrl'].find(f=>F.includes(f)) || F.find(f=>/sb.*url|summary.*url/i.test(f));
  console.log('Using SB url field:', urlField);
  const plans=(await prisma.plan.findMany({ distinct:['planId'], select:{ planId:true, organizationName:true, planCategory:true, [urlField]:true } }));
  const done = fs.existsSync(PROG)? JSON.parse(fs.readFileSync(PROG,'utf8')) : {};
  const results = fs.existsSync(OUT)? null : (fs.writeFileSync(OUT,'planId,organizationName,planCategory,verdict,reason,url\n'),true);
  let i=0;
  async function one(p){
    if(done[p.planId]) return;
    const url=p[urlField];
    let verdict='BAD', reason='no_url';
    if(url){
      try{ const r=await fetch(url); const buf=Buffer.from(await r.arrayBuffer());
        if(!r.ok){ verdict='BAD'; reason='fetch_failed('+r.status+')'; }
        else { const txt=pdftext(buf); [verdict,reason]=classify(p.planId,buf,txt); } }
      catch(e){ verdict='BAD'; reason='fetch_failed'; }
    }
    fs.appendFileSync(OUT,[p.planId,csvEsc(p.organizationName),p.planCategory,verdict,reason,csvEsc(url)].join(',')+'\n');
    done[p.planId]=verdict; if(((++i)%25)===0){ fs.writeFileSync(PROG,JSON.stringify(done)); console.log('  checked',i); }
  }
  // simple concurrency pool
  const queue=plans.slice();
  await Promise.all(Array.from({length:CONC},async()=>{ while(queue.length){ await one(queue.shift()); } }));
  fs.writeFileSync(PROG,JSON.stringify(done));

  // summary
  const counts={}; for(const v of Object.values(done)) counts[v]=(counts[v]||0)+1;
  console.log('\n=== SB validity (',plans.length,'plans) ===');
  console.log(JSON.stringify(counts,null,0));
  console.log('Full results + reasons in', OUT, '(filter verdict=BAD/SUSPECT).');
  await prisma.$disconnect();
})().catch(async e=>{ console.error(e); try{await prisma.$disconnect()}catch{}; process.exit(1); });
