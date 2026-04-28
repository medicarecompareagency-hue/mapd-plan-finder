// scripts/smoke-test-rankings.js
//
// Mirrors the GET /api/plans ranking logic (app/api/plans/route.ts) and
// runs it directly against the DB so we can verify rankings without
// going through the auth-gated live site. Used for post-Phase-1.6
// regression smoke tests on MAPD, C-SNP, and D-SNP.
//
// Usage (PowerShell):
//   $env:STATE='FL'; $env:CATEGORY='MAPD';  node scripts/smoke-test-rankings.js
//   $env:STATE='FL'; $env:CATEGORY='CSNP';  node scripts/smoke-test-rankings.js
//   $env:STATE='FL'; $env:CATEGORY='DSNP';  node scripts/smoke-test-rankings.js
//
// Defaults: STATE=FL, CATEGORY=MAPD, YEAR=2026.
//
// Mirrors these API behaviors exactly:
//   - LICENSED_CARRIERS gate
//   - planCategory != 'ISNP' exclusion
//   - candidate pool size MAX_RESULTS * 50 = 25,000
//   - default 6-key chain for MAPD/non-SNP
//   - C-SNP chain (premium > food > OTC > dentalMax > dentalStr > hospital > visionMax > visionStr)
//   - D-SNP chain (food > OTC > dentalMax > dentalStr > visionMax > visionStr > hospital > premium)
//   - dedupe top-5 by organizationName

const { makePrisma } = require('./prisma-client');

const LICENSED_CARRIERS = [
  'Cigna',
  'Cigna Healthcare',
  'HealthSpring',
  'UnitedHealthcare',
  'Wellcare',
  'Aetna Medicare',
  'Humana',
  'Devoted Health',
];

const STATE = process.env.STATE || 'FL';
const CATEGORY = (process.env.CATEGORY || 'MAPD').toUpperCase();
const YEAR = parseInt(process.env.YEAR || '2026', 10);
const MAX_RESULTS = 500;

function cmp(a, b, ascending) {
  const aNull = a == null;
  const bNull = b == null;
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  return ascending ? a - b : b - a;
}

function parseHospitalCopayDay1(val) {
  if (val == null) return null;
  const s = String(val).trim();
  if (!s || /^none$/i.test(s)) return null;
  let m = s.match(/\$?\s*(\d+(?:\.\d+)?)\s*(?:\/|per\s*)day/i);
  if (m) return parseFloat(m[1]);
  m = s.match(/\$?\s*(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

function hasBenefitRank(val) {
  if (val == null) return 1;
  const s = String(val).trim();
  if (!s) return 1;
  if (/^(none|no\b|not\s+covered)/i.test(s)) return 1;
  return 0;
}

function numericBenefit(val) {
  if (val == null) return 0;
  const n = typeof val === 'number' ? val : parseFloat(String(val));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

function cmpBenefitDesc(a, b) {
  const av = numericBenefit(a);
  const bv = numericBenefit(b);
  if (av === bv) return 0;
  return bv - av;
}

function dedupeByCarrier(sorted, n) {
  const seen = new Set();
  const out = [];
  for (const plan of sorted) {
    const carrier = String(plan.organizationName ?? '').toLowerCase().trim();
    if (!carrier || seen.has(carrier)) continue;
    seen.add(carrier);
    out.push(plan);
    if (out.length >= n) break;
  }
  return out;
}

function defaultCmp(a, b) {
  let c = cmp(a.monthlyPremium, b.monthlyPremium, true);
  if (c !== 0) return c;
  c = cmp(a.medicalDeductible, b.medicalDeductible, true);
  if (c !== 0) return c;
  c = cmp(parseHospitalCopayDay1(a.hospitalStayCopay), parseHospitalCopayDay1(b.hospitalStayCopay), true);
  if (c !== 0) return c;
  c = cmp(a.specialistCopay, b.specialistCopay, true);
  if (c !== 0) return c;
  c = cmp(a.maxOutOfPocket, b.maxOutOfPocket, true);
  if (c !== 0) return c;
  return cmp(a.starRating, b.starRating, false);
}

function csnpCmp(a, b) {
  let c = cmp(a.monthlyPremium, b.monthlyPremium, true);
  if (c !== 0) return c;
  c = cmp(a.foodCardAllowance, b.foodCardAllowance, false);
  if (c !== 0) return c;
  c = cmp(a.otcAllowance, b.otcAllowance, false);
  if (c !== 0) return c;
  c = cmpBenefitDesc(a.dentalAnnualMax, b.dentalAnnualMax);
  if (c !== 0) return c;
  c = hasBenefitRank(a.dentalBenefits) - hasBenefitRank(b.dentalBenefits);
  if (c !== 0) return c;
  c = cmp(parseHospitalCopayDay1(a.hospitalStayCopay), parseHospitalCopayDay1(b.hospitalStayCopay), true);
  if (c !== 0) return c;
  c = cmpBenefitDesc(a.visionAnnualMax, b.visionAnnualMax);
  if (c !== 0) return c;
  return hasBenefitRank(a.visionBenefits) - hasBenefitRank(b.visionBenefits);
}

function dsnpCmp(a, b) {
  let c = cmp(a.foodCardAllowance, b.foodCardAllowance, false);
  if (c !== 0) return c;
  c = cmp(a.otcAllowance, b.otcAllowance, false);
  if (c !== 0) return c;
  c = cmpBenefitDesc(a.dentalAnnualMax, b.dentalAnnualMax);
  if (c !== 0) return c;
  c = hasBenefitRank(a.dentalBenefits) - hasBenefitRank(b.dentalBenefits);
  if (c !== 0) return c;
  c = cmpBenefitDesc(a.visionAnnualMax, b.visionAnnualMax);
  if (c !== 0) return c;
  c = hasBenefitRank(a.visionBenefits) - hasBenefitRank(b.visionBenefits);
  if (c !== 0) return c;
  c = cmp(parseHospitalCopayDay1(a.hospitalStayCopay), parseHospitalCopayDay1(b.hospitalStayCopay), true);
  if (c !== 0) return c;
  return cmp(a.monthlyPremium, b.monthlyPremium, true);
}

function pickComparator(category) {
  if (category === 'CSNP') return { name: 'C-SNP (premium > food > OTC > dental$ > dentalStr > hosp > vision$ > visionStr)', fn: csnpCmp };
  if (category === 'DSNP' || category === 'ISNP') return { name: 'D-SNP/I-SNP (food > OTC > dental$ > dentalStr > vision$ > visionStr > hosp > premium)', fn: dsnpCmp };
  return { name: 'Default 6-key (premium > deductible > hosp > specialist > MOOP > star)', fn: defaultCmp };
}

function fmtMoney(v) {
  if (v == null) return 'NULL';
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  if (!Number.isFinite(n)) return String(v);
  return '$' + n.toLocaleString();
}

async function main() {
  const prisma = makePrisma();
  const where = {
    planYear: YEAR,
    state: STATE,
    organizationName: { in: LICENSED_CARRIERS },
    AND: [{ planCategory: { not: 'ISNP' } }],
    planCategory: CATEGORY,
  };

  const plans = await prisma.plan.findMany({
    where,
    take: MAX_RESULTS * 50,
  });

  const { name: cmpName, fn: cmpFn } = pickComparator(CATEGORY);

  const sorted = plans.slice().sort(cmpFn);
  const top5 = dedupeByCarrier(sorted, 5);

  console.log('============================================================');
  console.log(`Smoke test  STATE=${STATE}  CATEGORY=${CATEGORY}  YEAR=${YEAR}`);
  console.log(`Comparator: ${cmpName}`);
  console.log(`Candidate rows pulled: ${plans.length}`);
  console.log(`Distinct carriers in pool: ${new Set(plans.map((p) => p.organizationName)).size}`);
  console.log('============================================================');

  if (top5.length === 0) {
    console.log('No matching plans. Smoke test cannot validate ranking.');
    await prisma.$disconnect();
    return;
  }

  const isSnp = CATEGORY === 'CSNP' || CATEGORY === 'DSNP' || CATEGORY === 'ISNP';

  for (let i = 0; i < top5.length; i++) {
    const p = top5[i];
    console.log(`#${i + 1}  ${p.planId}  ${p.organizationName}`);
    console.log(`    ${p.planName}  (${p.state}/${p.county})  [${p.planCategory}/${p.planType}]`);
    if (isSnp) {
      console.log(`    Premium: ${fmtMoney(p.monthlyPremium)}  | Food: ${fmtMoney(p.foodCardAllowance)}  | OTC: ${fmtMoney(p.otcAllowance)}`);
      console.log(`    DentalMax: ${fmtMoney(p.dentalAnnualMax)}  | VisionMax: ${fmtMoney(p.visionAnnualMax)}  | HearingMax: ${fmtMoney(p.hearingAnnualMax)}`);
      console.log(`    Hospital: ${p.hospitalStayCopay ?? 'NULL'}  (day1=${parseHospitalCopayDay1(p.hospitalStayCopay) ?? 'NULL'})`);
      console.log(`    Dental(str): ${p.dentalBenefits ?? 'NULL'}  | Vision(str): ${p.visionBenefits ?? 'NULL'}`);
    } else {
      console.log(`    1. Premium:    ${fmtMoney(p.monthlyPremium)}`);
      console.log(`    2. Deductible: ${fmtMoney(p.medicalDeductible)}`);
      console.log(`    3. Hospital:   ${p.hospitalStayCopay ?? 'NULL'}  (day1=${parseHospitalCopayDay1(p.hospitalStayCopay) ?? 'NULL'})`);
      console.log(`    4. Specialist: ${fmtMoney(p.specialistCopay)}`);
      console.log(`    5. MOOP:       ${fmtMoney(p.maxOutOfPocket)}`);
      console.log(`    6. Star:       ${p.starRating ?? 'NULL'}`);
    }
    console.log('');
  }

  // Sanity: invariant check on adjacent pairs against the comparator
  console.log('=== Invariant: adjacent pair comparator check ===');
  let monotone = true;
  for (let i = 0; i < top5.length - 1; i++) {
    const c = cmpFn(top5[i], top5[i + 1]);
    if (c > 0) {
      monotone = false;
      console.log(`  FAIL  rank ${i + 1} not <= rank ${i + 2} per comparator (cmp=${c})`);
    } else {
      console.log(`  OK    rank ${i + 1} ranked <= rank ${i + 2}  (cmp=${c})`);
    }
  }
  console.log(monotone ? '  Monotone -> ranking chain OK.' : '  REGRESSION: ranking chain not monotone.');
  console.log('=== Carriers in top 5 (must be 5 distinct) ===');
  const carriers = top5.map((p) => p.organizationName);
  console.log('  ' + carriers.join(', '));
  console.log(new Set(carriers).size === top5.length ? '  Dedupe OK.' : '  REGRESSION: duplicate carrier in top 5.');

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
