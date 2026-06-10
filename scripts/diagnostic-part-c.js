// Part C read-only diagnostic script.
// Run: node scripts/diagnostic-part-c.js
"use strict";
const { makePrisma } = require("./prisma-client.js");
const { LICENSED_STATES } = require("./licensed-states.js");

async function main() {
  const prisma = makePrisma();

  // ── C1: Devoted H9888-13 MSA label ─────────────────────────────────────
  console.log("\n=== C1: Devoted H9888-13 contract type ===");
  const devoted = await prisma.plan.findMany({
    where: { planId: { startsWith: "H9888-13" }, planYear: 2026 },
    select: { planId: true, planName: true, organizationName: true, planType: true, cmsContractType: true, planCategory: true, snpSubtype: true, dsnpTargetGroup: true, state: true, county: true },
    take: 5,
  });
  console.log("H9888-13 rows:", JSON.stringify(devoted, null, 2));

  // Count SNP rows with cmsContractType containing 'MSA'
  const snpWithMsa = await prisma.plan.count({
    where: {
      planYear: 2026,
      planCategory: { in: ["DSNP","CSNP","ISNP"] },
      cmsContractType: { contains: "MSA" },
    },
  });
  console.log(`SNP rows (2026) with cmsContractType containing 'MSA': ${snpWithMsa}`);

  // ── C2: Dual-eligibility levels for the 4 searched plans ───────────────
  console.log("\n=== C2: Dual-level data for the 4 returned plans ===");
  const contractIds = ["H9888-13", "H4461-76", "H2802-64", "H4513-63"];
  for (const cid of contractIds) {
    const rows = await prisma.plan.findMany({
      where: {
        planYear: 2026,
        state: "AL",
        planId: { startsWith: cid },
      },
      select: {
        planId: true, planName: true, organizationName: true,
        planCategory: true, planType: true, cmsContractType: true,
        dsnpTargetGroup: true, medicaidLevel: true, lowIncomeSubsidyLevel: true,
        county: true,
      },
      take: 3,
    });
    console.log(`\n${cid} (first ≤3 AL rows):`);
    for (const r of rows) {
      console.log(`  ${r.planId} | ${r.county} | cat=${r.planCategory} | type=${r.planType} | cmsContractType=${r.cmsContractType} | dsnpTargetGroup=${r.dsnpTargetGroup} | medicaidLevel=${r.medicaidLevel}`);
    }
  }

  // ── C3: How many DSNP FULL_DUAL plans in AL/Shelby/2026? ───────────────
  console.log("\n=== C3: DSNP FULL_DUAL count in AL / Shelby County / 2026 ===");
  const allDsnpShelby = await prisma.plan.findMany({
    where: {
      planYear: 2026,
      state: "AL",
      county: { in: ["Shelby", "Shelby County"] },
      planCategory: "DSNP",
    },
    select: {
      planId: true, planName: true, organizationName: true,
      dsnpTargetGroup: true, planType: true, cmsContractType: true,
    },
    orderBy: [{ dsnpTargetGroup: "asc" }, { organizationName: "asc" }],
  });
  console.log(`Total DSNP rows in AL/Shelby 2026: ${allDsnpShelby.length}`);

  const fullDual = allDsnpShelby.filter(r => r.dsnpTargetGroup === "FULL_DUAL");
  const partialDual = allDsnpShelby.filter(r => r.dsnpTargetGroup === "PARTIAL_DUAL");
  const noGroup = allDsnpShelby.filter(r => !r.dsnpTargetGroup);

  console.log(`  FULL_DUAL: ${fullDual.length}`);
  for (const r of fullDual) {
    console.log(`    ${r.planId} | ${r.organizationName} | ${r.planType} | cmsContractType=${r.cmsContractType}`);
  }
  console.log(`  PARTIAL_DUAL: ${partialDual.length}`);
  for (const r of partialDual) {
    console.log(`    ${r.planId} | ${r.organizationName} | ${r.planType} | cmsContractType=${r.cmsContractType}`);
  }
  console.log(`  dsnpTargetGroup=null: ${noGroup.length}`);
  for (const r of noGroup) {
    console.log(`    ${r.planId} | ${r.organizationName} | ${r.planType} | cmsContractType=${r.cmsContractType}`);
  }

  // Unique carriers among FULL_DUAL (dedupe by organizationName)
  const fullDualCarriers = [...new Set(fullDual.map(r => r.organizationName.toLowerCase().trim()))];
  console.log(`\nDistinct FULL_DUAL carriers: ${fullDualCarriers.length} → ${fullDualCarriers.join(", ")}`);

  // ── Count in-scope plans missing sbPdfUrl for Part B ───────────────────
  console.log("\n=== Part B: In-scope plans missing sbPdfUrl ===");
  const { LICENSED_CARRIERS } = require("../lib/licensed-carriers");
  const missingCount = await prisma.plan.count({
    where: {
      planYear: 2026,
      state: { in: LICENSED_STATES },
      organizationName: { in: [...LICENSED_CARRIERS] },
      sbPdfUrl: null,
    },
  });
  const totalInScope = await prisma.plan.count({
    where: {
      planYear: 2026,
      state: { in: LICENSED_STATES },
      organizationName: { in: [...LICENSED_CARRIERS] },
    },
  });
  console.log(`In-scope plans (2026, licensed states+carriers): ${totalInScope}`);
  console.log(`Missing sbPdfUrl: ${missingCount}`);
  console.log(`Already have sbPdfUrl: ${totalInScope - missingCount}`);

  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
