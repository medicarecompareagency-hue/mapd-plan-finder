const { makePrisma } = require('./prisma-client');
const p = makePrisma();
(async () => {
  // Verify H4513-46
  const h4513 = await p.plan.findFirst({
    where: { planId: 'H4513-46', planYear: 2026 },
    select: { planId:true, planName:true, specialistCopay:true, specialistCoinsPct:true },
  });
  console.log('H4513-46:', JSON.stringify(h4513));

  // Verify H2802-64 food card
  const h2802 = await p.plan.findFirst({
    where: { planId: 'H2802-64', planYear: 2026 },
    select: { planId:true, sbVerifiedFoodAmount:true, sbVerifiedFoodPeriod:true, foodCardAllowance:true, foodCardMaxPeriod:true, ssbciFoodAllowance:true, ssbciIsConditional:true },
  });
  console.log('H2802-64:', JSON.stringify(h2802));

  // Confirm 0 Cigna plan names
  const cignaCount = await p.plan.count({ where: { planYear: 2026, planName: { contains: 'Cigna', mode: 'insensitive' } } });
  console.log('Cigna planName rows remaining:', cignaCount);

  await p.$disconnect();
})().catch(async e => { console.error(e); try{await p.$disconnect()}catch{}; process.exit(1); });
