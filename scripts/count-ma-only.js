// scripts/count-ma-only.js
// Quick check: are MA_ONLY plans already imported?
const { makePrisma } = require('./prisma-client');

(async () => {
  const prisma = makePrisma();

  const cats = await prisma.plan.groupBy({
    by: ['planCategory'],
    where: { planYear: 2026 },
    _count: { _all: true },
  });
  console.log('=== 2026 plan-rows by planCategory (licensed states scope) ===');
  for (const c of cats) {
    console.log(`  ${String(c.planCategory).padEnd(15)} ${c._count._all}`);
  }

  const maOnly = await prisma.plan.findMany({
    where: { planYear: 2026, planCategory: 'MA_ONLY' },
    select: { planId: true, organizationName: true, planType: true, state: true },
  });
  const distinct = new Set(maOnly.map((r) => r.planId));
  const states = new Set(maOnly.map((r) => r.state));
  console.log(`\nMA_ONLY: ${maOnly.length} plan-rows, ${distinct.size} distinct planIds, across ${states.size} states`);

  // Top-level shape check on a few samples
  const sample = await prisma.plan.findMany({
    where: { planYear: 2026, planCategory: 'MA_ONLY' },
    take: 5,
    select: {
      planId: true, planName: true, organizationName: true, planType: true, state: true, county: true,
      monthlyPremium: true, partBGivebackAmount: true,
      hospitalStayCopay: true, specialistCopay: true, pcpCopay: true,
      dentalAnnualMax: true, dentalBenefits: true,
      drugDeductible: true, drugTier1Copay: true,
    },
  });
  console.log('\n=== Sample 5 MA_ONLY plans ===');
  for (const p of sample) {
    console.log(`  ${p.planId}  ${p.organizationName}  ${p.planName}  (${p.state}/${p.county})  type=${p.planType}`);
    console.log(`    premium=${p.monthlyPremium}  giveback=${p.partBGivebackAmount}  hosp=${p.hospitalStayCopay ?? 'NULL'}  spec=${p.specialistCopay ?? 'NULL'}  pcp=${p.pcpCopay ?? 'NULL'}  dentalMax=${p.dentalAnnualMax ?? 'NULL'}  drugTier1=${p.drugTier1Copay ?? 'NULL'} (should be NULL)`);
  }

  // Null-rate audit on the 5 ranking inputs
  const allMa = await prisma.plan.findMany({
    where: { planYear: 2026, planCategory: 'MA_ONLY' },
    select: {
      partBGivebackAmount: true, hospitalStayCopay: true,
      specialistCopay: true, pcpCopay: true, dentalAnnualMax: true,
    },
  });
  const fields = ['partBGivebackAmount', 'hospitalStayCopay', 'specialistCopay', 'pcpCopay', 'dentalAnnualMax'];
  console.log('\n=== MA_ONLY null-rate on Dale\'s 5 ranking inputs ===');
  for (const f of fields) {
    const n = allMa.filter((r) => r[f] == null).length;
    const pct = allMa.length ? (100 * n / allMa.length).toFixed(1) : '0.0';
    console.log(`  ${f.padEnd(22)} ${String(n).padStart(6)} / ${allMa.length}  (${pct}%)`);
  }

  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
