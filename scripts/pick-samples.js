const { makePrisma } = require('./prisma-client');
(async () => {
  const p = makePrisma();
  const dsnp = await p.plan.findFirst({
    where: { planCategory: 'DSNP', planYear: 2026, planType: 'HMO', dsnpTargetGroup: 'FULL_DUAL', pcpCopay: null },
    select: { planId: true, planType: true, dsnpTargetGroup: true, organizationName: true, state: true, pcpCopay: true, emergencyRoomCopay: true },
  });
  const nonDsnp = await p.plan.findFirst({
    where: { planCategory: 'MAPD', planYear: 2026, planType: 'HMO', pcpCopay: { not: null } },
    select: { planId: true, planType: true, planCategory: true, organizationName: true, state: true, pcpCopay: true, emergencyRoomCopay: true },
  });
  console.log('DSNP sample (pcpCopay null):', JSON.stringify(dsnp, null, 2));
  console.log('Non-DSNP sample (pcpCopay populated):', JSON.stringify(nonDsnp, null, 2));
  await p.$disconnect();
})();
