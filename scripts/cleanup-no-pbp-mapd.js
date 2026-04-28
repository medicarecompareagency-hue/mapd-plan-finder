// scripts/cleanup-no-pbp-mapd.js
//
// Deletes MAPD plans that CMS published in the Landscape file but did
// NOT publish PBP data for AND that medicare.gov's Plan Compare doesn't
// surface. These are non-shoppable: EGHP (employer group), closed-to-
// new-enrollment, or sanctioned plans. Agents shouldn't see them.
//
// Verified 2026-04-28 against the medicare.gov plan-compare JSON API:
// of 421 such plans in Dale's licensed states + licensed carriers, all
// 421 returned 404 from /api/v1/data/plan-compare/plan/{year}/{contract}/
// {plan}/{segment}, confirming they aren't shoppable. See
// SOB-API-RESEARCH-2026-04-28.md for the analysis.
//
// "No-PBP signature" (per scripts/list-no-pbp-plans.js): all five of
// these service-level copay fields are NULL:
//   - emergencyRoomCopay
//   - outpatientHospitalCopay
//   - hospitalStayCopay
//   - skilledNursingCopay
//   - catScanCopay
//
// Scope: MAPD only. SNPs (DSNP/CSNP/ISNP), PACE, MSA, COST, MMP,
// MA_ONLY are NOT touched — those categories regularly have NULL
// service-level copays for legitimate reasons (PBP isn't published for
// SNPs in the standard extract; they're added via backfill from PBP
// directly later, but copays may still be NULL when CMS doesn't expose
// them).
//
// Idempotent. Safe to re-run. Safe to run with --dry-run.
//
// Usage (PowerShell):
//   node scripts/cleanup-no-pbp-mapd.js --dry-run
//   node scripts/cleanup-no-pbp-mapd.js

const { makePrisma } = require('./prisma-client');
const { LICENSED_STATES } = require('./licensed-states');

// Carrier allowlist mirrors lib/licensed-carriers.ts. Mirrored here as
// CommonJS so this CLI script doesn't need to import the TS module.
const LICENSED_CARRIERS = [
  'Cigna', 'Cigna Healthcare', 'HealthSpring',
  'UnitedHealthcare', 'Wellcare', 'Aetna Medicare',
  'Humana', 'Devoted Health',
];

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const PLAN_YEAR = parseInt(args.find((a) => /^\d{4}$/.test(a)) || '2026', 10);

async function main() {
  const prisma = makePrisma();

  console.log(`Cleanup no-PBP MAPDs  planYear=${PLAN_YEAR}  ${DRY_RUN ? 'DRY-RUN' : 'LIVE'}`);
  console.log(`Licensed states:   ${LICENSED_STATES.join(', ')}`);
  console.log(`Licensed carriers: ${LICENSED_CARRIERS.join(', ')}`);

  const where = {
    planYear: PLAN_YEAR,
    planCategory: 'MAPD',
    state: { in: LICENSED_STATES },
    organizationName: { in: LICENSED_CARRIERS },
    emergencyRoomCopay: null,
    outpatientHospitalCopay: null,
    hospitalStayCopay: null,
    skilledNursingCopay: null,
    catScanCopay: null,
  };

  const count = await prisma.plan.count({ where });
  console.log(`\nMatching rows (plan x county): ${count.toLocaleString()}`);

  // Show distinct planIds + carrier breakdown for transparency
  const sample = await prisma.plan.findMany({
    where,
    select: { planId: true, organizationName: true },
    distinct: ['planId'],
  });
  const distinctPlans = sample.length;
  console.log(`Distinct plans:               ${distinctPlans}`);

  const byCarrier = {};
  for (const r of sample) {
    byCarrier[r.organizationName] = (byCarrier[r.organizationName] || 0) + 1;
  }
  console.log('\nBreakdown by carrier (distinct plans):');
  for (const [c, n] of Object.entries(byCarrier).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c.padEnd(40)} ${n}`);
  }

  if (DRY_RUN) {
    console.log('\nDRY-RUN: nothing deleted. Re-run without --dry-run to delete.');
    await prisma.$disconnect();
    return;
  }

  console.log('\nDeleting...');
  const t0 = Date.now();
  const result = await prisma.plan.deleteMany({ where });
  const ms = Date.now() - t0;
  console.log(`Deleted ${result.count.toLocaleString()} rows in ${ms}ms.`);

  // Sanity: ensure none remain
  const remaining = await prisma.plan.count({ where });
  console.log(`Remaining matching rows: ${remaining}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
