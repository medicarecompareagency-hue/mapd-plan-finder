const fs=require('fs'),path=require('path');
const {parse}=require(path.join(process.cwd(),'node_modules/csv-parse/dist/cjs/sync.cjs'));
const {LICENSED_STATES}=require(path.join(process.cwd(),'scripts/licensed-states'));
const CAR=new Set(['HealthSpring','Cigna','Cigna Healthcare','UnitedHealthcare','Wellcare','Aetna Medicare','Humana','Devoted Health']);
const ST=new Set(LICENSED_STATES);
const land=parse(fs.readFileSync('.cms-import-tmp/cy2027-landscape/CY2027_Landscape_202609.csv'),{columns:true,bom:true,skip_empty_lines:true,relax_column_count:true});
const org=new Map(); const L=new Map(); // planId -> Set(state|county)
const Lseg=new Map();
for(const r of land){ if(r['Contract Category Type']==='PDP')continue; org.set(r['Contract ID'],r['Organization Marketing Name']);
  if(!ST.has(r['State Territory Abbreviation'])||!CAR.has(r['Organization Marketing Name']))continue;
  const id=r['Contract ID']+'-'+parseInt(r['Plan ID'],10); if(!L.has(id))L.set(id,{rows:0,sc:new Set(),type:r['Contract Category Type']+'/'+r['Plan Type'],car:r['Organization Marketing Name'],segs:new Set()});
  const e=L.get(id); e.rows++; e.sc.add(r['State Territory Abbreviation']+'|'+r['County Name'].toUpperCase()); e.segs.add(r['Segment ID']);}
const lines=fs.readFileSync('.cms-import-tmp/pbp-2027/PlanArea.txt','latin1').split(/\r?\n/).filter(Boolean);
const h=lines[0].split('\t').map(x=>x.trim()); const ix=n=>h.indexOf(n);
const iHn=ix('pbp_a_hnumber'),iPl=ix('pbp_a_plan_identifier'),iSt=ix('stcd'),iCo=ix('county'),iPe=ix('pending_flag'),iEg=ix('eghp_flag');
console.log('PlanArea header',h.join(','));
const P=new Map(); const seen=new Set(); let pend=0,eghp=0;
for(const line of lines.slice(1)){const c=line.split('\t'); const ct=c[iHn]?.trim().toUpperCase(), pl=c[iPl]?.trim(), st=c[iSt]?.trim(), co=c[iCo]?.trim();
  if(!ct||!pl||!st||!co)continue; if(!ST.has(st))continue; if(!CAR.has(org.get(ct)))continue;
  if(c[iPe]?.trim()==='1'){pend++;continue} if(c[iEg]?.trim()==='1'){eghp++;continue}
  if(parseInt(pl,10)>=800)continue;
  const k=ct+'|'+pl+'|'+st+'|'+co; if(seen.has(k))continue; seen.add(k);
  const id=ct+'-'+parseInt(pl,10); if(!P.has(id))P.set(id,{rows:0}); P.get(id).rows++;}
let pr=0;for(const v of P.values())pr+=v.rows; let lr=0,lsc=0;for(const v of L.values()){lr+=v.rows;lsc+=v.sc.size}
console.log('PlanArea(import-like): planIds',P.size,'rows',pr,'| pending-skipped',pend,'eghp-skipped',eghp);
console.log('Landscape: planIds',L.size,'rows',lr,'distinct state|county per plan',lsc);
const onlyL=[...L.keys()].filter(k=>!P.has(k)), onlyP=[...P.keys()].filter(k=>!L.has(k));
console.log('in landscape not PlanArea:',onlyL.length, onlyL.slice(0,25).map(k=>k+'('+L.get(k).car+' '+L.get(k).type+' '+L.get(k).rows+')').join(', '));
let rowsOnlyL=0; const byType={}; for(const k of onlyL){rowsOnlyL+=L.get(k).rows; byType[L.get(k).car+' '+L.get(k).type]=(byType[L.get(k).car+' '+L.get(k).type]||0)+L.get(k).rows} console.log('rows',rowsOnlyL,byType);
console.log('in PlanArea not landscape:',onlyP.length, onlyP.slice(0,25).join(', '));
let diff=0,segdup=0; const ex=[]; for(const [k,v] of L){ if(!P.has(k))continue; const d=v.sc.size-P.get(k).rows; if(d!==0){diff++; if(ex.length<15)ex.push(k+' land='+v.sc.size+' pa='+P.get(k).rows+' segs='+v.segs.size)} segdup+=v.rows-v.sc.size;}
console.log('common plans with county-count mismatch:',diff,ex.join('; ')); console.log('landscape rows that are extra segments in same county:',segdup);
