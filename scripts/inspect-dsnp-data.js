const { makePrisma } = require('./prisma-client');

(async () => {
  const p = makePrisma();

  console.log('=== ALL TABLES IN public ===');
  const tables = await p.$queryRawUnsafe(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name;
  `);
  console.log(tables.map(t => t.table_name).join('\n'));

  console.log('\n=== dsnpTargetGroup distribution (DSNP 2026) ===');
  const groups = await p.$queryRawUnsafe(`
    SELECT "dsnpTargetGroup", COUNT(*) AS cnt
    FROM "Plan"
    WHERE "planCategory" = 'DSNP' AND "planYear" = 2026
    GROUP BY "dsnpTargetGroup"
    ORDER BY cnt DESC;
  `);
  console.log(JSON.stringify(groups.map(g => ({ ...g, cnt: Number(g.cnt) })), null, 2));

  await p.$disconnect();
})();
