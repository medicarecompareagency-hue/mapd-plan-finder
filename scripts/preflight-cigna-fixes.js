// scripts/preflight-cigna-fixes.js — READ-ONLY. Confirms fields + target rows.
const { makePrisma } = require('./prisma-client');
const prisma = makePrisma();
(async () => {
  const sample = await prisma.plan.findFirst();
  if (!sample) { console.error('no plans'); process.exit(1); }
  const F = Object.keys(sample);
  console.log('Plan fields:\n  ' + F.join(', ') + '\n');
  const want = ['planId','planName','organizationName','state','planYear','planCategory',
    'contractType','planType','specialistCopay','specialistCoinsPct',
    'foodCardAllowance','foodCardPeriod','ssbciFoodAllowance','ssbciOffersFood',
    'ssbciOffersUtilities','ssbciPersonalServicesAllowance','ssbciIsConditional',
    'ssbciConditionNote','otcAllowance','otcMaxPeriod','segmentId','sbPdfUrl'
  ].filter(f => F.includes(f));
  const sel = Object.fromEntries(want.map(f => [f, true]));
  console.log('Fields present we will use:\n  ' + want.join(', ') + '\n');

  for (const id of ['H4513-46','H4513-046','H4513-46-001','H2802-64','H2802-064']) {
    const rows = await prisma.plan.findMany({ where: { planId: id }, select: sel });
    console.log(`=== planId == "${id}" : ${rows.length} row(s) ===`);
    for (const r of rows.slice(0,2)) console.log(JSON.stringify(r, null, 2));
  }

  for (const pref of ['H4513-','H2802-']) {
    const rows = await prisma.plan.findMany({
      where: { planId: { startsWith: pref }, planYear: 2026 },
      select: { planId:true, organizationName:true, specialistCopay:true, specialistCoinsPct:true, planName:true },
      distinct: ['planId'], orderBy: { planId: 'asc' },
    });
    console.log(`\n-- ${pref}* 2026 (${rows.length}) : planId | spec$ | specCoins% | name --`);
    for (const r of rows) console.log('  ', r.planId, '|', r.specialistCopay, '|', r.specialistCoinsPct, '|', r.planName);
  }

  const cigna = await prisma.plan.findMany({
    where: { planName: { contains: 'Cigna', mode: 'insensitive' }, planYear: 2026 },
    select: { planId:true, planName:true, organizationName:true, state:true },
    distinct: ['planId'], orderBy: { planId: 'asc' },
  });
  console.log(`\n-- Cigna-named 2026 plans (${cigna.length} distinct planIds) --`);
  for (const r of cigna) console.log('  ', r.planId, '|', r.state, '|', r.planName);

  await prisma.$disconnect();
})().catch(async e => { console.error(e); try{await prisma.$disconnect()}catch{}; process.exit(1); });
