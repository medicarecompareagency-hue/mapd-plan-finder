// Step A — SSBCI scope audit. Run from repo root:
//   node audit-ssbci.js
// Self-discovers the real SSBCI columns from the DB, then counts.
const { makePrisma } = require('./scripts/prisma-client');
const prisma = makePrisma();

(async () => {
  // 1. Discover actual columns on "Plan" that look like SSBCI dollar fields
  const cols = await prisma.$queryRawUnsafe(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'Plan'
      AND lower(column_name) LIKE '%ssbci%'
    ORDER BY column_name;
  `);

  console.log('\n=== SSBCI columns that actually exist on "Plan" ===');
  for (const c of cols) console.log(`  ${c.column_name}  (${c.data_type})`);

  // Numeric allowance columns = anything not boolean
  const amtCols = cols
    .filter(c => c.data_type !== 'boolean')
    .map(c => c.column_name);

  if (amtCols.length === 0) {
    console.log('\nNo numeric SSBCI allowance columns found. Check column list above.');
    await prisma.$disconnect();
    return;
  }

  // 2. Build the "any non-zero" predicate dynamically
  const anyPred = amtCols.map(c => `"${c}" > 0`).join(' OR ');
  const perField = amtCols
    .map(c => `COUNT(*) FILTER (WHERE "${c}" > 0) AS "${c}"`)
    .join(',\n      ');

  const [totals] = await prisma.$queryRawUnsafe(`
    SELECT
      COUNT(*) AS total_plans,
      COUNT(*) FILTER (WHERE ${anyPred}) AS any_ssbci,
      ${perField}
    FROM "Plan";
  `);

  console.log('\n=== SSBCI scope audit ===');
  console.log('Total plans in DB:    ', String(totals.total_plans));
  console.log('Plans w/ ANY SSBCI $: ', String(totals.any_ssbci), '  <-- potentially misleading today');
  for (const c of amtCols) console.log(`  - ${c}: ${totals[c]}`);
  console.log('');

  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
