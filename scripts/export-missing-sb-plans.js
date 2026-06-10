// scripts/export-missing-sb-plans.js
// Exports all 2026 plans missing SB PDFs to a CSV file.
// Run: node scripts/export-missing-sb-plans.js

const fs  = require('fs');
const { makePrisma } = require('./prisma-client');

const OUT_PATH = 'C:\\Users\\dbuir\\OneDrive\\Documents\\Claude\\Projects\\MAPD Plan Finder\\missing-sb-plans.csv';

const LICENSED_STATES = [
  'AL','AR','FL','GA','IL','IN','KS','KY','LA',
  'MO','MS','OH','OK','SC','TN','TX','VA','WV',
];

(async () => {
  const prisma = makePrisma();

  const rows = await prisma.plan.findMany({
    where: {
      planYear: 2026,
      state: { in: LICENSED_STATES },
      sbPdfUrl: null,
    },
    select: {
      planId: true,
      planName: true,
      organizationName: true,
      state: true,
      planCategory: true,
      planType: true,
    },
    distinct: ['planId'],
    orderBy: [
      { organizationName: 'asc' },
      { state: 'asc' },
      { planId: 'asc' },
    ],
  });

  console.log(`Plans missing SB PDF: ${rows.length}`);

  // CSV header
  const lines = [
    'Contract Number,Plan Name,Carrier,State,Plan Category,Plan Type'
  ];

  for (const r of rows) {
    // Escape any commas or quotes in name fields
    const escape = (s) => `"${(s || '').replace(/"/g, '""')}"`;
    lines.push([
      r.planId,
      escape(r.planName),
      escape(r.organizationName),
      r.state,
      r.planCategory || '',
      r.planType || '',
    ].join(','));
  }

  fs.writeFileSync(OUT_PATH, lines.join('\r\n'), 'utf8');
  console.log(`Saved to: ${OUT_PATH}`);

  // Print a quick breakdown by carrier
  const byCarrier = {};
  for (const r of rows) {
    byCarrier[r.organizationName] = (byCarrier[r.organizationName] || 0) + 1;
  }
  console.log('\nBreakdown by carrier:');
  for (const [carrier, count] of Object.entries(byCarrier).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${carrier}: ${count}`);
  }

  await prisma.$disconnect();
})();
