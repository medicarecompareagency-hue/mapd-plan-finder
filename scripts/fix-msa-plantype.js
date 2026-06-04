// scripts/fix-msa-plantype.js
// One-shot fix: correct planType='MSA' → real contract type from cmsContractType (2026 only)
// Approved by Dale 2026-06-04. Run: node scripts/fix-msa-plantype.js

const { makePrisma } = require("./prisma-client");

const CMS_TO_PLAN_TYPE = {
  "Local PPO":    "PPO",
  "Local HMO":    "HMO",
  "Regional PPO": "RPPO",
  "PFFS":         "PFFS",
  "HMO-POS":      "HMO-POS",
};

async function main() {
  const prisma = makePrisma();
  try {
    // ── Step 1: Audit ──────────────────────────────────────────────────────────
    console.log("\n=== STEP 1: AUDIT (planType=MSA, planYear=2026) ===\n");

    const rows = await prisma.$queryRaw`
      SELECT "planId", "organizationName", "planCategory",
             "planType", "cmsContractType", COUNT(*) as row_count
      FROM "Plan"
      WHERE "planType" = 'MSA' AND "planYear" = 2026
      GROUP BY "planId", "organizationName", "planCategory",
               "planType", "cmsContractType"
      ORDER BY "organizationName", "planId"
    `;

    if (rows.length === 0) {
      console.log("No rows with planType='MSA' for 2026. Nothing to do.");
      return;
    }

    console.log(`Found ${rows.length} distinct group(s):\n`);
    const toFix = [];
    const toFlag = [];
    for (const r of rows) {
      const cnt = Number(r.row_count);
      console.log(
        `  planId=${r.planId}  org=${r.organizationName}  ` +
        `planCategory=${r.planCategory}  cmsContractType=${r.cmsContractType}  rows=${cnt}`
      );
      if (!r.cmsContractType || r.cmsContractType === "MSA") {
        toFlag.push(r);
      } else {
        toFix.push(r);
      }
    }

    if (toFlag.length > 0) {
      console.log("\n⚠  FLAGGED (cmsContractType is null or 'MSA' — DO NOT update):");
      for (const r of toFlag) {
        console.log(`   planId=${r.planId}  cmsContractType=${r.cmsContractType}`);
      }
    }

    if (toFix.length === 0) {
      console.log("\nNo rows eligible for update after flagging. Exiting.");
      return;
    }

    // ── Step 2: Map cmsContractType → planType ─────────────────────────────────
    console.log("\n=== STEP 2: MAPPING CHECK ===\n");
    const distinctContractTypes = [...new Set(toFix.map((r) => r.cmsContractType))];
    for (const ct of distinctContractTypes) {
      const mapped = CMS_TO_PLAN_TYPE[ct];
      if (!mapped) {
        console.error(`ERROR: No mapping for cmsContractType='${ct}'. STOPPING.`);
        process.exit(1);
      }
      console.log(`  '${ct}' → '${mapped}'`);
    }

    // ── Step 3: Apply fix ──────────────────────────────────────────────────────
    console.log("\n=== STEP 3: APPLYING UPDATES ===\n");
    let totalUpdated = 0;
    for (const ct of distinctContractTypes) {
      const newPlanType = CMS_TO_PLAN_TYPE[ct];
      const result = await prisma.plan.updateMany({
        where: { planType: "MSA", cmsContractType: ct, planYear: 2026 },
        data: { planType: newPlanType },
      });
      console.log(`  cmsContractType='${ct}' → planType='${newPlanType}': ${result.count} rows updated`);
      totalUpdated += result.count;
    }
    console.log(`\nTotal rows updated: ${totalUpdated}`);

    // ── Step 4: Verify ─────────────────────────────────────────────────────────
    console.log("\n=== STEP 4: VERIFICATION ===\n");
    const remaining = await prisma.$queryRaw`
      SELECT COUNT(*) as cnt FROM "Plan"
      WHERE "planType" = 'MSA' AND "planYear" = 2026
    `;
    const remCnt = Number(remaining[0].cnt);
    console.log(`Rows still with planType='MSA' (2026): ${remCnt}`);
    if (remCnt > 0) console.warn("⚠  Some rows were not updated.");

    // Spot-check
    const spotCheck = await prisma.plan.findMany({
      where: {
        planId: { in: ["H9888-13", "H5216-370"] },
        planYear: 2026,
      },
      select: { planId: true, organizationName: true, planType: true, cmsContractType: true },
      distinct: ["planId"],
    });
    console.log("\nSpot-check H9888-13 and H5216-370:");
    if (spotCheck.length === 0) {
      console.log("  (neither planId found in DB)");
    }
    for (const p of spotCheck) {
      console.log(`  ${p.planId}  ${p.organizationName}  planType=${p.planType}  cmsContractType=${p.cmsContractType}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
