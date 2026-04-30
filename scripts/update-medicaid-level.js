// Update Plan.medicaidLevel from a dsnp-integration-levels.json results file.
//
// Input:  scripts/data/dsnp-integration-levels.json (default — override with --in=<path>)
//         { planId -> "FIDE"|"HIDE"|"CO"|"AIP"|null }
// Action: For each planId, set Plan.medicaidLevel for ALL rows with that planId
//         (a planId can have multiple county/state rows).
//
// Lives in the repo at scripts/update-medicaid-level.js. Run with:
//   node scripts/update-medicaid-level.js [--in=<path>]
// Idempotent — running twice is safe.

const path = require('path');
const fs = require('fs');

const { makePrisma } = require('./prisma-client.js');

const inArg = process.argv.find(a => a.startsWith('--in='));
const RESULTS_PATH = inArg
  ? inArg.slice('--in='.length)
  : path.join(__dirname, 'data', 'dsnp-integration-levels.json');

// Per Dale's spec in the 04-28 handoff:
const LABEL = {
  FIDE: 'FIDE (Fully Integrated Dual Eligible)',
  HIDE: 'HIDE (Highly Integrated Dual Eligible)',
  CO:   'Coordination Only',
  AIP:  'Applicable Integrated Plan',
};

(async () => {
  const raw = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));

  const prisma = makePrisma();

  // Bucket the results
  const buckets = { FIDE: [], HIDE: [], CO: [], AIP: [], NULL: [], ERROR: [] };
  for (const [planId, val] of Object.entries(raw)) {
    if (val === null || val === undefined) {
      buckets.NULL.push(planId);
    } else if (typeof val === 'object' && val.__error) {
      buckets.ERROR.push({ planId, status: val.__error });
    } else if (LABEL[val]) {
      buckets[val].push(planId);
    } else {
      console.warn(`Unrecognized integration level "${val}" for ${planId} — skipping`);
    }
  }

  console.log('Result distribution:');
  console.log(`  FIDE:  ${buckets.FIDE.length}`);
  console.log(`  HIDE:  ${buckets.HIDE.length}`);
  console.log(`  CO:    ${buckets.CO.length}`);
  console.log(`  AIP:   ${buckets.AIP.length}`);
  console.log(`  null:  ${buckets.NULL.length}`);
  console.log(`  error: ${buckets.ERROR.length}`);
  if (buckets.ERROR.length) {
    console.log('  errors sample:', buckets.ERROR.slice(0, 5));
  }

  let totalUpdated = 0;
  for (const code of ['FIDE', 'HIDE', 'CO', 'AIP']) {
    const planIds = buckets[code];
    if (planIds.length === 0) continue;
    const label = LABEL[code];
    const result = await prisma.plan.updateMany({
      where: { planId: { in: planIds }, planYear: 2026, planCategory: 'DSNP' },
      data: { medicaidLevel: label },
    });
    console.log(`Updated ${result.count} rows for ${code} (${planIds.length} distinct planIds)`);
    totalUpdated += result.count;
  }

  console.log(`\nTotal rows updated: ${totalUpdated}`);

  // Sanity check: how many DSNP rows still have NULL medicaidLevel?
  const stillNull = await prisma.plan.count({
    where: { planYear: 2026, planCategory: 'DSNP', medicaidLevel: null },
  });
  const totalDsnp = await prisma.plan.count({
    where: { planYear: 2026, planCategory: 'DSNP' },
  });
  console.log(`DSNP coverage: ${totalDsnp - stillNull}/${totalDsnp} rows now have medicaidLevel`);

  await prisma.$disconnect();
})().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
