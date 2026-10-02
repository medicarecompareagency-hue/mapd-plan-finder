const fs=require('fs'),path=require('path');
const { makePrisma } = require(path.join(process.cwd(),'scripts/prisma-client.js'));
const {parse}=require(path.join(process.cwd(),'node_modules/csv-parse/dist/cjs/sync.cjs'));
const {LICENSED_STATES}=require(path.join(process.cwd(),'scripts/licensed-states'));
const {LICENSED_CARRIERS}=require(path.join(process.cwd(),'scripts/licensed-carriers'));
(async()=>{const p=makePrisma(); const q=s=>p.$queryRawUnsafe(s);
if(process.argv.includes('--delete-egwp')){
  const n=await p.$executeRawUnsafe(`delete from "Plan" where "planYear"=2027 and split_part("planId",'-',2)::int >= 800`); console.log('deleted 2027 EGWP rows:',n);}
console.log('by year',JSON.stringify(await q(`select "planYear" y,count(*)::int n,count(distinct "planId")::int ids from "Plan" group by 1 order by 1`)));
console.log('2027 by carrier',JSON.stringify(await q(`select "organizationName" c,count(*)::int n,count(distinct "planId")::int ids from "Plan" where "planYear"=2027 group by 1 order by 2 desc`)));
console.log('2027 by category',JSON.stringify(await q(`select "planCategory"::text c,count(*)::int n,count(distinct "planId")::int ids from "Plan" where "planYear"=2027 group by 1 order by 2 desc`)));
console.log('2027 states',JSON.stringify(await q(`select count(distinct state)::int states, count(*) filter (where "planCategory" is null)::int nullcat, count(*) filter (where split_part("planId",'-',2)::int >= 800)::int egwp from "Plan" where "planYear"=2027`)));
console.log('dups',JSON.stringify(await q(`select count(*)::int dup from (select "planId",state,county from "Plan" where "planYear"=2027 group by 1,2,3 having count(*)>1) t`)));
// per-plan county count vs landscape
const db=new Map(); for(const r of await q(`select "planId" id,count(*)::int n from "Plan" where "planYear"=2027 group by 1`)) db.set(r.id,r.n);
const ST=new Set(LICENSED_STATES),CAR=new Set(LICENSED_CARRIERS); const L=new Map();
for(const r of parse(fs.readFileSync('.cms-import-tmp/cy2027-landscape/CY2027_Landscape_202609.csv'),{columns:true,bom:true,skip_empty_lines:true,relax_column_count:true})){
 if(r['Contract Category Type']==='PDP'||!ST.has(r['State Territory Abbreviation'])||!CAR.has(r['Organization Marketing Name']))continue;
 const id=r['Contract ID']+'-'+parseInt(r['Plan ID'],10); L.set(id,(L.get(id)||0)+1);}
let mism=[],missing=[],extra=[]; for(const [id,n] of L){ if(!db.has(id))missing.push(id); else if(db.get(id)!==n)mism.push(id+' land='+n+' db='+db.get(id)); } for(const id of db.keys()) if(!L.has(id))extra.push(id);
console.log('landscape plans',L.size,'db plans',db.size,'| missing from db',missing.length,'(R-contract:',missing.filter(x=>x[0]==='R').length+')','| county-count mismatches',mism.length,mism.slice(0,5),'| in db not landscape',extra.length,extra.slice(0,5));
await p.$disconnect();})().catch(e=>{console.error('ERR',e.message.slice(0,500));process.exit(1)});
