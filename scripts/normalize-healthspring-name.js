// scripts/normalize-healthspring-name.js
//
// Renames organizationName "Cigna" and "Cigna Healthcare" to "HealthSpring"
// in the Plan table so the UI displays the carrier's current 2026 brand
// consistently.
//
// Per Dale 2026-05-06: HealthSpring rebranded back to its original name in
// 2026. CMS PBP data still says "Cigna" / "Cigna Healthcare" (data lag).
// All three names remain in licensed-carriers.ts for safety, but DB display
// normalizes to "HealthSpring".
//
// Usage:
//   node scripts/normalize-healthspring-name.js              # dry-run
//   node scripts/normalize-healthspring-name.js --apply      # write

const { makePrisma } = require('./prisma-client');

const APPLY = process.argv.includes('--apply');

(async () => {
  const prisma = makePrisma();

  console.log(`=== Normalize Cigna -> HealthSpring ===`);
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  for (const old of ['Cigna', 'Cigna Healthcare']) {
    const count = await prisma.plan.count({ where: { organizationName: old } });
    console.log(`  Rows with organizationName='${old}': ${count}`);
  }
  const already = await prisma.plan.count({ where: { organizationName: 'HealthSpring' } });
  console.log(`  Rows already 'HealthSpring': ${already}\n`);

  if (!APPLY) {
    console.log('[DRY RUN] No DB writes. Re-run with --apply.');
    await prisma.$disconnect();
    return;
  }

  const r = await prisma.plan.updateMany({
    where: { organizationName: { in: ['Cigna', 'Cigna Healthcare'] } },
    data: { organizationName: 'HealthSpring' },
  });
  console.log(`Renamed ${r.count} rows to 'HealthSpring'.`);

  // Confirm
  const after = await prisma.plan.count({ where: { organizationName: 'HealthSpring' } });
  const remaining = await prisma.plan.count({ where: { organizationName: { in: ['Cigna', 'Cigna Healthcare'] } } });
  console.log(`Final HealthSpring count: ${after}`);
  console.log(`Cigna/Cigna Healthcare remaining: ${remaining} (should be 0)`);

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
