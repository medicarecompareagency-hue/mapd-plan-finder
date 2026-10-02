const path=require('path'); const { makePrisma } = require(path.join(process.cwd(),'scripts/prisma-client.js'));
const F=['pcpCopay','specialistCopay','emergencyRoomCopay','ambulanceCopay','outpatientHospitalCopay','hospitalStayCopay','skilledNursingCopay','mriCopay','catScanCopay','pcpCoinsPct','specialistCoinsPct','ambulanceCoinsPct','outpatientHospitalCoinsPct','mriCoinsPct','drugTier1Copay','drugTier3Copay','drugTier6Copay','drugTierCoinsuranceMask','drugDeductibleTiers','otcMaxPeriod','foodCardMaxPeriod','dentalBenefits','hearingBenefits','visionBenefits','transportationBenefit','dsnpTargetGroup','isZeroDollarDsnp','segmentId'];
(async()=>{const p=makePrisma();
const r=await p.$queryRawUnsafe(`select "planYear" y,"planCategory"::text c,count(*)::int n,${F.map(f=>`count("${f}")::int "${f}"`).join(',')} from "Plan" group by 1,2`);
const cats=['MAPD','MA_ONLY','DSNP','CSNP','ISNP'];
console.log('field'.padEnd(28)+cats.map(c=>(c+' 26/27').padStart(14)).join(''));
for(const f of F){ let line=f.padEnd(28); for(const c of cats){const a=r.find(x=>x.y===2026&&x.c===c),b=r.find(x=>x.y===2027&&x.c===c); const pa=a?Math.round(100*a[f]/a.n):'-',pb=b?Math.round(100*b[f]/b.n):'-'; line+=((pa+'/'+pb)+(Math.abs(pa-pb)>=5?'*':' ')).padStart(14);} console.log(line);}
await p.$disconnect();})().catch(e=>{console.error('ERR',e.message.slice(0,500));process.exit(1)});
