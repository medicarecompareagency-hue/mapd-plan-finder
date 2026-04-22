// scripts/list-plan-types.js
// Diagnostic: dump all distinct planType values in the DB with counts.
// Helps identify duplicates, trailing whitespace, asterisk suffixes, etc.
//
// Usage (from repo root): node scripts/list-plan-types.js

const { makePrisma } = require("./prisma-client");
const prisma = makePrisma();

async function main() {
  const rows = await prisma.$queryRaw`
    SELECT "planType", COUNT(*)::int AS n
    FROM "Plan"
    GROUP BY "planType"
    ORDER BY "planType"
  `;

  console.log(`Found ${rows.length} distinct planType values:\n`);
  for (const row of rows) {
    // Show pipe delimiters so trailing/leading whitespace is visible
    console.log(`  |${row.planType}|  (${Number(row.n).toLocaleString()} plans)`);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
