const { makePrisma } = require('./prisma-client');

(async () => {
  const p = makePrisma();
  const rows = await p.$queryRawUnsafe(`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND (
        column_name ILIKE '%target%'
        OR column_name ILIKE '%dual%'
        OR column_name ILIKE '%qmb%'
        OR column_name ILIKE '%slmb%'
        OR column_name ILIKE '%fbde%'
        OR table_name ILIKE '%target%'
        OR table_name ILIKE '%dual%'
        OR table_name ILIKE '%benefit%group%'
      )
    ORDER BY table_name, column_name;
  `);
  console.log(JSON.stringify(rows, null, 2));
  await p.$disconnect();
})();
