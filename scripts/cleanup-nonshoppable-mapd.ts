/**
 * cleanup-nonshoppable-mapd.ts
 *
 * One-shot cleanup for the DB bloat left behind by the two hung
 * `backfill-missing-plans` runs on 2026 (before the connection-recycle
 * fix). Those runs inserted ~259K MAPD rows from PlanArea.txt that NBER
 * intentionally trimmed from its landscape CSV because they aren't
 * shoppable on Medicare Plan Finder (closed to new enrollment,
 * non-eligible for AEP, etc.). Agents shouldn't see them.
 *
 * Logic:
 *   1. Read the NBER landscape CSV for the given plan year — this is
 *      the authoritative "shoppable MAPDs" list.
 *   2. Build the set of (planId, state, county) tuples that landscape
 *      blesses.
 *   3. Delete any row in the DB where planYear=YEAR,
 *      planCategory=MAPD, and (planId, state, county) is NOT in that
 *      set.
 *
 * Anything SNP / PACE / MSA / COST / MMP / MA_ONLY is untouched —
 * those categories are never in the landscape by design, so their
 * "not in landscape" status is normal, not evidence of bloat.
 *
 * Safe to re-run. If there's no bloat, deletes zero.
 *
 *   npx tsx scripts/cleanup-nonshoppable-mapd.ts 2026
 *   npx tsx scripts/cleanup-nonshoppable-mapd.ts 2026 --dry-run
 */

import { PrismaClient, PlanCategory } from "@prisma/client";
import { parse } from "csv-parse/sync";
import * as fs from "fs";
import * as path from "path";

const args = process.argv.slice(2);
const PLAN_YEAR = parseInt(args.find((a) => /^\d{4}$/.test(a)) || "2026", 10);
const DRY_RUN = args.includes("--dry-run");
const LANDSCAPE_PATH = path.join(
  process.cwd(),
  ".cms-import-tmp",
  `ma${PLAN_YEAR}.csv`,
);

const STATE_ABBREVS: Record<string, string> = {
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA",
  Colorado: "CO", Connecticut: "CT", Delaware: "DE", "District of Columbia": "DC",
  Florida: "FL", Georgia: "GA", Hawaii: "HI", Idaho: "ID", Illinois: "IL",
  Indiana: "IN", Iowa: "IA", Kansas: "KS", Kentucky: "KY", Louisiana: "LA",
  Maine: "ME", Maryland: "MD", Massachusetts: "MA", Michigan: "MI", Minnesota: "MN",
  Mississippi: "MS", Missouri: "MO", Montana: "MT", Nebraska: "NE", Nevada: "NV",
  "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY",
  "North Carolina": "NC", "North Dakota": "ND", Ohio: "OH", Oklahoma: "OK",
  Oregon: "OR", Pennsylvania: "PA", "Puerto Rico": "PR", "Rhode Island": "RI",
  "South Carolina": "SC", "South Dakota": "SD", Tennessee: "TN", Texas: "TX",
  Utah: "UT", Vermont: "VT", Virginia: "VA", Washington: "WA",
  "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY",
};

function makeClient(): PrismaClient {
  return new PrismaClient({
    datasources: {
      db: { url: process.env.DIRECT_URL || process.env.DATABASE_URL },
    },
    log: ["warn", "error"],
  });
}

interface LandscapeRow {
  state: string;
  county: string;
  contractid: string;
  planid: string;
  segmentid: string;
}

function buildLandscapeSet(): Set<string> {
  console.log(`Reading landscape CSV: ${LANDSCAPE_PATH}`);
  if (!fs.existsSync(LANDSCAPE_PATH)) {
    throw new Error(
      `Landscape CSV not found at ${LANDSCAPE_PATH}. Run 'npm run import-cms -- ${PLAN_YEAR}' first (it caches the CSV).`,
    );
  }
  const content = fs.readFileSync(LANDSCAPE_PATH, "utf-8");
  const rows = parse(content, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  }) as LandscapeRow[];
  console.log(`  ${rows.length.toLocaleString()} landscape rows`);

  const set = new Set<string>();
  for (const r of rows) {
    const contractId = (r.contractid || "").trim();
    const planIdNum = (r.planid || "").trim();
    if (!contractId || !planIdNum) continue;
    const planId = `${contractId}-${parseInt(planIdNum, 10)}`;
    const stateAbbrev = STATE_ABBREVS[r.state] || r.state;
    const county = (r.county || "").trim();
    if (!county || !stateAbbrev) continue;
    set.add(`${planId}|${stateAbbrev}|${county}`);
  }
  console.log(`  ${set.size.toLocaleString()} distinct (planId, state, county) tuples`);
  return set;
}

async function main() {
  console.log(`\nCleanup non-shoppable MAPD rows for plan year ${PLAN_YEAR}`);
  console.log(DRY_RUN ? "DRY RUN — no deletes will be executed" : "LIVE — deletes will commit");
  console.log("================================================\n");

  const shoppable = buildLandscapeSet();

  let prisma = makeClient();

  console.log("\nLoading current 2026 MAPD rows from DB...");
  const mapdRows = await prisma.plan.findMany({
    where: { planYear: PLAN_YEAR, planCategory: PlanCategory.MAPD },
    select: { id: true, planId: true, state: true, county: true },
  });
  console.log(`  ${mapdRows.length.toLocaleString()} MAPD rows for ${PLAN_YEAR}`);

  // Partition.
  const toDelete: number[] = [];
  for (const r of mapdRows) {
    const key = `${r.planId}|${r.state}|${r.county}`;
    if (!shoppable.has(key)) toDelete.push(r.id);
  }
  const keep = mapdRows.length - toDelete.length;
  console.log(`  non-shoppable (will delete): ${toDelete.length.toLocaleString()}`);
  console.log(`  shoppable (keep):            ${keep.toLocaleString()}`);

  if (toDelete.length === 0) {
    console.log("\nNothing to delete. DB is clean.");
    await prisma.$disconnect();
    return;
  }

  if (DRY_RUN) {
    console.log("\nDry run — exiting without deleting.");
    await prisma.$disconnect();
    return;
  }

  // Delete in small chunks with connection recycling — same prepared-statement
  // cache concern as the backfill script.
  const BATCH = 1000;
  const RECYCLE_AFTER_BATCHES = 50;
  let deleted = 0;
  let batchesSinceRecycle = 0;
  const startTime = Date.now();

  console.log("\nDeleting...");
  for (let i = 0; i < toDelete.length; i += BATCH) {
    const slice = toDelete.slice(i, i + BATCH);
    const t0 = Date.now();
    const res = await prisma.plan.deleteMany({ where: { id: { in: slice } } });
    deleted += res.count;
    batchesSinceRecycle++;

    const elapsed = Date.now() - t0;
    const done = Math.min(i + BATCH, toDelete.length);
    // Log every batch if slow, every 10 batches if fast.
    const shouldLog =
      elapsed > 1000 ||
      (Math.floor(done / BATCH) % 10 === 0) ||
      done >= toDelete.length;
    if (shouldLog) {
      const pct = ((done / toDelete.length) * 100).toFixed(1);
      const elapsedTotal = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(
        `  ${done.toLocaleString().padStart(7)} / ${toDelete.length.toLocaleString()} (${pct}%) — batch ${elapsed}ms — elapsed ${elapsedTotal}s`,
      );
    }

    if (batchesSinceRecycle >= RECYCLE_AFTER_BATCHES && i + BATCH < toDelete.length) {
      await prisma.$disconnect();
      prisma = makeClient();
      batchesSinceRecycle = 0;
    }
  }

  const totalSecs = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`\nDone in ${totalSecs}s. Deleted ${deleted.toLocaleString()} non-shoppable MAPD rows.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
