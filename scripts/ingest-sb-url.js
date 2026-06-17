// Usage: node scripts/ingest-sb-url.js <planId> <candidateUrl>
// Download -> STRICT-validate (2026 + is-SB + plan ID) -> on GOOD upload to Vercel Blob + updateMany DB.
// Prints "GOOD <blobUrl> ..." or "BAD <reason>". Idempotent; safe to re-run.
const fs=require('fs'), os=require('os'), path=require('path'), crypto=require('crypto');
const { execFileSync }=require('child_process');
const { put }=require('@vercel/blob');
const { makePrisma }=require('./prisma-client');

// Load env for BLOB_READ_WRITE_TOKEN
for(const envFile of ['.env','.env.local']){
  const p=path.join(__dirname,'..', envFile);
  try{ const c=fs.readFileSync(p,'utf8'); for(const l of c.split(/\r?\n/)){ const m=l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n\r]*)"?\s*$/); if(m&&!process.env[m[1]]) process.env[m[1]]=m[2]; } }catch{}
}

const PDFTOTEXT = (() => {
  const candidates = ['pdftotext','C:\\Program Files\\Git\\mingw64\\bin\\pdftotext.exe'];
  for(const c of candidates){ try{ execFileSync(c,['-h'],{stdio:'pipe'}); return c; }catch(e){ if(e.stdout||e.stderr) return c; } }
  return null;
})();
function pdftext(buf){
  if(!PDFTOTEXT) return '';
  const tmp=path.join(os.tmpdir(),'sb_'+Math.random().toString(36).slice(2)+'.pdf');
  try{ fs.writeFileSync(tmp,buf); return execFileSync(PDFTOTEXT,['-layout','-f','1','-l','3',tmp,'-'],{maxBuffer:30*1024*1024}).toString('utf8'); }
  catch{ return ''; } finally{ try{fs.unlinkSync(tmp);}catch{} }
}
function idVariants(planId){
  const m=String(planId).match(/([A-Za-z]\d{4})\D*(\d{1,3})/); if(!m) return [String(planId).toUpperCase()];
  const c=m[1].toUpperCase(), p=String(parseInt(m[2],10)), p3=p.padStart(3,'0');
  return [c+'-'+p3, c+'-'+p, c+' '+p3, c+p3, c+'|'+p3, c+'-'+p3+'-000'];
}
function classify(planId, buf, txt){
  if(!buf || buf.length<800) return ['BAD','too_short'];
  if(buf.slice(0,5).toString('latin1')!=='%PDF-') return ['BAD','not_pdf'];
  if(!txt || txt.length<500) return ['BAD','too_short_text'];
  const hay=txt.replace(/[\s\-|]/g,'').toUpperCase();
  if(!idVariants(planId).some(v=>hay.includes(v.replace(/[\s\-|]/g,'').toUpperCase()))) return ['BAD','planid_missing'];
  const low=txt.toLowerCase(), head=low.slice(0,3000);
  if(/(commission|partnership plan|producer|enrollment (form|request|kit)|frequently asked|\bfaq\b)/.test(head) && !head.includes('summary of benefits')) return ['BAD','wrong_doctype'];
  if(!low.includes('summary of benefits')) return ['BAD','no_sb_title'];
  if(!txt.includes('2026')){ const yr=(txt.match(/20(2[0-5]|1\d)/)||[])[0]; return ['BAD','stale_year'+(yr?'('+yr+')':'')]; }
  if(/january 1\s*[–-]\s*december 31,\s*2025/.test(low) && !/january 1\s*[–-]\s*december 31,\s*2026/.test(low)) return ['BAD','stale_year(2025)'];
  return ['GOOD',''];
}
async function ingest(planId, url){
  let buf;
  try{ const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64)','Accept':'application/pdf,*/*'},redirect:'follow'});
    if(!r.ok) return ['BAD','fetch_failed('+r.status+')']; buf=Buffer.from(await r.arrayBuffer()); }
  catch(e){ return ['BAD','fetch_error('+(e.code||e.message)+')']; }
  const [v,reason]=classify(planId, buf, pdftext(buf));
  if(v!=='GOOD') return ['BAD',reason];
  const sha=crypto.createHash('sha256').update(buf).digest('hex');
  let blobUrl;
  try{ blobUrl=(await put('sb/2026/'+planId+'.pdf', new Blob([buf]), {access:'public',addRandomSuffix:false,allowOverwrite:true,contentType:'application/pdf'})).url; }
  catch(e){ return ['BAD','blob_upload('+e.message+')']; }
  const prisma=makePrisma();
  try{ const u=await prisma.plan.updateMany({where:{planId},data:{sbPdfUrl:blobUrl,sbPdfSourceFilename:url,sbPdfChecksum:sha,sbLastProcessedAt:new Date(),sbDiscoveryConfidence:0.98}});
    return ['GOOD',blobUrl+'  (rows '+u.count+')']; }
  finally{ await prisma.$disconnect(); }
}
// Note: sbDiscoveryConfidence is Float in schema
module.exports={ ingest, classify, pdftext, idVariants };
if(require.main===module){
  const [planId,url]=process.argv.slice(2);
  if(!planId||!url){ console.error('usage: node scripts/ingest-sb-url.js <planId> <url>'); process.exit(2); }
  ingest(planId,url).then(([v,m])=>{ console.log(v+' '+m); process.exit(0); }).catch(e=>{ console.error(e); process.exit(1); });
}
