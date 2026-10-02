const fs=require('fs'),path=require('path'); const APPLY=process.argv.includes('--apply');
const { makePrisma } = require(path.join(process.cwd(),'scripts/prisma-client.js'));
const {parse}=require(path.join(process.cwd(),'node_modules/csv-parse/dist/cjs/sync.cjs'));
const {LICENSED_STATES}=require(path.join(process.cwd(),'scripts/licensed-states')); const {LICENSED_CARRIERS}=require(path.join(process.cwd(),'scripts/licensed-carriers'));
const ST=new Set(LICENSED_STATES),CAR=new Set(LICENSED_CARRIERS);
const MAP={'Local PPO':'PPO','HMOPOS':'HMOPOS','HMO':'HMO','PFFS':'PFFS','Regional PPO':'Regional PPO'};
const LAND2DB={'PPO':'PPO','HMO-POS':'HMOPOS','HMO':'HMO','PFFS':'PFFS','Regional PPO':'Regional PPO'};
const land=new Map(); for(const r of parse(fs.readFileSync('.cms-import-tmp/cy2027-landscape/CY2027_Landscape_202609.csv'),{columns:true,bom:true,skip_empty_lines:true,relax_column_count:true})){
 if(r['Contract Category Type']==='PDP'||!ST.has(r['State Territory Abbreviation'])||!CAR.has(r['Organization Marketing Name']))continue; land.set(r['Contract ID']+'-'+parseInt(r['Plan ID'],10), r['Plan Type'].replace(/ (D|C|I)-SNP$/,'').trim());}
(async()=>{const p=makePrisma();
const db=await p.$queryRawUnsafe(`select distinct "planId" pid,"planType" t,"cmsContractType" c from "Plan" where "planYear"=2027`);
let disagree=[]; for(const r of db){const want=MAP[r.c]; const l=LAND2DB[land.get(r.pid)]; if(!want||want!==l) disagree.push(`${r.pid} cms=${r.c} landscape=${land.get(r.pid)}`);} 
console.log('plans',db.length,'| cmsContractType vs landscape Plan Type disagreements:',disagree.length,disagree.slice(0,8));
if(APPLY&&!disagree.length){ for(const [c,t] of Object.entries(MAP)){ const n=await p.$executeRawUnsafe(`update "Plan" set "planType"=$1 where "planYear"=2027 and "cmsContractType"=$2 and "planType"<>$1`,t,c); console.log(c,'->',t,'rows',n);} }
console.log(JSON.stringify(await p.$queryRawUnsafe(`select "planType" t,"cmsContractType" c,count(*)::int n,count(distinct "planId")::int ids from "Plan" where "planYear"=2027 group by 1,2 order by 3 desc`)));
await p.$disconnect();})().catch(e=>{console.error('ERR',e.message.slice(0,600));process.exit(1)});
