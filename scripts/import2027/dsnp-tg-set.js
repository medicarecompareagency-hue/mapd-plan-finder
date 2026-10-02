const fs=require('fs'),path=require('path'); const { makePrisma } = require(path.join(process.cwd(),'scripts/prisma-client.js'));
// identical classification logic to scripts/import-dsnp-target-group.js, applied set-based
const lines=fs.readFileSync('.cms-import-tmp/pbp-2027/pbp_Section_A.txt','utf8').split(/\r?\n/); const h=lines[0].split('\t');
const iH=h.indexOf('pbp_a_hnumber'),iP=h.indexOf('pbp_a_plan_identifier'),iS=h.indexOf('pbp_a_special_need_plan_type'),iZ=h.indexOf('pbp_a_dsnp_zerodollar');
const by={}; for(let i=1;i<lines.length;i++){const c=lines[i].split('\t'); if(c[iS]!=='3')continue; let g=c[iZ]==='1'?'FULL_DUAL':c[iZ]==='2'?'PARTIAL_DUAL':null; if(!g)continue; const id=`${c[iH]}-${parseInt(c[iP],10)}`; if(!by[id])by[id]=g; else if(by[id]!==g)by[id]='FULL_DUAL';}
const ids=Object.keys(by); console.log('distinct DSNP planIds',ids.length);
(async()=>{const p=makePrisma();
const before=await p.$queryRawUnsafe(`select "dsnpTargetGroup"::text g,count(*)::int n from "Plan" where "planYear"=2027 and "planCategory"='DSNP' group by 1`); console.log('before',JSON.stringify(before));
const vals=ids.map(id=>`('${id.replace(/'/g,"")}','${by[id]}')`).join(',');
const n=await p.$executeRawUnsafe(`update "Plan" p set "dsnpTargetGroup"=v.g::"DsnpTargetGroup" from (values ${vals}) as v(pid,g) where p."planYear"=2027 and p."planCategory"='DSNP' and p."planId"=v.pid`); console.log('rows updated',n);
const after=await p.$queryRawUnsafe(`select "dsnpTargetGroup"::text g,count(*)::int n,count(distinct "planId")::int ids from "Plan" where "planYear"=2027 and "planCategory"='DSNP' group by 1`); console.log('after',JSON.stringify(after));
await p.$disconnect();})().catch(e=>{console.error('ERR',e.message.slice(0,500));process.exit(1)});
