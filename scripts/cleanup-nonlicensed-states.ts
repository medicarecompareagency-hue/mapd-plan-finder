/**
 * cleanup-nonlicensed-states.ts
 *
 * One-shot cleanup for plan rows whose state is not in Dale's licensed-states
 * list. These rows were written by import runs that predated the
 * LICENSED_STATES gate (added 2026-04-28 to import-cms-data.ts and
 * backfill-missing-plans.ts). The gate prevents new unlicensed rows from
 * being added, but it doesn't remove rows that already exist.
 *
 * Safe to re-run: if no unlicensed rows exist, deletes zero.
 *
 *   npx tsx scripts/cleanup-nonlicensed-states.ts
 *   npx tsx scripts/cleanup-nonlicensed-states.ts --dry-run
 *   npx tsx scripts/cleanup-nonlicensed-states.ts --year 2026
 */

import { PrismaClient } from "@prisma/client";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { LICENSED_STATES }: { LICENSED_STATES: string[] } = require("./licensed-states");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const yearArg = args.find((a) => /^\d{4}$/.test(a));
const PLAN_YEAR = yearArg ? parseInt(yearArg, 10) : undefined;

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL || process.env.DATABASE_URL } },
});

async function main() {
  console.log(DRY_RUN ? "DRY RUN — no deletes will execute" : "LIVE — will delete from database");
  if (PLAN_YEAR) {
    console.log(`Scoped to planYear=${PLAN_YEAR}`);
  } else {
    console.log("No --year supplied; targeting all plan years");
  }
  console.log(`Licensed states (${LICENSED_STATES.length}): ${LICENSED_STATES.join(", ")}\n`);

  const where = {
    state: { notIn: LICENSED_STATES },
    ...(PLAN_YEAR ? { planYear: PLAN_YEAR } : {}),
  };

  // Count and break down by state before touching anything.
  const breakdown = await prisma.plan.groupBy({
    by: ["state", "planYear"],
    where,
    _count: { _all: true },
    orderBy: [{ planYear: "asc" }, { state: "asc" }],
  });

  if (breakdown.length === 0) {
    console.log("No unlicensed-state rows found. Nothing to do.");
    return;
  }

  const total = breakdown.reduce((sum, r) => sum + r._count._all, 0);
  console.log(`Found ${total.toLocaleString()} rows across ${breakdown.length} state/year combinations:\n`);
  for (const r of breakdown) {
    console.log(`  ${r.planYear}  ${r.state}  ${r._count._all.toLocaleString().padStart(7)} rows`);
  }
  console.log();

  if (DRY_RUN) {
    console.log(`DRY RUN: would delete ${total.toLocaleString()} rows. Re-run without --dry-run to apply.`);
    return;
  }

  // Delete in year+state slices so each deleteMany targets a bounded set and
  // progress is visible. Also avoids a single massive transaction on a large table.
  let deleted = 0;
  for (const r of breakdown) {
    const res = await prisma.plan.deleteMany({
      where: {
        planYear: r.planYear,
        state: r.state,
      },
    });
    deleted += res.count;
    console.log(`  Deleted ${res.count.toLocaleString().padStart(7)} rows — ${r.planYear} / ${r.state}`);
  }

  console.log(`\nDone. ${deleted.toLocaleString()} rows deleted.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
