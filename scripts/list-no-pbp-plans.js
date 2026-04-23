// scripts/list-no-pbp-plans.js
//
// Emits the bucket of plans with no PBP match (all service-level copays NULL).
// Input list for the SOB/EOC scraper work.
//
// Signature: all 5 service-level copay fields that come from PBP are NULL:
//   emergencyRoomCopay, outpatientHospitalCopay, hospitalStayCopay,
//   skilledNursingCopay, catScanCopay
//
// Outputs:
//   scripts/data/no-pbp-plans.csv           — planId,planYear,organizationName,state,planType
//   scripts/data/no-pbp-plans-by-carrier.csv — organizationName,count  (sorted desc)
//
// Usage (from repo root):
//   node scripts/list-no-pbp-plans.js

const fs = require('fs');
const path = require('path');
const { makePrisma } = require('./prisma-client');

const OUT_DIR = path.join(__dirname, 'data');
const OUT_TUPLES = path.join(OUT_DIR, 'no-pbp-plans.csv');
const OUT_CARRIERS = path.join(OUT_DIR, 'no-pbp-plans-by-carrier.csv');

async function main() {
  const prisma = makePrisma();
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const rows = await prisma.plan.findMany({
    where: {
      emergencyRoomCopay: null,
      outpatientHospitalCopay: null,
      hospitalStayCopay: null,
      skilledNursingCopay: null,
      catScanCopay: null,
    },
    select: {
      planId: true,
      planYear: true,
      organizationName: true,
      state: true,
      planType: true,
    },
    orderBy: [
      { organizationName: 'asc' },
      { planId: 'asc' },
    ],
  });

  // Dedupe by (planId, planYear, organizationName) — a plan can appear in many states/counties.
  const seen = new Set();
  const unique = [];
  for (const r of rows) {
    const key = `${r.planId}|${r.planYear}|${r.organizationName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
  }

  // Tuple CSV (unique plans, not per-geo rows)
  const header = 'planId,planYear,organizationName,state,planType\n';
  const body = unique
    .map(
      (r) =>
        `${r.planId},${r.planYear},"${(r.organizationName || '').replace(/"/g, '""')}",${r.state || ''},${r.planType || ''}`
    )
    .join('\n');
  fs.writeFileSync(OUT_TUPLES, header + body + '\n');

  // Carrier histogram on unique plans
  const counts = new Map();
  for (const r of unique) {
    const k = r.organizationName || '(unknown)';
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const hist = 'organizationName,count\n' + sorted.map(([c, n]) => `"${c.replace(/"/g, '""')}",${n}`).join('\n');
  fs.writeFileSync(OUT_CARRIERS, hist + '\n');

  console.log(`Raw matching rows (per geo):   ${rows.length}`);
  console.log(`Unique plans (planId+year+org): ${unique.length}`);
  console.log(`Wrote ${OUT_TUPLES}`);
  console.log(`Wrote ${OUT_CARRIERS}`);
  console.log('');
  console.log('Top 15 carriers by no-PBP unique plan count:');
  for (const [c, n] of sorted.slice(0, 15)) {
    console.log(`  ${n.toString().padStart(5)}  ${c}`);
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
