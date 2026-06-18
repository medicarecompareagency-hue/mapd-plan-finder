// scripts/specialist-baseline.js — read-only carrier coverage snapshot
const { makePrisma } = require('./prisma-client');
const prisma = makePrisma();
(async () => {
  const plans = await prisma.plan.findMany({ where:{ planYear:2026 },
    select:{ planId:true, organizationName:true, specialistCopay:true, specialistCoinsPct:true, sbPdfUrl:true }, distinct:['planId'] });
  const byCarrier = {};
  for (const p of plans) {
    const c = p.organizationName || '(none)';
    const b = byCarrier[c] || (byCarrier[c] = { n:0, noSb:0, nullSpec:0, urls:new Set() });
    b.n++; if (!p.sbPdfUrl) b.noSb++; else b.urls.add(p.sbPdfUrl);
    if (p.specialistCopay == null && p.specialistCoinsPct == null) b.nullSpec++;
  }
  console.log('carrier | plans | noSB | nullSpecialist | distinctSBpdfs');
  for (const [c,b] of Object.entries(byCarrier).sort((a,b)=>b[1].n-a[1].n))
    console.log(`  ${c} | ${b.n} | ${b.noSb} | ${b.nullSpec} | ${b.urls.size}`);
  const totalPdfs = new Set(plans.filter(p=>p.sbPdfUrl).map(p=>p.sbPdfUrl)).size;
  console.log(`\nTotal distinct plans: ${plans.length} | distinct SB PDFs to read: ${totalPdfs}`);
  await prisma.$disconnect();
})().catch(async e=>{ console.error(e); try{await prisma.$disconnect()}catch{}; process.exit(1); });
