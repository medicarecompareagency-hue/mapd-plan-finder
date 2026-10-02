const path=require('path'); const { makePrisma } = require(path.join(process.cwd(),'scripts/prisma-client.js'));
(async()=>{const p=makePrisma(); const q=(s,...a)=>p.$queryRawUnsafe(s,...a);
const snap=await q(`select count(*)::int n, max("updatedAt") mx, md5(string_agg(md5(t::text),'' order by id)) h from "Plan" t where "planYear"=2026`);
console.log('SNAPSHOT2026',JSON.stringify(snap)); 
const cols=(await q(`select column_name c, data_type t from information_schema.columns where table_name='Plan' order by ordinal_position`));
const sel=cols.filter(c=>!['id','createdAt','updatedAt'].includes(c.c)).map(c=>`count("${c.c}")::int as "${c.c}"`).join(',');
const r=await q(`select "planYear" y, count(*)::int n, ${sel} from "Plan" group by 1 order by 1`);
const a=r.find(x=>x.y===2026), b=r.find(x=>x.y===2027);
console.log('col | type | 2026 filled% | 2027 filled%');
for(const c of cols){ if(['id','createdAt','updatedAt'].includes(c.c))continue; const fa=(100*a[c.c]/a.n).toFixed(0), fb=(100*b[c.c]/b.n).toFixed(0); const flag=Math.abs(fa-fb)>=3?'  <<<':''; console.log(`${c.c} | ${c.t} | ${fa} | ${fb}${flag}`);}
await p.$disconnect();})().catch(e=>{console.error('ERR',e.message.slice(0,600));process.exit(1)});
