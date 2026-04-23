// scripts/list-no-pbp-plans.js
//
// Emits the bucket of no-PBP plans for the CURRENT plan year only.
// Input list for the SOB scraper.
//
// Signature: all 5 service-level copay fields from PBP are NULL:
//   emergencyRoomCopay, outpatientHospitalCopay, hospitalStayCopay,
//   skilledNursingCopay, catScanCopay
//
// Defaults to planYear=2026. Override with env var: TARGET_PLAN_YEAR=2025
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

const TARGET_YEAR = parseInt(process.env.TARGET_PLAN_YEAR || '2026', 10);
const OUT_DIR = path.join(__dirname, 'data');
const OUT_TUPLES = path.join(OUT_DIR, 'no-pbp-plans.csv');
const OUT_CARRIERS = path.join(OUT_DIR, 'no-pbp-plans-by-carrier.csv');

async function main() {
  const prisma = makePrisma();
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  // Sanity: what plan years exist in the DB, and how many no-PBP plans per year?
  console.log('=== Plan year distribution (no-PBP signature L1) ===');
  const yearDist = await prisma.plan.groupBy({
    by: ['planYear'],
    where: {
      emergencyRoomCopay: null,
      outpatientHospitalCopay: null,
      hospitalStayCopay: null,
      skilledNursingCopay: null,
      catScanCopay: null,
    },
    _count: { _all: true },
    orderBy: { planYear: 'asc' },
  });
  for (const r of yearDist) {
    console.log(`  planYear=${r.planYear}: ${r._count._all} rows (before dedupe)`);
  }
  console.log('');

  console.log(`=== Targeting planYear=${TARGET_YEAR} ===`);
  const rows = await prisma.plan.findMany({
    where: {
      planYear: TARGET_YEAR,
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
      planCategory: true,
    },
    orderBy: [
      { organizationName: 'asc' },
      { planId: 'asc' },
    ],
  });

  // Dedupe by (planId, planYear, organizationName) — one plan appears in many counties.
  const seen = new Set();
  const unique = [];
  for (const r of rows) {
    const key = `${r.planId}|${r.planYear}|${r.organizationName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
  }

  const header = 'planId,planYear,organizationName,state,planType,planCategory\n';
  const body = unique
    .map(
      (r) =>
        `${r.planId},${r.planYear},"${(r.organizationName || '').replace(/"/g, '""')}",${r.state || ''},${r.planType || ''},${r.planCategory || ''}`
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

  console.log(`Raw matching rows (per geo): ${rows.length}`);
  console.log(`Unique plans:                ${unique.length}`);
  console.log('');
  console.log(`Wrote ${OUT_TUPLES}`);
  console.log(`Wrote ${OUT_CARRIERS}`);
  console.log('');
  console.log(`Top 15 carriers (planYear=${TARGET_YEAR}, no-PBP):`);
  for (const [c, n] of sorted.slice(0, 15)) {
    console.log(`  ${n.toString().padStart(5)}  ${c}`);
  }

  // Also break down by planCategory — helps us understand if this is MAPD, D-SNP, etc.
  const catCounts = new Map();
  for (const r of unique) {
    const k = r.planCategory || '(none)';
    catCounts.set(k, (catCounts.get(k) || 0) + 1);
  }
  console.log('');
  console.log('By planCategory:');
  for (const [c, n] of [...catCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n.toString().padStart(5)}  ${c}`);
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
