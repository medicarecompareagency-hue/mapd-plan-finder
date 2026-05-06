// scripts/debug-h4461.js
// Why does the reclassify script find 0 DB matches? Sample a known
// MA-Only plan (Humana Honor Giveback H4461-075) and see how it lives
// in the DB vs landscape.

const { makePrisma } = require('./prisma-client');

(async () => {
  const prisma = makePrisma();

  // 1. Look up H4461-75 (no padding, DB format per import script)
  const a = await prisma.plan.findMany({
    where: { planYear: 2026, planId: 'H4461-75' },
    select: { id: true, planId: true, planCategory: true, planName: true, organizationName: true, state: true, county: true },
    take: 5,
  });
  console.log(`=== Rows where planId='H4461-75': ${a.length} ===`);
  for (const r of a) console.log(`  id=${r.id} cat=${r.planCategory} state=${r.state} county=${r.county}  ${r.planName}`);

  // 2. Look up H4461-075 (zero-padded — in case DB stores it that way)
  const b = await prisma.plan.findMany({
    where: { planYear: 2026, planId: 'H4461-075' },
    select: { id: true, planId: true, planCategory: true, planName: true, state: true, county: true },
    take: 5,
  });
  console.log(`\n=== Rows where planId='H4461-075': ${b.length} ===`);
  for (const r of b) console.log(`  id=${r.id} cat=${r.planCategory} state=${r.state} county=${r.county}  ${r.planName}`);

  // 3. All distinct H4461 planIds — what format are they stored in?
  const c = await prisma.plan.findMany({
    where: { planYear: 2026, planId: { startsWith: 'H4461' } },
    select: { planId: true, planCategory: true, planName: true },
    distinct: ['planId'],
    take: 30,
  });
  console.log(`\n=== Distinct H4461* planIds in DB: ${c.length} ===`);
  for (const r of c) console.log(`  ${r.planId}  ${r.planCategory}  ${r.planName}`);

  // 4. Same for H5216 and R0110
  for (const prefix of ['H5216', 'R0110']) {
    const rows = await prisma.plan.findMany({
      where: { planYear: 2026, planId: { startsWith: prefix } },
      select: { planId: true, planCategory: true, planName: true },
      distinct: ['planId'],
      take: 30,
    });
    console.log(`\n=== Distinct ${prefix}* planIds in DB: ${rows.length} ===`);
    for (const r of rows) console.log(`  ${r.planId}  ${r.planCategory}  ${r.planName}`);
  }

  // 5. Sample 5 actual H4461-075 rows in DB to see state/county format
  const d = await prisma.plan.findMany({
    where: { planYear: 2026, planId: { contains: 'H4461' } },
    select: { planId: true, state: true, county: true, planCategory: true, planName: true },
    take: 5,
    orderBy: { id: 'asc' },
  });
  console.log(`\n=== Sample 5 H4461 rows showing exact format ===`);
  for (const r of d) console.log(`  planId='${r.planId}' state='${r.state}' county='${r.county}' cat=${r.planCategory}`);

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
