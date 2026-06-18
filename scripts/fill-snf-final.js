// scripts/fill-snf-final.js
//
// Final SkilledNursing fills — explicit, Dale-confirmed values (2026-06-18). Exact-string writes,
// not parsed. H0672-15/H2406-50 had partials (missing days 1-20); H0439-22 was NULL; H4514-16/23
// are DSNP full-dual ($0). H2406-52 deliberately stays NULL (true Original-Medicare pass-through).
//
// USAGE (from repo root):
//   node scripts/fill-snf-final.js            # dry-run (prints current -> new per plan)
//   node scripts/fill-snf-final.js --apply    # write
//
const { makePrisma } = require("./prisma-client");
const prisma = makePrisma();
const APPLY = process.argv.includes("--apply");
const PLAN_YEAR = 2026;

const FILLS = {
  "H0672-15": "$0/day days 1-20, $209.5/day days 21-100",
  "H0439-22": "$0/day days 1-20, $209.5/day days 21-100",
  "H2406-50": "$0/day days 1-20, $217/day days 21-100",
  "H4514-16": "$0/day",
  "H4514-23": "$0/day",
};

async function main() {
  let rows = 0, missing = 0;
  for (const [planId, value] of Object.entries(FILLS)) {
    const cur = await prisma.plan.findFirst({
      where: { planId, planYear: PLAN_YEAR },
      select: { skilledNursingCopay: true, organizationName: true, state: true },
    });
    if (!cur) { console.log(`${planId}: NOT FOUND (skipped)`); missing++; continue; }
    console.log(`${planId} (${cur.organizationName}, ${cur.state}): ${JSON.stringify(cur.skilledNursingCopay)} -> ${JSON.stringify(value)}`);
    if (APPLY) {
      const r = await prisma.plan.updateMany({ where: { planId, planYear: PLAN_YEAR }, data: { skilledNursingCopay: value } });
      rows += r.count;
    }
  }
  console.log(APPLY ? `\nRows written: ${rows}${missing ? ` (| ${missing} planId not found)` : ""}` : `\nDry-run — no writes. Re-run with --apply.`);
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
