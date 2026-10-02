// 2027 premium backfill — same derivation as scripts/backfill-lis-premiums.js, but per plan-SEGMENT and set-based.
//   consolidated = CMS CY2027 landscape "Monthly Consolidated Premium (Part C + D)" for that contract-plan-segment
//   partC        = PBP Section D pbp_d_mplusc_premium for that contract-plan-segment
//   partD        = hasDrug ? max(0, consolidated - partC) : 0      (hasDrug = Drug Benefit Type set and != "Not Applicable")
const fs=require('fs'),path=require('path'); const YEAR=2027, APPLY=process.argv.includes('--apply');
const { makePrisma } = require(path.join(process.cwd(),'scripts/prisma-client.js'));
const {parse}=require(path.join(process.cwd(),'node_modules/csv-parse/dist/cjs/sync.cjs'));
const {LICENSED_STATES}=require(path.join(process.cwd(),'scripts/licensed-states')); const {LICENSED_CARRIERS}=require(path.join(process.cwd(),'scripts/licensed-carriers'));
const ST=new Set(LICENSED_STATES),CAR=new Set(LICENSED_CARRIERS); const $=s=>{const n=parseFloat(String(s||'').replace(/[$,]/g,'').trim()); return isNaN(n)?0:n;};
// Part C by plan-segment
const L=fs.readFileSync('.cms-import-tmp/pbp-2027/pbp_Section_D.txt','utf8').split(/\r?\n/).filter(Boolean); const H=L[0].split('\t').map(x=>x.trim());
const iH=H.indexOf('pbp_a_hnumber'),iP=H.indexOf('pbp_a_plan_identifier'),iS=H.indexOf('segment_id'),iC=H.indexOf('pbp_d_mplusc_premium'); if([iH,iP,iS,iC].some(i=>i<0)) throw new Error('Section D columns missing');
const partC=new Map(); for(const l of L.slice(1)){const c=l.split('\t'); const k=c[iH].trim().toUpperCase()+'-'+parseInt(c[iP],10)+'|'+String(parseInt(c[iS]||'0',10)); if(!partC.has(k))partC.set(k,$(c[iC]));}
const rows=parse(fs.readFileSync('.cms-import-tmp/cy2027-landscape/CY2027_Landscape_202609.csv'),{columns:true,bom:true,skip_empty_lines:true,relax_column_count:true});
const seg=new Map(); let conflict=0, noPartC=0, qa=0;
for(const r of rows){ if(r['Contract Category Type']==='PDP'||!ST.has(r['State Territory Abbreviation'])||!CAR.has(r['Organization Marketing Name']))continue;
  const k=r['Contract ID']+'-'+parseInt(r['Plan ID'],10)+'|'+String(parseInt(r['Segment ID']||'0',10)); const m=$(r['Monthly Consolidated Premium (Part C + D)']);
  const dbt=(r['Drug Benefit Type']||'').trim(); const hasDrug=!!dbt&&dbt!=='Not Applicable';
  if(seg.has(k)){ if(seg.get(k).m!==m)conflict++; continue; }
  if(!partC.has(k))noPartC++; const c=partC.get(k)??0; const d=hasDrug?Math.max(0,+(m-c).toFixed(2)):0;
  if(Math.abs(c-$(r['Part C Premium']))>0.01) qa++;
  seg.set(k,{m,c,d,lc:$(r['Part C Premium']),ld:$(r['Part D Total Premium'])}); }
console.log('plan-segments in landscape:',seg.size,'| same plan-seg with differing premium across counties:',conflict,'| no Section D row:',noPartC,'| PBP partC != landscape Part C:',qa);
(async()=>{const p=makePrisma();
const db=await p.$queryRawUnsafe(`select "planId" pid, coalesce("segmentId",'0') seg, "planCategory"::text cat, count(*)::int n, min("monthlyPremium") mn, max("monthlyPremium") mx from "Plan" where "planYear"=${YEAR} group by 1,2,3`);
let miss=[],chg=[],rowsChg=0; for(const r of db){const v=seg.get(r.pid+'|'+r.seg); if(!v){miss.push(r.pid+'|'+r.seg+' ('+r.n+')');continue;} if(Math.abs(v.m-r.mn)>1||Math.abs(v.m-r.mx)>1){chg.push(`${r.pid}|${r.seg} ${r.cat}: db ${r.mn} -> ${v.m} (C ${v.c} D ${v.d})`);rowsChg+=r.n;}}
console.log('DB plan-segments:',db.length,'| not in landscape:',miss.length,miss.slice(0,8),'| monthlyPremium changes >$1:',chg.length,'plan-segs /',rowsChg,'rows'); for(const c of chg.slice(0,10))console.log('  ',c);
if(!APPLY){console.log('DRY RUN'); await p.$disconnect(); return;}
const keys=[...seg.keys()]; let total=0;
for(let i=0;i<keys.length;i+=500){ const vals=keys.slice(i,i+500).map(k=>{const [pid,s]=k.split('|'); const v=seg.get(k); return `('${pid}','${s}',${v.c},${v.d},${v.m})`;}).join(',');
  total+=await p.$executeRawUnsafe(`update "Plan" p set "partCPremium"=v.c::float8, "partDPremium"=v.d::float8, "monthlyPremium"=v.m::float8 from (values ${vals}) as v(pid,seg,c,d,m) where p."planYear"=${YEAR} and p."planId"=v.pid and coalesce(p."segmentId",'0')=v.seg`); }
console.log('rows updated:',total);
const chk=await p.$queryRawUnsafe(`select count(*)::int n, count(*) filter (where abs(coalesce("partCPremium",0)+coalesce("partDPremium",0)-"monthlyPremium")>0.02 and "planCategory" not in ('MA_ONLY'))::int mismatch from "Plan" where "planYear"=${YEAR}`); console.log('invariant check',JSON.stringify(chk));
await p.$disconnect();})().catch(e=>{console.error('ERR',e.message.slice(0,600));process.exit(1)});
