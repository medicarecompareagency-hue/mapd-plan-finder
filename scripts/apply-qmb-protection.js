// Apply SB-derived QMB cost-share protection to the Plan table.
const fs = require("fs");
const { makePrisma } = require("./prisma-client");
const prisma = makePrisma();

async function main() {
  const data = JSON.parse(fs.readFileSync("scripts/data/qmb-protection.json", "utf8"));
  let updated = 0;
  for (const [planId, v] of Object.entries(data)) {
    const r = await prisma.plan.updateMany({
      where: { planId },
      data: {
        qmbCostShareProtected: v.protected,            // true | false | null
        costShareProtectedLevels: (v.levels || []).join(",") || null,
      },
    });
    updated += r.count;
  }
  console.log(`updated ${updated} Plan rows from ${Object.keys(data).length} planIds`);

  // Coverage report across the plans QMB actually sees (FULL_DUAL bucket)
  const fullDual = await prisma.plan.findMany({
    where: { dsnpTargetGroup: "FULL_DUAL" },
    select: { planId: true, organizationName: true, qmbCostShareProtected: true },
  });
  const seen = new Map();
  for (const p of fullDual) if (!seen.has(p.planId)) seen.set(p.planId, p);
  const arr = [...seen.values()];
  const c = (val) => arr.filter((p) => p.qmbCostShareProtected === val).length;
  console.log(`\nFULL_DUAL distinct planIds=${arr.length}  show(true)=${c(true)}  hide(false)=${c(false)}  null=${c(null)}`);
  // null plans = QMB would lose these under strict filter — review list:
  const nulls = arr.filter((p) => p.qmbCostShareProtected === null);
  if (nulls.length) {
    console.log(`\nFULL_DUAL plans with NULL (no SB signal) — review before deploy:`);
    for (const p of nulls.slice(0, 60)) console.log(`  ${p.planId}  ${p.organizationName || ""}`);
    if (nulls.length > 60) console.log(`  ...and ${nulls.length - 60} more`);
  }

  // sanity (planIds use DB format: no zero-padding)
  for (const [pid, exp] of [["H2802-64", false], ["H5216-164", true]]) {
    const row = await prisma.plan.findFirst({ where: { planId: pid }, select: { qmbCostShareProtected: true } });
    console.log(`  check ${pid}: ${row ? row.qmbCostShareProtected : "NOT IN DB"} (expect ${exp})`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
