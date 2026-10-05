const fs = require("fs");
const { makePrisma } = require("./prisma-client");
const prisma = makePrisma();
async function main() {
  const path = "scripts/data/qmb-protection-overrides.json";
  if (!fs.existsSync(path)) { console.log("no overrides file — skip"); return; }
  const data = JSON.parse(fs.readFileSync(path, "utf8"));
  let n = 0;
  for (const [planId, v] of Object.entries(data)) {
    const r = await prisma.plan.updateMany({
      where: { planId, planYear: 2026 },   // 2026 SB classification only; never stamp it onto another plan year
      data: { qmbCostShareProtected: v.protected, costShareProtectedLevels: (v.levels || []).join(",") || null },
    });
    n += r.count;
    console.log(`  override ${planId} -> protected=${v.protected}  (${r.count} rows)`);
  }
  console.log(`applied ${Object.keys(data).length} overrides across ${n} rows`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
