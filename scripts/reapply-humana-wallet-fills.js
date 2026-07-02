// scripts/reapply-humana-wallet-fills.js
// Re-applies SB-verified Humana Healthy Options sbVerifiedFoodAmount fills
// from the artifact JSON after a CMS re-import that resets SB-derived columns.
//
// Source: scripts/data/humana-wallet-fills-2026.json
//   node scripts/reapply-humana-wallet-fills.js          # dry-run
//   node scripts/reapply-humana-wallet-fills.js --apply  # write
//
const fs = require('fs');
const { makePrisma } = require('./prisma-client');
const prisma = makePrisma();
const APPLY = process.argv.includes('--apply');
const DATA = 'scripts/data/humana-wallet-fills-2026.json';

(async () => {
  if (!fs.existsSync(DATA)) {
    console.log(`  ${DATA} missing — skip reapply-humana-wallet-fills`);
    return;
  }
  const { fills } = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  console.log(`  reapply-humana-wallet-fills: ${fills.length} fills from artifact. ${APPLY ? 'APPLY' : 'DRY-RUN'}.`);

  let n = 0;
  for (const f of fills) {
    const data = {
      sbVerifiedFoodAmount: f.annual,
      sbVerifiedFoodPeriod: 'month',
      ssbciIsConditional: true,
      ssbciOffersFood: true,
    };
    if (APPLY) {
      const res = await prisma.plan.updateMany({
        where: {
          planId: f.planId,
          planYear: 2026,
          OR: [{ sbVerifiedFoodAmount: null }, { sbVerifiedFoodAmount: 0 }],
        },
        data,
      });
      n += res.count;
    }
    console.log(`    ${f.planId} ${f.state} ${f.cat}: $${f.monthly}/mo ($${f.annual}/yr) -> ${APPLY ? 'written' : 'would write'}`);
  }
  if (APPLY) console.log(`  reapply-humana-wallet-fills: ${n} county rows updated.`);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
