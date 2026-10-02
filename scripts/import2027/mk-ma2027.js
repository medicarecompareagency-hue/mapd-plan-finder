const fs=require('fs'),path=require('path');
const {parse}=require(path.join(process.cwd(),'node_modules/csv-parse/dist/cjs/sync.cjs'));
const rows=parse(fs.readFileSync('.cms-import-tmp/cy2027-landscape/CY2027_Landscape_202609.csv'),{columns:true,bom:true,skip_empty_lines:true,relax_column_count:true});
const q=s=>'"'+String(s??'').replace(/"/g,'""')+'"';
const seen=new Set(); const out=['contractid,planid,organizationname,planname'];
for(const r of rows){ if(r['Contract Category Type']==='PDP')continue;
  const k=r['Contract ID']+'-'+parseInt(r['Plan ID'],10); if(seen.has(k))continue; seen.add(k);
  out.push([q(r['Contract ID']),q(parseInt(r['Plan ID'],10)),q(r['Organization Marketing Name']),q(r['Plan Name'])].join(','));}
const dest='.cms-import-tmp/ma2027.csv';
if(fs.existsSync(dest)){console.log('EXISTS, not overwriting');process.exit(1)}
fs.writeFileSync(dest,out.join('\n')+'\n'); console.log('wrote',dest,out.length-1,'contract-plans');
