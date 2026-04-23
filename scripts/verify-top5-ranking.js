// scripts/verify-top5-ranking.js
//
// Pulls the top 5 non-SNP 2026 plans in a given state (or ZIP), ranked by
// Dale's default 6-key lexicographic order, and shows every ranking field
// plus null counts. Tells us whether the "good plans" have complete data
// even though 793 gap plans don't.
//
// Ranking keys (default, non-SNP):
//   1. Lowest Monthly Premium
//   2. Lowest Medical Deductible
//   3. Lowest Hospital Co-pay (day-1 per-day, parsed from string)
//   4. Lowest Specialist Co-pay
//   5. Lowest MOOP (Max Out-of-Pocket)
//   6. Highest Star Rating
//
// Usage (from repo root, PowerShell):
//   node scripts/verify-top5-ranking.js                # defaults: STATE=TX
//   $env:STATE='FL'; node scripts/verify-top5-ranking.js
//   $env:ZIP='77001'; node scripts/verify-top5-ranking.js
//   $env:STATE='OH'; node scripts/verify-top5-ranking.js

const { makePrisma } = require('./prisma-client');

const STATE = process.env.STATE || 'TX';
const ZIP = process.env.ZIP || null;
const YEAR = parseInt(process.env.YEAR || '2026', 10);

function parseHospDay1(s) {
  if (!s) return null;
  const m = String(s).match(/\$(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

async function main() {
  const prisma = makePrisma();
  const where = { planYear: YEAR };
  if (ZIP) where.zipCode = ZIP; else where.state = STATE;
  // Dale asked specifically about "top five MAPD plans" — filter to MAPD only
  // (planCategory is a Prisma enum; passing the bare string still resolves to the
  //  enum member by name, and this is cleaner than NOT-IN against enum values)
  where.planCategory = 'MAPD';

  const plans = await prisma.plan.findMany({
    where,
    select: {
      planId: true, planName: true, organizationName: true,
      state: true, county: true, zipCode: true,
      planType: true, planCategory: true,
      // 6 ranking keys:
      monthlyPremium: true,
      medicalDeductible: true,
      hospitalStayCopay: true,
      specialistCopay: true,
      maxOutOfPocket: true,
      starRating: true,
      // Supporting fields (for visibility):
      pcpCopay: true, emergencyRoomCopay: true, ambulanceCopay: true,
      catScanCopay: true, outpatientHospitalCopay: true, skilledNursingCopay: true,
      partBGivebackAmount: true,
    },
    take: 5000,
  });

  console.log(`Scope: planYear=${YEAR}, ${ZIP ? `ZIP=${ZIP}` : `STATE=${STATE}`}`);
  console.log(`Non-SNP plan rows (pre-dedupe, per-county): ${plans.length}`);

  // Dedupe by planId — take the row with the most complete data
  const byPlan = new Map();
  for (const p of plans) {
    const prev = byPlan.get(p.planId);
    const score = (p.monthlyPremium != null) + (p.medicalDeductible != null) +
                  (p.hospitalStayCopay != null) + (p.specialistCopay != null) +
                  (p.maxOutOfPocket != null) + (p.starRating != null);
    if (!prev || score > prev._score) {
      p._score = score;
      byPlan.set(p.planId, p);
    }
  }
  const uniq = [...byPlan.values()];
  console.log(`Unique plans after dedupe: ${uniq.length}`);
  console.log('');

  // Rank by 6 keys (null = worst)
  uniq.sort((a, b) => {
    const A = [
      a.monthlyPremium ?? Infinity,
      a.medicalDeductible ?? Infinity,
      parseHospDay1(a.hospitalStayCopay) ?? Infinity,
      a.specialistCopay ?? Infinity,
      a.maxOutOfPocket ?? Infinity,
      -(a.starRating ?? 0),
    ];
    const B = [
      b.monthlyPremium ?? Infinity,
      b.medicalDeductible ?? Infinity,
      parseHospDay1(b.hospitalStayCopay) ?? Infinity,
      b.specialistCopay ?? Infinity,
      b.maxOutOfPocket ?? Infinity,
      -(b.starRating ?? 0),
    ];
    for (let i = 0; i < A.length; i++) {
      if (A[i] !== B[i]) return A[i] - B[i];
    }
    return 0;
  });

  console.log('=== TOP 5 by default 6-key ranking ===');
  for (let i = 0; i < Math.min(5, uniq.length); i++) {
    const p = uniq[i];
    const hospDay1 = parseHospDay1(p.hospitalStayCopay);
    console.log(`#${i + 1} ${p.planId}  [${p.planCategory}/${p.planType}]  ${p.organizationName}`);
    console.log(`    ${p.planName}  (${p.state}/${p.county})`);
    console.log(`    1. MonthlyPremium:      ${p.monthlyPremium === null || p.monthlyPremium === undefined ? 'NULL' : '$' + p.monthlyPremium}`);
    console.log(`    2. MedicalDeductible:   ${p.medicalDeductible === null || p.medicalDeductible === undefined ? 'NULL' : '$' + p.medicalDeductible}`);
    console.log(`    3. HospitalStayCopay:   ${p.hospitalStayCopay ?? 'NULL'}  (day1=${hospDay1 ?? 'NULL'})`);
    console.log(`    4. SpecialistCopay:     ${p.specialistCopay === null || p.specialistCopay === undefined ? 'NULL' : '$' + p.specialistCopay}`);
    console.log(`    5. MaxOutOfPocket:      ${p.maxOutOfPocket === null || p.maxOutOfPocket === undefined ? 'NULL' : '$' + p.maxOutOfPocket}`);
    console.log(`    6. StarRating:          ${p.starRating ?? 'NULL'}`);
    console.log(`    -- support -- PCP: ${p.pcpCopay ?? 'NULL'}  ER: ${p.emergencyRoomCopay ?? 'NULL'}  Amb: ${p.ambulanceCopay ?? 'NULL'}  CT: ${p.catScanCopay ?? 'NULL'}  Giveback: ${p.partBGivebackAmount ?? 0}`);
    console.log('');
  }

  // Null audit on the top 5
  const keys = ['monthlyPremium', 'medicalDeductible', 'hospitalStayCopay', 'specialistCopay', 'maxOutOfPocket', 'starRating'];
  const nullCounts = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const p of uniq.slice(0, 5)) {
    for (const k of keys) {
      if (p[k] === null || p[k] === undefined) nullCounts[k]++;
    }
  }
  console.log('=== NULL counts in top 5 (0 = complete, 5 = entirely missing) ===');
  for (const [k, v] of Object.entries(nullCounts)) {
    console.log(`    ${k.padEnd(24)} ${v}/5`);
  }

  // Also show null coverage across the entire candidate pool
  const allNulls = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const p of uniq) {
    for (const k of keys) {
      if (p[k] === null || p[k] === undefined) allNulls[k]++;
    }
  }
  console.log('');
  console.log('=== NULL counts across ALL non-SNP plans in scope ===');
  for (const [k, v] of Object.entries(allNulls)) {
    const pct = uniq.length > 0 ? ((v / uniq.length) * 100).toFixed(1) : '0.0';
    console.log(`    ${k.padEnd(24)} ${v}/${uniq.length} (${pct}%)`);
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
