// scripts/serpapi-sb-sweep.js — resolve sb-unresolved.csv via SerpAPI -> carrier/mirror SB PDF -> strict-validate -> ingest.
const fs=require('fs'), os=require('os'), path=require('path'), crypto=require('crypto');
const { execFileSync }=require('child_process');
const { put }=require('@vercel/blob');
const { makePrisma }=require('./prisma-client');

for (const envFile of ['.env', '.env.local']) {
  const p = path.join(__dirname, '..', envFile);
  try { const c = fs.readFileSync(p, 'utf8'); for (const l of c.split(/\r?\n/)) { const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n\r]*)"?\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; } } catch {}
}

const KEY=process.env.SERPAPI_KEY||process.env.SERPAPI_API_KEY;
if(!KEY){ console.error('Set SERPAPI_KEY in this PowerShell first:  $env:SERPAPI_KEY="..."'); process.exit(2); }
const ALLOW=/(^|\.)(content\.medicareadvantage\.com|healthspring\.com|aetna\.com|aetnamedicare\.com|devoted\.com|wellcare\.com|wellcareok\.com|superiorhealthplan\.com|uhc\.com|aarpmedicareplans\.com|humana\.com)$/i;

function pdftext(buf){ const tmp=path.join(os.tmpdir(),'sb_'+Math.random().toString(36).slice(2)+'.pdf'); try{ fs.writeFileSync(tmp,buf); return execFileSync('pdftotext',['-layout','-f','1','-l','3',tmp,'-'],{maxBuffer:30*1024*1024}).toString('utf8'); }catch{ return ''; } finally{ try{fs.unlinkSync(tmp);}catch{} } }
function idVariants(planId){ const m=String(planId).match(/([A-Za-z]\d{4})\D*(\d{1,3})/); if(!m) return [String(planId).toUpperCase()]; const c=m[1].toUpperCase(),p=String(parseInt(m[2],10)),p3=p.padStart(3,'0'); return [c+'-'+p3,c+'-'+p,c+' '+p3,c+p3,c+'|'+p3]; }
function classify(planId,buf,txt){ if(!buf||buf.length<800)return['BAD','too_short']; if(buf.slice(0,5).toString('latin1')!=='%PDF-')return['BAD','not_pdf']; if(!txt||txt.length<500)return['BAD','too_short_text']; const hay=txt.replace(/[\s\-|]/g,'').toUpperCase(); if(!idVariants(planId).some(v=>hay.includes(v.replace(/[\s\-|]/g,'').toUpperCase())))return['BAD','planid_missing']; const low=txt.toLowerCase(),head=low.slice(0,3000); if(/(commission|partnership plan|producer|enrollment (form|request|kit)|frequently asked|\bfaq\b)/.test(head)&&!head.includes('summary of benefits'))return['BAD','wrong_doctype']; if(!low.includes('summary of benefits'))return['BAD','no_sb_title']; if(!txt.includes('2026')){const yr=(txt.match(/20(2[0-5]|1\d)/)||[])[0];return['BAD','stale_year'+(yr?'('+yr+')':'')];} if(/january 1\s*[–-]\s*december 31,\s*2025/.test(low)&&!/january 1\s*[–-]\s*december 31,\s*2026/.test(low))return['BAD','stale_year(2025)']; return['GOOD','']; }

function host(u){ try{ return new URL(u).hostname; }catch{ return ''; } }
async function serp(q){ const u='https://serpapi.com/search.json?engine=google&num=10&q='+encodeURIComponent(q)+'&api_key='+KEY; try{ const r=await fetch(u); if(!r.ok){ console.error('SerpAPI error:', r.status, await r.text().catch(()=>'')); return []; } const j=await r.json(); return (j.organic_results||[]).map(o=>o.link).filter(Boolean); }catch(e){ console.error('SerpAPI fetch error:', e.message); return []; } }
async function dl(u){ try{ const r=await fetch(u,{headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64)','Accept':'application/pdf,*/*'},redirect:'follow',signal:AbortSignal.timeout(30000)}); if(!r.ok) return null; return Buffer.from(await r.arrayBuffer()); }catch{ return null; } }
async function ingest(prisma,planId,url,buf){ const sha=crypto.createHash('sha256').update(buf).digest('hex'); let blobUrl; try{ blobUrl=(await put('sb/2026/'+planId+'.pdf',new Blob([buf]),{access:'public',addRandomSuffix:false,allowOverwrite:true,contentType:'application/pdf',token:process.env.BLOB_READ_WRITE_TOKEN})).url; }catch(e){ console.error('Blob error:', e.message); return null; }
  const u = await prisma.plan.updateMany({where:{planId},data:{sbPdfUrl:blobUrl,sbPdfSourceFilename:url,sbPdfChecksum:sha,sbLastProcessedAt:new Date(),sbDiscoveryConfidence:0.97}});
  return u.count > 0 ? blobUrl : null;
}

function parseCsv(l){ return (l.match(/("([^"]|"")*"|[^,]*)(,|$)/g)||[]).map(s=>s.replace(/,$/,'').replace(/^"|"$/g,'').replace(/""/g,'"')); }
const PROG='sb-serp-progress.json', OUT='sb-serp-results.csv';
(async()=>{
  if(!fs.existsSync('sb-unresolved.csv')){ console.log('No sb-unresolved.csv — nothing to sweep.'); return; }
  const rows=fs.readFileSync('sb-unresolved.csv','utf8').trim().split(/\r?\n/); const h=rows[0].split(','); const iId=h.indexOf('planId'),iOrg=h.indexOf('org');
  const plans=rows.slice(1).map(parseCsv).map(f=>({planId:f[iId],org:iOrg>=0?f[iOrg]:''})).filter(p=>p.planId);
  const done=fs.existsSync(PROG)?JSON.parse(fs.readFileSync(PROG,'utf8')):{};
  if(!fs.existsSync(OUT)) fs.writeFileSync(OUT,'planId,verdict,url\n');
  const prisma=makePrisma();

  // Pre-check: skip plans already in DB
  let skipped = 0;
  for (const {planId} of plans) {
    if (done[planId] === 'GOOD') { skipped++; continue; }
    const row = await prisma.plan.findFirst({ where: { planId, planYear: 2026, sbPdfUrl: { not: null } }, select: { sbPdfUrl: true } });
    if (row?.sbPdfUrl) { done[planId] = 'GOOD'; skipped++; }
  }
  if (skipped > 0) { fs.writeFileSync(PROG, JSON.stringify(done)); console.log('Pre-skipped (already in DB):', skipped); }

  let i=0,good=0,total=plans.filter(p=>done[p.planId]!=='GOOD').length;
  console.log('Plans to sweep via SerpAPI:', total);
  for(const {planId,org} of plans){
    if(done[planId]==='GOOD'){ good++; continue; }
    const carrier=(org||'').split(/\s+/)[0]||'';
    const queries=['"'+planId+'" 2026 "Summary of Benefits" filetype:pdf', carrier+' "'+planId+'" 2026 "Summary of Benefits" filetype:pdf'];
    let hit=null;
    for(const q of queries){ if(hit) break;
      console.log('  SERP:', q.slice(0,80));
      const links=await serp(q);
      const pdfs=links.filter(u=>/\.pdf($|\?)/i.test(u) && ALLOW.test(host(u))).slice(0,3);
      console.log('  PDF hits:', pdfs.length);
      for(const u of pdfs){
        const buf=await dl(u); if(!buf) continue;
        const txt=pdftext(buf);
        const [v,reason]=classify(planId,buf,txt);
        console.log('   ', u.slice(0,80), '->', v, reason||'');
        if(v==='GOOD'){ const b=await ingest(prisma,planId,u,buf); if(b){ hit=u; console.log('  GOOD', planId, '@', b); break; } }
      }
    }
    if(hit){ done[planId]='GOOD'; good++; fs.appendFileSync(OUT,[planId,'GOOD',JSON.stringify(hit)].join(',')+'\n'); }
    else   { done[planId]='MISS';  fs.appendFileSync(OUT,[planId,'MISS',''].join(',')+'\n'); console.log('  MISS', planId); }
    i++;
    fs.writeFileSync(PROG,JSON.stringify(done));
    console.log('Progress: '+i+'/'+total+' swept, good='+good);
  }
  console.log('\nSerpAPI sweep: GOOD '+good+' / '+plans.length+' total.  Misses in '+OUT+'.');
  await prisma.$disconnect();
})().catch(e=>{ console.error(e); process.exit(1); });
