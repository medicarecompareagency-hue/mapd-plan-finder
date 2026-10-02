const fs=require('fs'),path=require('path');
const { makePrisma } = require(path.join(process.cwd(),'scripts/prisma-client.js'));
const {parse}=require(path.join(process.cwd(),'node_modules/csv-parse/dist/cjs/sync.cjs'));
const {LICENSED_STATES}=require(path.join(process.cwd(),'scripts/licensed-states')); const {LICENSED_CARRIERS}=require(path.join(process.cwd(),'scripts/licensed-carriers'));
const ST=new Set(LICENSED_STATES),CAR=new Set(LICENSED_CARRIERS); const $=s=>{const t=String(s||'').replace(/[$,]/g,'').trim(); const n=parseFloat(t); return isNaN(n)?null:n;};
const rows=parse(fs.readFileSync('.cms-import-tmp/cy2027-landscape/CY2027_Landscape_202609.csv'),{columns:true,bom:true,skip_empty_lines:true,relax_column_count:true});
const seg=new Map(); const dedDist={};
for(const r of rows){ if(r['Contract Category Type']==='PDP'||!ST.has(r['State Territory Abbreviation'])||!CAR.has(r['Organization Marketing Name']))continue;
 const k=r['Contract ID']+'-'+parseInt(r['Plan ID'],10)+'|'+String(parseInt(r['Segment ID']||'0',10)); if(seg.has(k))continue;
 seg.set(k,{ded:$(r['Annual Part D Deductible Amount']),moop:$(r['In-Network Maximum Out-of-Pocket (MOOP) Amount']),type:r['Plan Type'],name:r['Plan Name'],star:r['Overall Star Rating']}); const d=r['Annual Part D Deductible Amount'].trim(); dedDist[d]=(dedDist[d]||0)+1;}
console.log('landscape deductible top values',Object.entries(dedDist).sort((a,b)=>b[1]-a[1]).slice(0,8));
(async()=>{const p=makePrisma();
const db=await p.$queryRawUnsafe(`select "planId" pid, coalesce("segmentId",'0') seg, "planCategory"::text cat, count(*)::int n, min("drugDeductible") dmin, max("drugDeductible") dmax, min("maxOutOfPocket") mmin, max("maxOutOfPocket") mmax, min("planType") pt, min("planName") nm from "Plan" where "planYear"=2027 group by 1,2,3`);
let ded=[],moop=[],dedRows=0,moopRows=0; const dedPairs={};
for(const r of db){const v=seg.get(r.pid+'|'+r.seg); if(!v)continue;
 if(r.cat!=='MA_ONLY' && v.ded!=null && (Math.abs(v.ded-r.dmin)>0.5||Math.abs(v.ded-r.dmax)>0.5)){ded.push(`${r.pid}|${r.seg} ${r.cat} db ${r.dmin}..${r.dmax} land ${v.ded}`);dedRows+=r.n; const kk=r.dmin+'->'+v.ded; dedPairs[kk]=(dedPairs[kk]||0)+1;}
 if(v.moop!=null && (Math.abs(v.moop-r.mmin)>0.5||Math.abs(v.moop-r.mmax)>0.5)){moop.push(`${r.pid}|${r.seg} ${r.cat} db ${r.mmin}..${r.mmax} land ${v.moop}`);moopRows+=r.n;}}
console.log('drugDeductible mismatches:',ded.length,'plan-segs',dedRows,'rows',ded.slice(0,6)); console.log('  top (db->landscape):',Object.entries(dedPairs).sort((a,b)=>b[1]-a[1]).slice(0,8));
console.log('MOOP mismatches:',moop.length,'plan-segs',moopRows,'rows',moop.slice(0,8));
const s=await p.$queryRawUnsafe(`select count(*)::int n, max("updatedAt") mx, md5(string_agg(md5(t::text),'' order by id)) h from "Plan" t where "planYear"=2026`); console.log('2026 snapshot (compare before/after a run):', s[0].n, s[0].h);
await p.$disconnect();})().catch(e=>{console.error('ERR',e.message.slice(0,600));process.exit(1)});
