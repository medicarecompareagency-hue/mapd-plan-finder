// scripts/verify-dsnp-fulldual-enrichment.js
//
// Smoke test for the 2026-05-05 Part 3 DSNP cost-share enrichment.
//
// Confirms two things:
//   1. The 9 enriched fields no longer show 67-83% NULL on FULL_DUAL DSNPs.
//      Part 3 claimed 12-39% residual (= the 33% PARTIAL_DUAL share, which
//      was intentionally left untouched). This script verifies that.
//   2. The D-SNP 6-key ranking (per SNP-RANKING-SPEC-2026-04-27) actually
//      uses hospitalStayCopay as a tiebreaker now, instead of falling
//      through to premium because key #5 was NULL.
//
// Usage (from repo root, PowerShell):
//   node scripts/verify-dsnp-fulldual-enrichment.js
//   $env:STATE='FL'; node scripts/verify-dsnp-fulldual-enrichment.js
//   $env:STATE='TX'; node scripts/verify-dsnp-fulldual-enrichment.js
//
// Default STATE=FL because FL has the most DSNP rows in your licensed-states scope.

const { makePrisma } = require('./prisma-client');

const STATE = process.env.STATE || 'FL';
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

const ENRICHED_NUMERIC = [
  'pcpCopay', 'specialistCopay', 'emergencyRoomCopay',
  'ambulanceCopay', 'outpatientHospitalCopay', 'mriCopay', 'catScanCopay',
];
const ENRICHED_STRINGS = ['hospitalStayCopay', 'skilledNursingCopay'];

async function main() {
  const prisma = makePrisma();

  // ----- 1. Null-rate audit on FULL_DUAL DSNP plan-rows -----
  const fullDual = await prisma.plan.findMany({
    where: { planYear: YEAR, planCategory: 'DSNP', dsnpTargetGroup: 'FULL_DUAL' },
    select: {
      planId: true, planName: true, organizationName: true, state: true, county: true,
      pcpCopay: true, specialistCopay: true, emergencyRoomCopay: true,
      ambulanceCopay: true, outpatientHospitalCopay: true, mriCopay: true, catScanCopay: true,
      hospitalStayCopay: true, skilledNursingCopay: true,
    },
  });

  const partialDual = await prisma.plan.count({
    where: { planYear: YEAR, planCategory: 'DSNP', dsnpTargetGroup: 'PARTIAL_DUAL' },
  });

  console.log(`=== FULL_DUAL DSNP null-rate audit (planYear=${YEAR}) ===`);
  console.log(`FULL_DUAL plan-rows scanned: ${fullDual.length}`);
  console.log(`(PARTIAL_DUAL plan-rows for context: ${partialDual} — intentionally untouched)`);
  console.log('');
  console.log('Field                          NULL    %NULL   Expected');
  console.log('-----------------------------  ------  ------  ----------------');

  const expectedTarget = '< 5% (post-fix)';
  for (const f of [...ENRICHED_NUMERIC, ...ENRICHED_STRINGS]) {
    const nullCt = fullDual.filter((p) => p[f] == null).length;
    const pct = fullDual.length ? (100 * nullCt / fullDual.length).toFixed(1) : '0.0';
    const flag = parseFloat(pct) > 10 ? '   FAIL — over 10%' : '   ok';
    console.log(`  ${f.padEnd(28)} ${String(nullCt).padStart(6)}  ${pct.padStart(5)}%  ${expectedTarget}${flag}`);
  }
  console.log('');

  // ----- 2. D-SNP top-5 ranking smoke test in chosen state -----
  console.log(`=== D-SNP top-5 ranking sanity check (STATE=${STATE}, planYear=${YEAR}) ===`);

  // Pull FL FULL_DUAL DSNPs (simulates a QMB+ search via the LIVE filter)
  const stateRows = await prisma.plan.findMany({
    where: {
      planYear: YEAR, planCategory: 'DSNP', dsnpTargetGroup: 'FULL_DUAL', state: STATE,
    },
    select: {
      planId: true, planName: true, organizationName: true, state: true, county: true,
      monthlyPremium: true, foodCardAllowance: true, otcAllowance: true,
      dentalAnnualMax: true, dentalBenefits: true,
      visionAnnualMax: true, visionBenefits: true,
      hospitalStayCopay: true, specialistCopay: true, pcpCopay: true,
    },
    take: 50000,
  });
  console.log(`FULL_DUAL DSNP plan-rows in ${STATE}: ${stateRows.length}`);

  // Dedupe by planId — pick row with most complete data
  const byPlan = new Map();
  for (const p of stateRows) {
    const score =
      (p.monthlyPremium != null) + (p.foodCardAllowance != null) + (p.otcAllowance != null) +
      (p.dentalAnnualMax != null) + (p.visionAnnualMax != null) + (p.hospitalStayCopay != null);
    const prev = byPlan.get(p.planId);
    if (!prev || score > prev._score) { p._score = score; byPlan.set(p.planId, p); }
  }
  const uniq = [...byPlan.values()];
  console.log(`Unique plans after dedupe: ${uniq.length}`);
  console.log('');

  // D-SNP ranking per spec:
  //   1. Highest food card allowance
  //   2. Highest OTC allowance
  //   3. Best dental benefit (dentalAnnualMax DESC, NULL last)
  //   4. Best vision benefit (visionAnnualMax DESC, NULL last)
  //   5. Lowest hospital co-pay (day-1)
  //   6. Lowest premium
  function descNullLast(a, b) {
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    return b - a;
  }
  function ascNullLast(a, b) {
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    return a - b;
  }

  uniq.sort((a, b) => {
    let c;
    c = descNullLast(a.foodCardAllowance, b.foodCardAllowance); if (c) return c;
    c = descNullLast(a.otcAllowance, b.otcAllowance);           if (c) return c;
    c = descNullLast(a.dentalAnnualMax, b.dentalAnnualMax);     if (c) return c;
    c = descNullLast(a.visionAnnualMax, b.visionAnnualMax);     if (c) return c;
    c = ascNullLast(parseHospDay1(a.hospitalStayCopay), parseHospDay1(b.hospitalStayCopay)); if (c) return c;
    c = ascNullLast(a.monthlyPremium, b.monthlyPremium);        if (c) return c;
    return 0;
  });

  console.log('=== Top 5 D-SNP plans (FULL_DUAL, ranked by 6 SNP keys) ===');
  for (let i = 0; i < Math.min(5, uniq.length); i++) {
    const p = uniq[i];
    const h1 = parseHospDay1(p.hospitalStayCopay);
    console.log(`#${i + 1} ${p.planId}  ${p.organizationName}`);
    console.log(`    ${p.planName}  (${p.state}/${p.county})`);
    console.log(`    1. FoodCard:        ${p.foodCardAllowance ?? 'NULL'}`);
    console.log(`    2. OTC:             ${p.otcAllowance ?? 'NULL'}`);
    console.log(`    3. DentalMax:       ${p.dentalAnnualMax ?? 'NULL'}    (${p.dentalBenefits ?? '-'})`);
    console.log(`    4. VisionMax:       ${p.visionAnnualMax ?? 'NULL'}    (${p.visionBenefits ?? '-'})`);
    console.log(`    5. HospitalDay1:    ${h1 ?? 'NULL'}    (raw: ${p.hospitalStayCopay ?? 'NULL'})`);
    console.log(`    6. Premium:         ${p.monthlyPremium != null ? '$' + p.monthlyPremium : 'NULL'}`);
    console.log('');
  }

  // Tiebreaker reality check: how many of the top 20 SHARE keys 1-4 (forcing
  // the tiebreaker down to hospital copay or premium)?
  const top20 = uniq.slice(0, 20);
  let tiedThroughKey4 = 0;
  for (let i = 1; i < top20.length; i++) {
    const a = top20[i - 1], b = top20[i];
    if (
      (a.foodCardAllowance ?? null) === (b.foodCardAllowance ?? null) &&
      (a.otcAllowance ?? null) === (b.otcAllowance ?? null) &&
      (a.dentalAnnualMax ?? null) === (b.dentalAnnualMax ?? null) &&
      (a.visionAnnualMax ?? null) === (b.visionAnnualMax ?? null)
    ) tiedThroughKey4++;
  }
  console.log(`Adjacent-pair ties through keys 1-4 in top 20: ${tiedThroughKey4}`);
  console.log(`(Higher = key #5 hospital co-pay is doing real tiebreaker work, which is what Part 3 unlocked.)`);

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
