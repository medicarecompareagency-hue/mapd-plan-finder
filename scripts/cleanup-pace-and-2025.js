// scripts/cleanup-pace-and-2025.js
//
// Deletes two buckets from the Plan table:
//   1. All plans where planYear = 2025 (stale, Dale doesn't sell historical).
//   2. All plans where planCategory = 'PACE' (Dale doesn't sell PACE).
//
// Dry-run by default. Set CONFIRM=yes to actually delete.
//
// Usage (from repo root):
//   node scripts/cleanup-pace-and-2025.js            # dry run, shows counts only
//   $env:CONFIRM='yes'; node scripts/cleanup-pace-and-2025.js   # actually deletes

const { makePrisma } = require('./prisma-client');

const CONFIRM = process.env.CONFIRM === 'yes';

async function reportCounts(prisma, label) {
  console.log(`--- ${label} ---`);
  const total = await prisma.plan.count();
  console.log(`  total plans: ${total}`);

  const byYear = await prisma.plan.groupBy({
    by: ['planYear'],
    _count: { _all: true },
    orderBy: { planYear: 'asc' },
  });
  console.log('  by planYear:');
  for (const r of byYear) {
    console.log(`    ${r.planYear}: ${r._count._all}`);
  }

  const byCat = await prisma.plan.groupBy({
    by: ['planCategory'],
    _count: { _all: true },
  });
  console.log('  by planCategory:');
  for (const r of byCat.sort((a, b) => b._count._all - a._count._all)) {
    console.log(`    ${r.planCategory || '(null)'}: ${r._count._all}`);
  }
  console.log('');
}

async function main() {
  const prisma = makePrisma();

  console.log(`Mode: ${CONFIRM ? 'LIVE DELETE' : 'DRY RUN (set CONFIRM=yes to delete)'}\n`);

  await reportCounts(prisma, 'BEFORE');

  // Count what would be deleted
  const count2025 = await prisma.plan.count({ where: { planYear: 2025 } });
  const countPACE = await prisma.plan.count({ where: { planCategory: 'PACE' } });
  // PACE plans in planYear=2025 will be caught by both deletions — count overlap so we don't double-report.
  const countBoth = await prisma.plan.count({
    where: { planYear: 2025, planCategory: 'PACE' },
  });

  console.log('--- DELETE TARGETS ---');
  console.log(`  planYear=2025:             ${count2025}`);
  console.log(`  planCategory=PACE:         ${countPACE}`);
  console.log(`  (overlap, counted once):   ${countBoth}`);
  console.log(`  unique rows to delete:     ${count2025 + countPACE - countBoth}`);
  console.log('');

  if (!CONFIRM) {
    console.log('Dry run complete. Set CONFIRM=yes to actually delete.');
    await prisma.$disconnect();
    return;
  }

  console.log('Deleting planYear=2025 ...');
  const del1 = await prisma.plan.deleteMany({ where: { planYear: 2025 } });
  console.log(`  deleted: ${del1.count}`);

  console.log('Deleting planCategory=PACE ...');
  const del2 = await prisma.plan.deleteMany({ where: { planCategory: 'PACE' } });
  console.log(`  deleted: ${del2.count}`);
  console.log('');

  await reportCounts(prisma, 'AFTER');

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
