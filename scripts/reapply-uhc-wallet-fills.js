// scripts/reapply-uhc-wallet-fills.js
// Re-applies SB-verified UHC unswept-family foodCardAllowance fills
// from artifact JSON after a CMS re-import that resets SB-derived columns.
//
// Source: scripts/data/uhc-wallet-fills-2026-07.json
//   node scripts/reapply-uhc-wallet-fills.js          # dry-run
//   node scripts/reapply-uhc-wallet-fills.js --apply  # write
//
const fs = require('fs');
const { makePrisma } = require('./prisma-client');
const prisma = makePrisma();
const APPLY = process.argv.includes('--apply');
const DATA = 'scripts/data/uhc-wallet-fills-2026-07.json';

(async () => {
  if (!fs.existsSync(DATA)) {
    console.log(`  ${DATA} missing — skip reapply-uhc-wallet-fills`);
    return;
  }
  const { fills } = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  console.log(`  reapply-uhc-wallet-fills: ${fills.length} fills from artifact. ${APPLY ? 'APPLY' : 'DRY-RUN'}.`);

  let n = 0;
  for (const f of fills) {
    const data = {
      foodCardAllowance: f.annual,
      ssbciFoodAllowance: f.monthly,
      ssbciIsConditional: true,
      ssbciOffersFood: true,
    };
    if (APPLY) {
      const res = await prisma.plan.updateMany({
        where: {
          planId: f.planId,
          planYear: 2026,
          OR: [{ foodCardAllowance: null }, { foodCardAllowance: 0 }],
        },
        data,
      });
      n += res.count;
    }
    console.log(`    ${f.planId} ${f.state} ${f.cat}: $${f.monthly}/mo ($${f.annual}/yr) -> ${APPLY ? 'written' : 'would write'}`);
  }
  if (APPLY) console.log(`  reapply-uhc-wallet-fills: ${n} county rows updated.`);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
