// scripts/diagnose-no-pbp-signature.js
//
// Probes multiple "no-PBP" signatures and reports the unique plan count
// for each, plus the top-10 carriers at each level. Goal: figure out
// which signature best matches the ~994 number from the 2026-04-22 handoff,
// and rule out false positives in our current 2,484 bucket.
//
// Also dumps every field for ONE sample plan per top carrier so we can
// eyeball whether "no-PBP" plans are truly empty or just partially filled.

const { makePrisma } = require('./prisma-client');

// Ordered broad -> strict. Each level ADDS another NULL constraint.
const LEVELS = [
  {
    name: 'L1: 5 service-level copays NULL',
    where: {
      emergencyRoomCopay: null,
      outpatientHospitalCopay: null,
      hospitalStayCopay: null,
      skilledNursingCopay: null,
      catScanCopay: null,
    },
  },
  {
    name: 'L2: L1 + drugTier1Copay NULL',
    where: {
      emergencyRoomCopay: null,
      outpatientHospitalCopay: null,
      hospitalStayCopay: null,
      skilledNursingCopay: null,
      catScanCopay: null,
      drugTier1Copay: null,
    },
  },
  {
    name: 'L3: L2 + drugDeductible NULL',
    where: {
      emergencyRoomCopay: null,
      outpatientHospitalCopay: null,
      hospitalStayCopay: null,
      skilledNursingCopay: null,
      catScanCopay: null,
      drugTier1Copay: null,
      drugDeductible: null,
    },
  },
  {
    name: 'L4: L3 + medicalDeductible NULL',
    where: {
      emergencyRoomCopay: null,
      outpatientHospitalCopay: null,
      hospitalStayCopay: null,
      skilledNursingCopay: null,
      catScanCopay: null,
      drugTier1Copay: null,
      drugDeductible: null,
      medicalDeductible: null,
    },
  },
  {
    name: 'L5: L4 + maxOutOfPocket NULL',
    where: {
      emergencyRoomCopay: null,
      outpatientHospitalCopay: null,
      hospitalStayCopay: null,
      skilledNursingCopay: null,
      catScanCopay: null,
      drugTier1Copay: null,
      drugDeductible: null,
      medicalDeductible: null,
      maxOutOfPocket: null,
    },
  },
];

function dedupe(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const k = `${r.planId}|${r.planYear}|${r.organizationName}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

function topCarriers(unique, n = 10) {
  const counts = new Map();
  for (const r of unique) {
    const k = r.organizationName || '(unknown)';
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

async function main() {
  const prisma = makePrisma();

  console.log('=== Signature probe ===\n');
  const levelResults = [];
  for (const level of LEVELS) {
    const rows = await prisma.plan.findMany({
      where: level.where,
      select: { planId: true, planYear: true, organizationName: true },
    });
    const unique = dedupe(rows);
    const top = topCarriers(unique, 5);
    levelResults.push({ name: level.name, count: unique.length, top });
    console.log(`${level.name}`);
    console.log(`  unique plans: ${unique.length}`);
    console.log(`  top 5 carriers:`);
    for (const [c, n] of top) console.log(`    ${n.toString().padStart(4)}  ${c}`);
    console.log('');
  }

  console.log('=== Sample plan dumps ===');
  console.log('One representative plan per top carrier at L1 (broadest signature).\n');

  // Pick one plan per top-5 carrier at L1 and dump ALL fields to see what's populated.
  const sampleCarriers = levelResults[0].top.map(([c]) => c);
  for (const carrier of sampleCarriers) {
    const sample = await prisma.plan.findFirst({
      where: {
        organizationName: carrier,
        ...LEVELS[0].where,
      },
      orderBy: { planId: 'asc' },
    });
    if (!sample) {
      console.log(`${carrier}: no match`);
      continue;
    }
    console.log(`--- ${carrier} :: ${sample.planId} year=${sample.planYear} state=${sample.state} ---`);
    const fields = [
      'planName', 'planType', 'planCategory', 'cmsContractType', 'monthlyPremium',
      'medicalDeductible', 'maxOutOfPocket',
      'emergencyRoomCopay', 'outpatientHospitalCopay', 'hospitalStayCopay',
      'skilledNursingCopay', 'catScanCopay',
      'drugDeductible', 'drugTier1Copay', 'drugTier2Copay', 'drugTier3Copay',
      'drugTier4Copay', 'drugTier5Copay', 'drugTier6Copay', 'drugTierCoinsuranceMask',
      'otcAllowance', 'foodCardAllowance',
      'dentalBenefits', 'hearingBenefits', 'visionBenefits', 'transportationBenefit',
      'starRating',
    ];
    for (const f of fields) {
      const v = sample[f];
      const mark = (v === null || v === undefined) ? 'NULL' : JSON.stringify(v);
      console.log(`  ${f.padEnd(26)} ${mark}`);
    }
    console.log('');
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
