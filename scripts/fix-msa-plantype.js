// scripts/fix-msa-plantype.js
// Remaps planType='MSA' to the correct value from cmsContractType.
// Run: node scripts/fix-msa-plantype.js
// Add --apply to write changes (default is dry-run).

const { makePrisma } = require('./prisma-client');

const APPLY = process.argv.includes('--apply');

const CMS_CONTRACT_TYPE_MAP = {
  'Local HMO':    'HMO',
  'Local PPO':    'PPO',
  'Regional PPO': 'PPO',
  'PFFS':         'PFFS',
  'HMO-POS':      'HMO-POS',
  'MSA':          'MSA',
  'Cost':         'Cost',
};

const NON_MSA_CATEGORIES = ['MAPD', 'DSNP', 'CSNP', 'ISNP', 'MA_ONLY'];

(async () => {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}\n`);
  const prisma = makePrisma();

  const msaPlans = await prisma.plan.findMany({
    where: { planType: 'MSA', planYear: 2026 },
    select: {
      planId: true,
      state: true,
      organizationName: true,
      planCategory: true,
      planType: true,
      cmsContractType: true,
    },
    distinct: ['planId'],
  });

  console.log(`Total distinct plans with planType='MSA': ${msaPlans.length}`);

  const fixes = [];
  const genuine = [];
  const unknown = [];

  for (const plan of msaPlans) {
    const cat = plan.planCategory || '';
    const cms = plan.cmsContractType || '';

    if (NON_MSA_CATEGORIES.includes(cat)) {
      const newType = CMS_CONTRACT_TYPE_MAP[cms] || null;
      if (newType && newType !== 'MSA') {
        fixes.push({ ...plan, newType });
      } else {
        unknown.push({ ...plan, reason: `cmsContractType='${cms}' has no mapping` });
      }
    } else {
      if (cms === 'MSA' || !cms) {
        genuine.push(plan);
      } else {
        const newType = CMS_CONTRACT_TYPE_MAP[cms];
        if (newType && newType !== 'MSA') {
          fixes.push({ ...plan, newType });
        } else {
          genuine.push(plan);
        }
      }
    }
  }

  console.log(`\nPlans to fix (mislabeled as MSA): ${fixes.length}`);
  for (const f of fixes) {
    console.log(`  ${f.planId} (${f.organizationName}, ${f.state}, ${f.planCategory}): MSA -> ${f.newType}  [cmsContractType='${f.cmsContractType}']`);
  }

  console.log(`\nGenuine MSA plans (leaving alone): ${genuine.length}`);
  for (const g of genuine) {
    console.log(`  ${g.planId} (${g.organizationName}, ${g.state}, ${g.planCategory})`);
  }

  if (unknown.length > 0) {
    console.log(`\nUnknown - no mapping found: ${unknown.length}`);
    for (const u of unknown) {
      console.log(`  ${u.planId}: ${u.reason}`);
    }
  }

  if (!APPLY) {
    console.log('\nDRY-RUN complete. Run with --apply to write changes.');
    await prisma.$disconnect();
    return;
  }

  console.log('\nApplying fixes...');
  let totalRows = 0;
  for (const f of fixes) {
    const result = await prisma.plan.updateMany({
      where: { planId: f.planId, planYear: 2026, planType: 'MSA' },
      data: { planType: f.newType },
    });
    totalRows += result.count;
    console.log(`  ${f.planId}: updated ${result.count} rows -> '${f.newType}'`);
  }
  console.log(`\nTotal rows updated: ${totalRows} across ${fixes.length} plans`);

  const remaining = await prisma.plan.count({
    where: {
      planType: 'MSA',
      planYear: 2026,
      planCategory: { in: ['MAPD', 'DSNP', 'CSNP', 'ISNP', 'MA_ONLY'] },
    },
  });
  console.log(`\nVerification - remaining MSA rows with non-MSA planCategory: ${remaining} (should be 0)`);

  await prisma.$disconnect();
})();
