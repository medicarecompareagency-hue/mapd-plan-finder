const { makePrisma } = require('./prisma-client');

(async () => {
  const p = makePrisma();
  const where = { planCategory: 'DSNP', planYear: 2026 };
  const total = await p.plan.count({ where });

  const fields = [
    'pcpCopay',
    'specialistCopay',
    'emergencyRoomCopay',
    'ambulanceCopay',
    'outpatientHospitalCopay',
    'mriCopay',
    'catScanCopay',
    'hospitalStayCopay',
    'skilledNursingCopay',
  ];

  console.log(`DSNP 2026 plans: ${total}\n`);
  for (const f of fields) {
    const nullCount = await p.plan.count({ where: { ...where, [f]: null } });
    const pct = ((nullCount / total) * 100).toFixed(0);
    console.log(f.padEnd(28), ':', String(nullCount).padStart(6), '/', total, `(${pct}% NULL)`);
  }

  await p.$disconnect();
})();
