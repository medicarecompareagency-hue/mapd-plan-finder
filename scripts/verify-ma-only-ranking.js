// scripts/verify-ma-only-ranking.js
//
// Smoke test the MA_ONLY 5-key ranking spec (Dale 2026-05-06):
//   1. partBGivebackAmount  DESC
//   2. hospitalStayCopay    ASC  (parsed via day-1 regex)
//   3. specialistCopay      ASC
//   4. pcpCopay             ASC
//   5. dentalAnnualMax      DESC
//
// Mirrors plans-route.MA_ONLY.ts ranking logic. NULL sorts last for all keys.
//
// Usage:
//   node scripts/verify-ma-only-ranking.js              # default STATE=AL
//   $env:STATE='MS'; node scripts/verify-ma-only-ranking.js
//   $env:STATE='FL'; node scripts/verify-ma-only-ranking.js

const { makePrisma } = require('./prisma-client');

const STATE = process.env.STATE || 'AL';
const YEAR = parseInt(process.env.YEAR || '2026', 10);

function parseHospDay1(s) {
  if (s == null) return null;
  const v = String(s).trim();
  if (!v || /^none$/i.test(v)) return null;
  let m = v.match(/\$?\s*(\d+(?:\.\d+)?)\s*(?:\/|per\s*)day/i);
  if (m) return parseFloat(m[1]);
  m = v.match(/\$?\s*(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

function ascNullLast(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a - b;
}
function descNullLast(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return b - a;
}

(async () => {
  const prisma = makePrisma();
  const rows = await prisma.plan.findMany({
    where: { planYear: YEAR, planCategory: 'MA_ONLY', state: STATE },
    select: {
      planId: true, planName: true, organizationName: true, planType: true, state: true, county: true,
      partBGivebackAmount: true, hospitalStayCopay: true,
      specialistCopay: true, pcpCopay: true,
      dentalAnnualMax: true, dentalBenefits: true,
      monthlyPremium: true,
    },
    take: 50000,
  });
  console.log(`=== MA_ONLY rows in ${STATE} for ${YEAR}: ${rows.length} ===`);

  // Dedupe by planId, picking the row with the most complete data
  const byPlan = new Map();
  for (const p of rows) {
    const score =
      (p.partBGivebackAmount != null) + (p.hospitalStayCopay != null) +
      (p.specialistCopay != null) + (p.pcpCopay != null) +
      (p.dentalAnnualMax != null && p.dentalAnnualMax > 0);
    const prev = byPlan.get(p.planId);
    if (!prev || score > prev._score) { p._score = score; byPlan.set(p.planId, p); }
  }
  const uniq = [...byPlan.values()];
  console.log(`Unique plans after dedupe: ${uniq.length}\n`);

  // 5-key MA_ONLY ranking, mirrors plans-route.MA_ONLY.ts
  uniq.sort((a, b) => {
    let c;
    c = descNullLast(a.partBGivebackAmount, b.partBGivebackAmount); if (c) return c;
    c = ascNullLast(parseHospDay1(a.hospitalStayCopay), parseHospDay1(b.hospitalStayCopay)); if (c) return c;
    c = ascNullLast(a.specialistCopay, b.specialistCopay); if (c) return c;
    c = ascNullLast(a.pcpCopay, b.pcpCopay); if (c) return c;
    return descNullLast(a.dentalAnnualMax || null, b.dentalAnnualMax || null);
  });

  console.log('=== Top 5 MA_ONLY plans (5-key ranking) ===');
  for (let i = 0; i < Math.min(5, uniq.length); i++) {
    const p = uniq[i];
    const h1 = parseHospDay1(p.hospitalStayCopay);
    console.log(`#${i + 1} ${p.planId}  ${p.organizationName}  ${p.planName}  (${p.state}/${p.county})  type=${p.planType}`);
    console.log(`    1. Giveback:        $${p.partBGivebackAmount ?? 'NULL'}`);
    console.log(`    2. HospitalDay1:    ${h1 != null ? '$' + h1 : 'NULL'}    (raw: ${p.hospitalStayCopay ?? 'NULL'})`);
    console.log(`    3. Specialist:      ${p.specialistCopay != null ? '$' + p.specialistCopay : 'NULL'}`);
    console.log(`    4. PCP:             ${p.pcpCopay != null ? '$' + p.pcpCopay : 'NULL'}`);
    console.log(`    5. DentalMax:       $${p.dentalAnnualMax ?? 0}    (${p.dentalBenefits ?? '-'})`);
    console.log(`    -- premium: $${p.monthlyPremium}`);
    console.log('');
  }

  // Show the next 5 too — to see whether ranking discriminates well
  console.log('=== Plans #6-10 (for tiebreaker visibility) ===');
  for (let i = 5; i < Math.min(10, uniq.length); i++) {
    const p = uniq[i];
    const h1 = parseHospDay1(p.hospitalStayCopay);
    console.log(`#${i + 1} ${p.planId}  ${p.organizationName}  ${p.planName}`);
    console.log(`    G=$${p.partBGivebackAmount}  H=${h1 != null ? '$'+h1 : 'NULL'}  S=${p.specialistCopay != null ? '$'+p.specialistCopay : 'NULL'}  P=${p.pcpCopay != null ? '$'+p.pcpCopay : 'NULL'}  D=$${p.dentalAnnualMax ?? 0}`);
  }

  // Distribution of giveback values to spot anomalies
  const gb = uniq.map(p => p.partBGivebackAmount).filter(v => v != null);
  if (gb.length) {
    gb.sort((a,b) => b-a);
    console.log(`\nGiveback distribution in ${STATE} (top 10): ${gb.slice(0, 10).join(', ')}`);
    console.log(`Plans with giveback > 0: ${gb.filter(v => v > 0).length} / ${uniq.length}`);
  }

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
