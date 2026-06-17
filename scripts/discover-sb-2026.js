// Deterministic Phase-2 discovery. Reads sb-validation-results.csv (verdict BAD/SUSPECT), tries carrier URL
// patterns for Humana/Devoted/Aetna/Cigna, validates+ingests via ingest-sb-url.js. Resumable.
// Writes sb-unresolved.csv for Phase 3 (Wellcare/UHC/stragglers).
const fs=require('fs');
const { ingest }=require('./ingest-sb-url');

async function fetchText(url){ try{ const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'},redirect:'follow',signal:AbortSignal.timeout(20000)}); return r.ok? await r.text() : ''; }catch{ return ''; } }
function parts(planId){ const m=String(planId).match(/([A-Za-z]\d{4})\D*(\d{1,3})/); const c=m?m[1].toUpperCase():planId; const p=m?String(parseInt(m[2],10)):''; return {contract:c, plan3:p.padStart(3,'0'), seg3:'000'}; }
function carrierOf(org){ org=(org||'').toLowerCase();
  if(/humana/.test(org))return 'humana'; if(/devoted/.test(org))return 'devoted'; if(/aetna|coventry/.test(org))return 'aetna';
  if(/cigna|healthspring/.test(org))return 'cigna'; if(/wellcare|centene|ohana|trillium|health net|fidelis/.test(org))return 'wellcare';
  if(/unitedhealth|uhc|aarp/.test(org))return 'uhc'; return 'other'; }

const HUMANA_SF=['20251001','20250928','20250924','20251008','20250930','20251002','20250922','20251015'];
function humanaUrls(p){ return HUMANA_SF.map(d=>'https://content.medicareadvantage.com/2026/Humana-'+p.contract+p.plan3+p.seg3+'SB26pdf-2026-SF'+d+'.pdf'); }
function cignaUrls(p){ return ['https://www.healthspring.com/static/docs/medicare/plans/2026/sb-'+p.contract.toLowerCase()+'-'+p.plan3+'-000.pdf']; }

let _devoted=null;
async function devotedUrls(p){ if(_devoted==null){ console.log('  [Devoted] fetching index...'); _devoted=await fetchText('https://www.devoted.com/all-plan-documents/'); }
  if(!_devoted) return []; const re=new RegExp('https?://[^"\'> ]*SB-'+p.contract+'-'+p.plan3+'-[^"\'> ]*\\.pdf','ig');
  return [...new Set(_devoted.match(re)||[])]; }
async function aetnaUrls(p){ const pageUrl='https://www.aetna.com/medicare/plan.'+p.contract+'.'+p.plan3+'.html';
  const html=await fetchText(pageUrl);
  if(!html) return []; const re=/https?:\/\/[^"'> ]*(SB2026|summary[^"'> ]{0,40}benefit)[^"'> ]*\.pdf/ig;
  const matches=[...new Set(html.match(re)||[])];
  // Also try direct DAM pattern if no matches
  if(matches.length===0){
    const re2=/https?:\/\/[^"'> ]*\/content\/dam\/[^"'> ]*\.pdf/ig;
    const dams=[...(html.match(re2)||[])];
    return dams.slice(0,3);
  }
  return matches; }

async function candidatesFor(planId, org){ const p=parts(planId);
  switch(carrierOf(org)){
    case 'humana': return humanaUrls(p);
    case 'cigna':  return cignaUrls(p);
    case 'devoted':return await devotedUrls(p);
    case 'aetna':  return await aetnaUrls(p);
    default:       return []; // uhc, wellcare -> Phase 3
  }
}
function parseCsv(line){ return (line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)||[]).map(s=>s.replace(/,$/,'').replace(/^"|"$/g,'').replace(/""/g,'"')); }
function readBad(){ const rows=fs.readFileSync('sb-validation-results.csv','utf8').trim().split(/\r?\n/);
  const h=rows[0].split(','); const iId=h.indexOf('planId'),iOrg=h.indexOf('organizationName'),iV=h.indexOf('verdict');
  const out=[]; const seen=new Set();
  for(const l of rows.slice(1)){ const f=parseCsv(l); const v=f[iV];
    if((v==='BAD'||v==='SUSPECT') && !seen.has(f[iId])){ seen.add(f[iId]); out.push({planId:f[iId],org:f[iOrg]}); } }
  return out; }

const PROG='sb-rediscovery-progress.json', RES='sb-rediscovery-results.csv', UNRES='sb-unresolved.csv';
(async()=>{
  const bad=readBad();
  console.log('Plans to process: '+bad.length+' (BAD+SUSPECT)');
  const done=fs.existsSync(PROG)?JSON.parse(fs.readFileSync(PROG,'utf8')):{};
  if(!fs.existsSync(RES)) fs.writeFileSync(RES,'planId,org,verdict,url\n');
  let i=0, good=0, skipped=0;
  for(const {planId,org} of bad){
    if(done[planId]==='GOOD'){ good++; skipped++; continue; }
    const carrier=((org||'').toLowerCase().match(/humana|devoted|aetna|cigna|healthspring|wellcare|unitedhealth|uhc/)||['other'])[0];
    // Skip Phase-3 carriers now — they get handled separately
    if(['wellcare','unitedhealth','uhc'].some(k=>carrier.includes(k)||((org||'').toLowerCase().includes(k)))){
      i++; continue; }
    let hit=null;
    const candidates=await candidatesFor(planId,org);
    for(const url of candidates){
      const [v,m]=await ingest(planId,url);
      if(v==='GOOD'){ hit=url; console.log('  GOOD '+planId+' <- '+url.slice(0,80)); break; }
    }
    if(hit){ done[planId]='GOOD'; good++; fs.appendFileSync(RES,[planId,JSON.stringify(org||''),'GOOD',JSON.stringify(hit)].join(',')+'\n'); }
    else   { done[planId]='UNRESOLVED'; }
    if((++i)%10===0){ fs.writeFileSync(PROG,JSON.stringify(done)); console.log('  '+i+'/'+bad.length+'  good='+good); }
  }
  fs.writeFileSync(PROG,JSON.stringify(done));
  const still=bad.filter(b=>done[b.planId]!=='GOOD');
  const unstillRows=still.map(b=>{ const q=encodeURIComponent('"'+b.planId+'" 2026 "Summary of Benefits" filetype:pdf');
    return [b.planId,JSON.stringify(b.org||''),'https://www.google.com/search?q='+q].join(','); });
  fs.writeFileSync(UNRES,'planId,org,searchUrl\n'+unstillRows.join('\n')+'\n');
  console.log('\nDeterministic pass: GOOD '+good+' / '+bad.length+'  | unresolved '+still.length+' -> '+UNRES);
  // Tally by carrier
  const tally={};
  for(const l of fs.readFileSync(RES,'utf8').trim().split(/\r?\n/).slice(1)){
    const f=parseCsv(l); if(f[2]==='GOOD'){ const c=((f[1]||'').toLowerCase().match(/humana|devoted|aetna|cigna|healthspring|wellcare/)||['other'])[0]; tally[c]=(tally[c]||0)+1; }
  }
  console.log('GOOD by carrier:', JSON.stringify(tally));
})().catch(e=>{ console.error(e); process.exit(1); });
