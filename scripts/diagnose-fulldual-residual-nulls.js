// scripts/diagnose-fulldual-residual-nulls.js
//
// After 2026-05-05 Part 3 enrichment, three fields still have NULL residuals
// on FULL_DUAL DSNPs:
//   specialistCopay  17.6%
//   mriCopay         24.9%
//   catScanCopay     24.9%
//
// This script asks: for the rows where these fields are NULL, what does PBP
// say? Three possibilities:
//   (a) PBP has neither copay nor coinsurance for that service → data gap,
//       can't be auto-filled, leave NULL.
//   (b) PBP has coinsurance but our Part 3 script's PBP_FIELDS map didn't
//       include the right column for that service → script bug, fixable.
//   (c) PBP has a copay but the main enrichment skipped this row → main
//       enrichment bug, fixable.
//
// We need to know which.

const { makePrisma } = require('./prisma-client');

async function main() {
  const prisma = makePrisma();

  // Sample 5 NULL specialistCopay FULL_DUAL DSNP plans
  for (const field of ['specialistCopay', 'mriCopay', 'catScanCopay']) {
    console.log(`\n=== Sample 5 plans where ${field} is NULL ===`);
    const sample = await prisma.plan.findMany({
      where: {
        planYear: 2026, planCategory: 'DSNP', dsnpTargetGroup: 'FULL_DUAL',
        [field]: null,
      },
      select: { planId: true, planName: true, organizationName: true, state: true, county: true },
      take: 5,
    });
    for (const p of sample) {
      console.log(`  ${p.planId}  ${p.organizationName}  ${p.planName}  (${p.state}/${p.county})`);
    }
  }

  // Also: how many distinct planIds are affected vs how many county-rows?
  // (Big multiplier means a small number of PBPs are missing the data, not a
  // wide quality issue.)
  for (const field of ['specialistCopay', 'mriCopay', 'catScanCopay']) {
    const rows = await prisma.plan.findMany({
      where: {
        planYear: 2026, planCategory: 'DSNP', dsnpTargetGroup: 'FULL_DUAL',
        [field]: null,
      },
      select: { planId: true },
    });
    const distinctPlans = new Set(rows.map((r) => r.planId)).size;
    console.log(`\n${field}: ${rows.length} county-rows across ${distinctPlans} distinct planIds`);
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
