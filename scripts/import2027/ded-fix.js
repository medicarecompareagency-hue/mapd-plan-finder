const fs=require('fs'),path=require('path'); const APPLY=process.argv.includes('--apply');
const { makePrisma } = require(path.join(process.cwd(),'scripts/prisma-client.js'));
const {parse}=require(path.join(process.cwd(),'node_modules/csv-parse/dist/cjs/sync.cjs'));
const {LICENSED_STATES}=require(path.join(process.cwd(),'scripts/licensed-states')); const {LICENSED_CARRIERS}=require(path.join(process.cwd(),'scripts/licensed-carriers'));
const ST=new Set(LICENSED_STATES),CAR=new Set([...LICENSED_CARRIERS,'Cigna','Cigna Healthcare']); const $=s=>{const n=parseFloat(String(s||'').replace(/[$,]/g,'').trim()); return isNaN(n)?null:n;};
function load(f){const rows=parse(fs.readFileSync(f),{columns:true,bom:true,skip_empty_lines:true,relax_column_count:true}); const m=new Map();
 for(const r of rows){ if(r['Contract Category Type']==='PDP'||!ST.has(r['State Territory Abbreviation'])||!CAR.has(r['Organization Marketing Name']))continue;
  const k=r['Contract ID']+'-'+parseInt(r['Plan ID'],10)+'|'+String(parseInt(r['Segment ID']||'0',10)); if(!m.has(k))m.set(k,{ded:$(r['Annual Part D Deductible Amount']),dbt:r['Drug Benefit Type']});} return m;}
(async()=>{const p=makePrisma();
for(const [yr,f] of [[2026,'.cms-import-tmp/cy2026-landscape/CY2026_Landscape_202603/CY2026_Landscape_202603.csv'],[2027,'.cms-import-tmp/cy2027-landscape/CY2027_Landscape_202609.csv']]){
 if(!fs.existsSync(f)){console.log(yr,'landscape missing',f);continue;} const L=load(f);
 const db=await p.$queryRawUnsafe(`select "planId" pid, coalesce("segmentId",'0') seg, "planCategory"::text cat, count(*)::int n, min("drugDeductible") dmin, max("drugDeductible") dmax from "Plan" where "planYear"=${yr} and "planCategory"<>'MA_ONLY' group by 1,2,3`);
 const bad=[]; let rows=0; const types={}; const byCatRows={};
 for(const r of db){const v=L.get(r.pid+'|'+r.seg); if(!v||v.ded==null)continue; if(Math.abs(v.ded-r.dmin)>0.5||Math.abs(v.ded-r.dmax)>0.5){bad.push({pid:r.pid,seg:r.seg,ded:v.ded,db:r.dmin,cat:r.cat});rows+=r.n; const t=r.cat; types[t]=(types[t]||0)+1; byCatRows[t]=(byCatRows[t]||0)+r.n;}}
 console.log(yr,"mismatch plan-segs by category",JSON.stringify(types),"rows",JSON.stringify(byCatRows));
 if(yr===2027&&APPLY&&bad.length){const vals=bad.map(b=>`('${b.pid}','${b.seg}',${b.ded})`).join(',');
  const n=await p.$executeRawUnsafe(`update "Plan" p set "drugDeductible"=v.d::float8 from (values ${vals}) as v(pid,seg,d) where p."planYear"=2027 and p."planId"=v.pid and coalesce(p."segmentId",'0')=v.seg and p."planCategory"<>'MA_ONLY'`); console.log('2027 rows fixed:',n);}}
await p.$disconnect();})().catch(e=>{console.error('ERR',e.message.slice(0,600));process.exit(1)});
