/**
 * verify-plan-category.ts
 *
 * Spot-check script for backlog item #1 (Plan Type dropdown expansion).
 *
 * Run after:
 *   1. Applying the `add_plan_category` migration, and
 *   2. Re-importing CMS data with the updated `scripts/import-cms-data.ts`.
 *
 *   npx tsx scripts/verify-plan-category.ts
 *
 * The script produces a readable report and exits non-zero if any of the
 * sanity checks fail — safe to run from CI or before a deploy.
 */

import { PrismaClient, PlanCategory } from "@prisma/client";

// Use the session-mode pooler (:5432 / DIRECT_URL) — the transaction pooler
// on :6543 doesn't play nicely with Prisma's prepared statements in long-
// running scripts ("prepared statement s0 already exists").
const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DIRECT_URL || process.env.DATABASE_URL },
  },
});

// Spot-check states chosen for geographic and demographic spread:
// - FL: largest DSNP market
// - CA: largest MAPD market
// - TX: large mix of MA-only, MAPD, DSNP, CSNP
// - NY: heavy DSNP + MMP legacy
// - WY: small rural, expect mostly PFFS / Cost plans
const SAMPLE_STATES = ["FL", "CA", "TX", "NY", "WY"];

type CheckResult = { label: string; ok: boolean; detail: string };
const results: CheckResult[] = [];

function record(label: string, ok: boolean, detail: string) {
  results.push({ label, ok, detail });
  const prefix = ok ? "  [OK] " : "  [FAIL] ";
  console.log(prefix + label + " — " + detail);
}

async function overallCoverage() {
  console.log("\n=== Overall coverage ===");
  const total = await prisma.plan.count();
  const withCategory = await prisma.plan.count({ where: { planCategory: { not: null } } });
  const pct = total === 0 ? 0 : (withCategory / total) * 100;
  record(
    "planCategory populated on >= 95% of rows",
    pct >= 95,
    `${withCategory.toLocaleString()} / ${total.toLocaleString()} (${pct.toFixed(2)}%)`,
  );
}

async function categoryDistribution() {
  console.log("\n=== Category distribution (all rows) ===");
  const grouped = await prisma.plan.groupBy({
    by: ["planCategory"],
    _count: { _all: true },
    orderBy: { _count: { planCategory: "desc" } },
  });
  const total = grouped.reduce((s, g) => s + g._count._all, 0);
  for (const g of grouped) {
    const pct = ((g._count._all / total) * 100).toFixed(2);
    console.log(`  ${String(g.planCategory ?? "NULL").padEnd(10)} ${g._count._all.toString().padStart(7)}  (${pct}%)`);
  }

  const categoriesSeen = new Set(grouped.map((g) => g.planCategory).filter(Boolean));
  const expectedMinCategories: PlanCategory[] = [
    PlanCategory.MAPD,
    PlanCategory.MA_ONLY,
    PlanCategory.DSNP,
    PlanCategory.CSNP,
  ];
  for (const cat of expectedMinCategories) {
    record(
      `At least one plan classified as ${cat}`,
      categoriesSeen.has(cat),
      categoriesSeen.has(cat) ? "found" : "MISSING — check import derivation rules",
    );
  }
}

async function stateSpotChecks() {
  console.log("\n=== Per-state category counts ===");
  for (const state of SAMPLE_STATES) {
    const rows = await prisma.plan.groupBy({
      by: ["planCategory"],
      where: { state, planYear: 2026 },
      _count: { _all: true },
      orderBy: { _count: { planCategory: "desc" } },
    });
    if (rows.length === 0) {
      console.log(`  ${state} (2026): no rows`);
      continue;
    }
    const summary = rows
      .map((r) => `${r.planCategory ?? "NULL"}=${r._count._all}`)
      .join(", ");
    console.log(`  ${state} (2026): ${summary}`);
  }
}

async function dsnpSpotCheck() {
  console.log("\n=== DSNP spot-check ===");
  const dsnpTotal = await prisma.plan.count({
    where: { planCategory: PlanCategory.DSNP, planYear: 2026 },
  });
  const zeroDollarDsnps = await prisma.plan.count({
    where: { planCategory: PlanCategory.DSNP, isZeroDollarDsnp: true, planYear: 2026 },
  });
  record(
    "At least one 2026 DSNP exists",
    dsnpTotal > 0,
    `${dsnpTotal} DSNPs found`,
  );
  // Not every state has $0 DSNPs, but nationally we expect a substantial share.
  const pct = dsnpTotal === 0 ? 0 : (zeroDollarDsnps / dsnpTotal) * 100;
  record(
    "$0 DSNP flag set on a reasonable share (>= 10% nationally)",
    pct >= 10,
    `${zeroDollarDsnps}/${dsnpTotal} (${pct.toFixed(1)}%) — should be 40-60% historically`,
  );
}

async function csnpSpotCheck() {
  console.log("\n=== CSNP spot-check ===");
  const csnpTotal = await prisma.plan.count({
    where: { planCategory: PlanCategory.CSNP, planYear: 2026 },
  });
  record("At least one 2026 CSNP exists", csnpTotal > 0, `${csnpTotal} CSNPs`);

  if (csnpTotal === 0) return;

  // CSNPs must have at least one chronic condition populated.
  const csnpSample = await prisma.plan.findMany({
    where: { planCategory: PlanCategory.CSNP, planYear: 2026 },
    select: { id: true, planName: true, chronicConditions: true },
    take: 20,
  });
  const empty = csnpSample.filter((p) => !p.chronicConditions || p.chronicConditions.length === 0);
  record(
    "Sampled CSNPs have chronicConditions populated",
    empty.length === 0,
    `${csnpSample.length - empty.length}/${csnpSample.length} populated` +
      (empty.length > 0 ? ` — examples missing: ${empty.slice(0, 3).map((e) => e.planName).join("; ")}` : ""),
  );

  // Diabetes is the most common CSNP condition in the market — expect several.
  const diabetesCsnps = await prisma.plan.count({
    where: {
      planCategory: PlanCategory.CSNP,
      chronicConditions: { has: "DIABETES" },
      planYear: 2026,
    },
  });
  record(
    "At least one Diabetes CSNP exists (most common CSNP condition)",
    diabetesCsnps > 0,
    `${diabetesCsnps} plans`,
  );
}

async function isnpSpotCheck() {
  console.log("\n=== ISNP spot-check ===");
  const isnpTotal = await prisma.plan.count({
    where: { planCategory: PlanCategory.ISNP, planYear: 2026 },
  });
  if (isnpTotal === 0) {
    record("At least one 2026 ISNP exists", false, "0 ISNPs — check derivation");
    return;
  }
  record("At least one 2026 ISNP exists", true, `${isnpTotal} ISNPs`);

  // Every ISNP should have a subtype populated from pbp_a_snp_institutional_type.
  const isnpNoSubtype = await prisma.plan.count({
    where: { planCategory: PlanCategory.ISNP, snpSubtype: null, planYear: 2026 },
  });
  record(
    "All ISNPs have an snpSubtype populated",
    isnpNoSubtype === 0,
    `${isnpTotal - isnpNoSubtype}/${isnpTotal} populated`,
  );
}

async function mapdVsMaOnlyConsistency() {
  console.log("\n=== MAPD vs MA-only consistency ===");
  // hasPartD should match planCategory for MA_ONLY / MAPD.
  const mapdWithoutPartD = await prisma.plan.count({
    where: { planCategory: PlanCategory.MAPD, hasPartD: false },
  });
  const maOnlyWithPartD = await prisma.plan.count({
    where: { planCategory: PlanCategory.MA_ONLY, hasPartD: true },
  });
  record(
    "No MAPD plans with hasPartD=false",
    mapdWithoutPartD === 0,
    `${mapdWithoutPartD} inconsistencies`,
  );
  record(
    "No MA_ONLY plans with hasPartD=true",
    maOnlyWithPartD === 0,
    `${maOnlyWithPartD} inconsistencies`,
  );
}

async function contractTypePopulated() {
  console.log("\n=== cmsContractType coverage ===");
  const total = await prisma.plan.count();
  const withContract = await prisma.plan.count({ where: { cmsContractType: { not: null } } });
  const pct = total === 0 ? 0 : (withContract / total) * 100;
  // cmsContractType comes from Section A — every plan that participated in the
  // re-import should have it. Allow slight slack for legacy/orphan rows.
  record(
    "cmsContractType populated on >= 95% of rows",
    pct >= 95,
    `${withContract.toLocaleString()} / ${total.toLocaleString()} (${pct.toFixed(2)}%)`,
  );
}

async function main() {
  console.log("Plan-category verification report");
  console.log("=================================");
  console.log(`Run at: ${new Date().toISOString()}`);

  await overallCoverage();
  await categoryDistribution();
  await stateSpotChecks();
  await dsnpSpotCheck();
  await csnpSpotCheck();
  await isnpSpotCheck();
  await mapdVsMaOnlyConsistency();
  await contractTypePopulated();

  console.log("\n=== Summary ===");
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\nFailures:");
    for (const r of results.filter((r) => !r.ok)) {
      console.log(`  - ${r.label}: ${r.detail}`);
    }
    process.exit(1);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
