// scripts/cleanup-egwp-800-series.js
//
// Deletes Plan rows whose plan number is 800-999 — CMS reserves that range
// for Employer/Union-Only Group Waiver Plans (EGWP). These are not
// individually enrollable, and their CMS filings are generic shells
// ($0 premium, 20% coinsurance everywhere, no marketing name), so they
// pollute search results with wrong-looking copays.
//
// Why the original cleanup-egwp-plans.js missed them (2026-06-10, Dale's
// H5216-805 report): that script keyed on the landscape "*" planType marker,
// but these rows came in through the PBP/Section-A backfill with plain
// "HMO"/"PPO" planTypes. PlanArea's eghp_flag is NOT set for them either
// (verified H5216-805 = flag 0), so the only reliable signal is the
// 800-series plan number itself. As of 2026-06-10 this matched 248 plans /
// 97,627 rows — two-thirds of the table.
//
// The PBP/landscape importers are gated on plan number < 800 as of
// 2026-06-10, so re-imports won't bring these back.
//
// Usage (from repo root):
//   node scripts/cleanup-egwp-800-series.js          # dry run
//   node scripts/cleanup-egwp-800-series.js --apply  # delete
//
// Safe to re-run: idempotent.

const { makePrisma } = require("./prisma-client");
const prisma = makePrisma();
const APPLY = process.argv.includes("--apply");

async function main() {
  const counts = await prisma.$queryRaw`
    SELECT "organizationName" AS org, COUNT(DISTINCT "planId")::int AS plans, COUNT(*)::int AS rows
    FROM "Plan"
    WHERE CAST(SPLIT_PART("planId", '-', 2) AS int) BETWEEN 800 AND 999
    GROUP BY 1 ORDER BY 3 DESC
  `;
  let totalRows = 0;
  console.log("EGWP (plan number 800-999) rows in DB:");
  for (const r of counts) {
    console.log(`  ${r.org}: ${r.plans} plans / ${r.rows.toLocaleString()} rows`);
    totalRows += r.rows;
  }
  console.log(`TOTAL: ${totalRows.toLocaleString()} rows`);

  if (!APPLY) {
    console.log("\nDRY RUN. Re-run with --apply to delete.");
    return;
  }

  const deleted = await prisma.$executeRaw`
    DELETE FROM "Plan"
    WHERE CAST(SPLIT_PART("planId", '-', 2) AS int) BETWEEN 800 AND 999
  `;
  console.log(`\nDeleted ${Number(deleted).toLocaleString()} EGWP rows.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
