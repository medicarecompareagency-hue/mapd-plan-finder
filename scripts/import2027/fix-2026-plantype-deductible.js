// One-off repair of two LIVE 2026 data errors (approved by Dale 2026-10-02). Dry-run by default; --apply writes.
//  1. Contract Type: rows with planType 'PPO' whose CMS contract type AND CY2026 landscape Plan Type are HMO-POS -> planType 'HMOPOS'.
//  2. Drug deductible: CSNP / ISNP / MAPD plan-segments showing $0 where the CY2026 landscape has a real deductible -> landscape value.
//     DSNP is deliberately left alone (duals do not pay the deductible). MA_ONLY has no drug benefit.
// Writes a before-image of every changed row to scripts/import2027/fix-2026-backup-<ts>.json so it can be reversed.
const fs=require('fs'),path=require('path'); const APPLY=process.argv.includes('--apply');
const { makePrisma } = require(path.join(process.cwd(),'scripts/prisma-client.js'));
const {parse}=require(path.join(process.cwd(),'node_modules/csv-parse/dist/cjs/sync.cjs'));
const {LICENSED_STATES}=require(path.join(process.cwd(),'scripts/licensed-states')); const {LICENSED_CARRIERS}=require(path.join(process.cwd(),'scripts/licensed-carriers'));
const ST=new Set(LICENSED_STATES),CAR=new Set([...LICENSED_CARRIERS,'Cigna','Cigna Healthcare']); const $=s=>{const n=parseFloat(String(s||'').replace(/[$,]/g,'').trim()); return isNaN(n)?null:n;};
const F='.cms-import-tmp/cy2026-landscape/CY2026_Landscape_202603/CY2026_Landscape_202603.csv';
const typeByPlan=new Map(), dedBySeg=new Map();
for(const r of parse(fs.readFileSync(F),{columns:true,bom:true,skip_empty_lines:true,relax_column_count:true})){
  if(r['Contract Category Type']==='PDP'||!ST.has(r['State Territory Abbreviation'])||!CAR.has(r['Organization Marketing Name']))continue;
  const pid=r['Contract ID']+'-'+parseInt(r['Plan ID'],10); typeByPlan.set(pid,(r['Plan Type']||'').trim());
  const k=pid+'|'+String(parseInt(r['Segment ID']||'0',10)); if(!dedBySeg.has(k)) dedBySeg.set(k,$(r['Annual Part D Deductible Amount']));}
(async()=>{const p=makePrisma();
// ---- 1. contract type
const pt=await p.$queryRawUnsafe(`select distinct "planId" pid from "Plan" where "planYear"=2026 and "planType"='PPO' and "cmsContractType"='HMOPOS'`);
const ok=[],skip=[]; for(const r of pt){ const l=typeByPlan.get(r.pid)||''; (/^HMO-?POS/i.test(l)?ok:skip).push(r.pid+(l?'':' (not in landscape)')+(l&&!/^HMO-?POS/i.test(l)?' landscape='+l:'')); }
console.log('Contract Type: PPO-labeled plans with CMS type HMOPOS:',pt.length,'| landscape confirms HMO-POS:',ok.length,'| skipped:',skip.length,skip.slice(0,10));
// ---- 2. deductible
const db=await p.$queryRawUnsafe(`select "planId" pid, coalesce("segmentId",'0') seg, "planCategory"::text cat, count(*)::int n, min("drugDeductible") dmin, max("drugDeductible") dmax from "Plan" where "planYear"=2026 and "planCategory" in ('CSNP','ISNP','MAPD') group by 1,2,3`);
const ded=[]; const byCat={}; for(const r of db){const v=dedBySeg.get(r.pid+'|'+r.seg); if(v==null||v<=0)continue; if(r.dmin===0&&r.dmax===0){ded.push({pid:r.pid,seg:r.seg,d:v,cat:r.cat,n:r.n}); byCat[r.cat]=byCat[r.cat]||{segs:0,rows:0}; byCat[r.cat].segs++; byCat[r.cat].rows+=r.n;}}
console.log('Drug deductible: $0 in DB, >0 in landscape:',ded.length,'plan-segments',JSON.stringify(byCat)); const dist={}; for(const d of ded)dist[d.d]=(dist[d.d]||0)+1; console.log('  landscape values:',JSON.stringify(dist));
if(!APPLY){console.log('DRY RUN'); await p.$disconnect(); return;}
const ids1=ok.map(s=>s.split(' ')[0]);
const b1=await p.$queryRawUnsafe(`select id,"planType" from "Plan" where "planYear"=2026 and "planType"='PPO' and "cmsContractType"='HMOPOS' and "planId" = any($1::text[])`,ids1);
const vals=ded.map(b=>`('${b.pid}','${b.seg}',${b.d})`).join(',');
const b2=ded.length?await p.$queryRawUnsafe(`select p.id,p."drugDeductible" from "Plan" p join (values ${vals}) as v(pid,seg,d) on p."planId"=v.pid and coalesce(p."segmentId",'0')=v.seg where p."planYear"=2026 and p."planCategory" in ('CSNP','ISNP','MAPD') and p."drugDeductible"=0`):[];
const bk=path.join('scripts','import2027','fix-2026-backup-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json'); fs.writeFileSync(bk,JSON.stringify({planType:b1,drugDeductible:b2})); console.log('backup written:',bk,'planType rows',b1.length,'deductible rows',b2.length);
const n1=await p.$executeRawUnsafe(`update "Plan" set "planType"='HMOPOS' where "planYear"=2026 and "planType"='PPO' and "cmsContractType"='HMOPOS' and "planId" = any($1::text[])`,ids1); console.log('planType rows updated:',n1);
const n2=ded.length?await p.$executeRawUnsafe(`update "Plan" p set "drugDeductible"=v.d::float8 from (values ${vals}) as v(pid,seg,d) where p."planYear"=2026 and p."planId"=v.pid and coalesce(p."segmentId",'0')=v.seg and p."planCategory" in ('CSNP','ISNP','MAPD') and p."drugDeductible"=0`):0; console.log('deductible rows updated:',n2);
console.log(JSON.stringify(await p.$queryRawUnsafe(`select "planType" t,"cmsContractType" c,count(*)::int n,count(distinct "planId")::int ids from "Plan" where "planYear"=2026 group by 1,2 order by 3 desc`)));
await p.$disconnect();})().catch(e=>{console.error('ERR',e.message.slice(0,600));process.exit(1)});
