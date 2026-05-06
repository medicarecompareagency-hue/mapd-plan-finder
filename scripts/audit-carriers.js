// scripts/audit-carriers.js
//
// Lists every distinct organizationName in the 2026 DB and flags which
// are/aren't in LICENSED_CARRIERS. Helps spot:
//   1. Unlicensed carriers (like VIVA) that backfill inserted
//   2. Naming mismatches (e.g. "Cigna" vs "Cigna Healthcare")
//
// No DB writes; pure inventory.

const { makePrisma } = require('./prisma-client');

// Inline copy of lib/licensed-carriers.ts (kept in sync manually).
// Last verified 2026-05-06.
const LICENSED_CARRIERS = [
  'Cigna',
  'UnitedHealthcare',
  'Wellcare',
  'Aetna Medicare',
  'Humana',
  'Devoted Health',
];
const LICENSED_SET = new Set(LICENSED_CARRIERS);

(async () => {
  const prisma = makePrisma();

  const rows = await prisma.plan.groupBy({
    by: ['organizationName', 'planCategory'],
    where: { planYear: 2026 },
    _count: { _all: true },
  });

  const byOrg = new Map();
  for (const r of rows) {
    const o = r.organizationName || '<empty>';
    if (!byOrg.has(o)) byOrg.set(o, { total: 0, byCat: {} });
    const e = byOrg.get(o);
    e.total += r._count._all;
    e.byCat[r.planCategory || '<null>'] = r._count._all;
  }

  const sorted = [...byOrg.entries()].sort((a, b) => b[1].total - a[1].total);

  console.log(`=== 2026 organizationNames vs LICENSED_CARRIERS ===\n`);
  console.log(`LICENSED_CARRIERS (${LICENSED_CARRIERS.length}):`);
  for (const c of LICENSED_CARRIERS) console.log(`  - ${c}`);
  console.log('');

  console.log('--- LICENSED carriers in DB ---');
  let licensedRows = 0, licensedOrgs = 0;
  for (const [o, e] of sorted) {
    if (!LICENSED_SET.has(o)) continue;
    licensedOrgs++; licensedRows += e.total;
    console.log(`  ${String(e.total).padStart(7)}  ${o}`);
    for (const [c, n] of Object.entries(e.byCat).sort((a, b) => b[1] - a[1])) {
      console.log(`            ${String(n).padStart(7)}  ${c}`);
    }
  }
  console.log(`  Total licensed: ${licensedOrgs} orgs, ${licensedRows.toLocaleString()} rows`);

  console.log('\n--- UNLICENSED carriers in DB (should not be there) ---');
  let unlicensedRows = 0, unlicensedOrgs = 0;
  for (const [o, e] of sorted) {
    if (LICENSED_SET.has(o)) continue;
    unlicensedOrgs++; unlicensedRows += e.total;
    console.log(`  ${String(e.total).padStart(7)}  ${o}`);
    for (const [c, n] of Object.entries(e.byCat).sort((a, b) => b[1] - a[1])) {
      console.log(`            ${String(n).padStart(7)}  ${c}`);
    }
  }
  console.log(`  Total unlicensed: ${unlicensedOrgs} orgs, ${unlicensedRows.toLocaleString()} rows`);

  // Specifically look for naming-mismatch suspects (substring of a licensed carrier)
  console.log('\n--- Possible naming mismatches (substring matches) ---');
  for (const [o] of sorted) {
    if (LICENSED_SET.has(o)) continue;
    for (const lic of LICENSED_CARRIERS) {
      if (o.toLowerCase().includes(lic.toLowerCase()) || lic.toLowerCase().includes(o.toLowerCase())) {
        console.log(`  "${o}" looks related to LICENSED "${lic}"`);
      }
    }
  }

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
