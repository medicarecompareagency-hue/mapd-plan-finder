// scripts/cleanup-unlicensed-carriers.js
//
// One-shot DB hygiene: delete plan rows where organizationName isn't in
// LICENSED_CARRIERS. Cleanup is necessary because:
//
//   1. The original CMS import never gated on carrier (only state)
//   2. Today's backfill runs (PACE/COST + MA_ONLY) also didn't gate on
//      carrier, so they pulled in VIVA, Lasso, Memorial Hermann, etc.
//   3. The route's API filter already hides these from users, but they
//      bloat the DB and confuse audit / verification scripts
//
// Per Dale 2026-05-06:
//   - Add "Cigna Healthcare" alongside "Cigna" (HealthSpring rebrand)
//   - Drop ALL Wellcare sub-brands (Allwell, Meridian, Absolute, Superior)
//   - Drop UnitedHealthcare Community Plan
//   - Drop Aetna Medicare FIDE
//   - Drop everything else (VIVA, Anthem, BCBS variants, Molina, etc.)
//
// Usage:
//   node scripts/cleanup-unlicensed-carriers.js              # dry-run
//   node scripts/cleanup-unlicensed-carriers.js --apply      # delete

const { makePrisma } = require('./prisma-client');

const APPLY = process.argv.includes('--apply');

// Inline copy of lib/licensed-carriers.ts (kept in sync manually).
const LICENSED_CARRIERS = [
  'Cigna',
  'Cigna Healthcare',
  'UnitedHealthcare',
  'Wellcare',
  'Aetna Medicare',
  'Humana',
  'Devoted Health',
];

(async () => {
  const prisma = makePrisma();

  console.log(`=== Cleanup unlicensed carriers ===`);
  console.log(`Mode: ${APPLY ? 'APPLY (will delete from DB)' : 'DRY RUN'}`);
  console.log(`Licensed carriers (${LICENSED_CARRIERS.length}):`);
  for (const c of LICENSED_CARRIERS) console.log(`  - ${c}`);
  console.log('');

  // Count what would be deleted
  const totalToDelete = await prisma.plan.count({
    where: { organizationName: { notIn: LICENSED_CARRIERS } },
  });
  const totalKept = await prisma.plan.count({
    where: { organizationName: { in: LICENSED_CARRIERS } },
  });
  console.log(`Rows to delete (unlicensed): ${totalToDelete.toLocaleString()}`);
  console.log(`Rows to keep (licensed):     ${totalKept.toLocaleString()}`);

  // Group by carrier to show top deletes
  const groups = await prisma.plan.groupBy({
    by: ['organizationName'],
    where: { organizationName: { notIn: LICENSED_CARRIERS } },
    _count: { _all: true },
    orderBy: { _count: { organizationName: 'desc' } },
  });
  console.log(`\nTop 30 carriers to delete:`);
  for (const g of groups.slice(0, 30)) {
    console.log(`  ${String(g._count._all).padStart(6)}  ${g.organizationName}`);
  }
  if (groups.length > 30) console.log(`  ...and ${groups.length - 30} more`);

  if (!APPLY) {
    console.log('\n[DRY RUN] No DB writes. Re-run with --apply to delete.');
    await prisma.$disconnect();
    return;
  }

  console.log('\nDeleting...');
  const result = await prisma.plan.deleteMany({
    where: { organizationName: { notIn: LICENSED_CARRIERS } },
  });
  console.log(`Deleted ${result.count.toLocaleString()} rows.`);

  // Re-run the licensed counts to confirm
  const after = await prisma.plan.count({});
  console.log(`\nDB row total after cleanup: ${after.toLocaleString()}`);

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
