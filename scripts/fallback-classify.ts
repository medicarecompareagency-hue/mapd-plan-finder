/**
 * fallback-classify.ts
 *
 * Some plans are present in the NBER landscape CSV but MISSING from
 * CMS's pbp_Section_A.txt. These are real, shoppable plans (major
 * carriers — Wellcare, Humana, Cigna, UnitedHealthcare) that for
 * whatever reason didn't file PBP Benefits detail in time for the
 * cached ZIP — e.g. carrier withdrew + re-filed between snapshots,
 * or NBER pulled from a later CMS Plan Finder feed.
 *
 * These plans show up in the DB with legacy `planType` populated
 * from the landscape CSV (e.g. "Local HMO", "Local PPO", "MSA *",
 * "Regional PPO") but no `planCategory` — so they're invisible in
 * the new dropdown.
 *
 * This script classifies them using only the legacy `planType` text.
 * Heuristic:
 *
 *   "MSA"                                         -> MSA
 *   "Cost" / "1876 Cost" / "1833 Cost"           -> COST
 *   "PACE"                                        -> PACE
 *   "PDP" / "Employer/Union Direct PDP"          -> PDP
 *   "MMP"                                         -> MMP
 *   "HMO" / "PPO" / "PFFS" / "PSO" / "HMOPOS"    -> MAPD  (safe default)
 *   fallback                                      -> MAPD
 *
 * MAPD is the safe default because ~95% of non-SNP MA plans include
 * Part D. We can't distinguish MAPD from MA-only here without PBP
 * data, but the UI filter would treat them identically in that case
 * anyway (both still show under MA filter). SNPs are NOT in this
 * NULL set — they were never in the landscape CSV so they don't end
 * up in the DB without Section A data.
 *
 * Writes:
 *   - planCategory      (derived above)
 *   - cmsContractType   (copied from legacy `planType` — it already
 *                        has the right value)
 *
 * Does NOT touch:
 *   - snpSubtype, chronicConditions, hasPartD, isZeroDollarDsnp —
 *     those aren't knowable from landscape alone.
 *
 *   npx tsx scripts/fallback-classify.ts
 *   npx tsx scripts/fallback-classify.ts --dry-run
 */

import { PrismaClient, PlanCategory } from "@prisma/client";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");

function makeClient(): PrismaClient {
  return new PrismaClient({
    datasources: {
      db: { url: process.env.DIRECT_URL || process.env.DATABASE_URL },
    },
    log: ["warn", "error"],
  });
}

function classify(planType: string | null): PlanCategory {
  if (!planType) return PlanCategory.MAPD;
  const t = planType.toLowerCase();
  if (t.includes("msa")) return PlanCategory.MSA;
  if (t.includes("cost") || t.includes("1876") || t.includes("1833"))
    return PlanCategory.COST;
  if (t.includes("pace")) return PlanCategory.PACE;
  if (t.includes("pdp")) return PlanCategory.PDP;
  if (t.includes("mmp")) return PlanCategory.MMP;
  // HMO, PPO, PFFS, PSO, HMOPOS, Regional PPO, Local HMO, etc.
  return PlanCategory.MAPD;
}

async function main() {
  console.log(`\nFallback classifier for NULL-category rows`);
  console.log(DRY_RUN ? "DRY RUN" : "LIVE");
  console.log("================================================\n");

  let prisma = makeClient();

  // Find all rows with NULL planCategory, grouped by planType so we can
  // batch-update efficiently.
  const rows = await prisma.plan.findMany({
    where: { planCategory: null },
    select: { id: true, planType: true },
  });
  console.log(`Found ${rows.length.toLocaleString()} NULL-category rows`);

  // Bucket by (planType, computed category) so we can issue one UPDATE per bucket.
  const buckets = new Map<string, { cat: PlanCategory; planType: string; ids: number[] }>();
  for (const r of rows) {
    const cat = classify(r.planType);
    const bucketKey = `${r.planType ?? "<null>"}|${cat}`;
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = { cat, planType: r.planType ?? "Unknown", ids: [] };
      buckets.set(bucketKey, bucket);
    }
    bucket.ids.push(r.id);
  }

  console.log(`\nBreakdown (${buckets.size} planType variants):`);
  const byCat = new Map<PlanCategory, number>();
  for (const b of buckets.values()) {
    byCat.set(b.cat, (byCat.get(b.cat) ?? 0) + b.ids.length);
  }
  for (const [c, n] of [...byCat.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(c).padEnd(10)} ${n.toLocaleString().padStart(7)}`);
  }

  if (DRY_RUN) {
    console.log("\nDry run — no writes.");
    await prisma.$disconnect();
    return;
  }

  // Update in chunks keyed by id. Same connection-recycle pattern as the
  // other scripts.
  const BATCH = 500;
  const RECYCLE_AFTER = 50;
  let updated = 0;
  let sinceRecycle = 0;
  const startTime = Date.now();
  const allIds: { id: number; cat: PlanCategory; planType: string }[] = [];
  for (const b of buckets.values()) {
    for (const id of b.ids) allIds.push({ id, cat: b.cat, planType: b.planType });
  }

  console.log(`\nUpdating ${allIds.length.toLocaleString()} rows...`);

  // Group by (cat, planType) so each UPDATE hits uniform data.
  const perBucket = new Map<string, { cat: PlanCategory; planType: string; ids: number[] }>();
  for (const x of allIds) {
    const k = `${x.cat}|${x.planType}`;
    if (!perBucket.has(k)) perBucket.set(k, { cat: x.cat, planType: x.planType, ids: [] });
    perBucket.get(k)!.ids.push(x.id);
  }

  let bucketsDone = 0;
  for (const b of perBucket.values()) {
    for (let i = 0; i < b.ids.length; i += BATCH) {
      const slice = b.ids.slice(i, i + BATCH);
      const res = await prisma.plan.updateMany({
        where: { id: { in: slice } },
        data: {
          planCategory: b.cat,
          cmsContractType: b.planType,
        },
      });
      updated += res.count;
      sinceRecycle++;

      if (sinceRecycle >= RECYCLE_AFTER) {
        await prisma.$disconnect();
        prisma = makeClient();
        sinceRecycle = 0;
      }
    }
    bucketsDone++;
    const pct = ((bucketsDone / perBucket.size) * 100).toFixed(1);
    const el = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log(
      `  ${bucketsDone}/${perBucket.size} buckets (${pct}%) — ${updated.toLocaleString()} rows — ${el}s`,
    );
  }

  const totalSecs = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`\nDone in ${totalSecs}s. Updated ${updated.toLocaleString()} rows.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
