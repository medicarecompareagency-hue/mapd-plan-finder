// scripts/fix-specialist-zero-copay.js
//
// Fixes the 2026-06-16 audit's Specialist N/A gap: PBP b7d files copay_yn=2 AND
// coins_yn=2 (neither filed) for these plans, but every one of their SB PDFs
// explicitly states "$0 copay" / "Specialist: $0 copay" / "Specialist office
// visits $0 per visit" for the specialist benefit. Read all 29 SBs by hand
// (2026-06-16 fix prompt) — every single one is unambiguously $0, none needed
// to stay NULL.
//
// Specialist is ranking key #4 (default ranker), key #1 (CSNP / DSNP
// PARTIAL_DUAL), key #3 (MA_ONLY) — DSNP FULL_DUAL has no specialist key.
// This DOES affect ranking for the affected plans' categories.
//
// USAGE:
//   node scripts/fix-specialist-zero-copay.js                 # dry-run
//   node scripts/fix-specialist-zero-copay.js --apply         # write
//
const { makePrisma } = require("./prisma-client");
const prisma = makePrisma();

const APPLY = process.argv.includes("--apply");

// Confirmed by hand against each plan's SB PDF (pdftotext -layout), 2026-06-16.
const SB_CONFIRMED_ZERO = [
  "H0672-15", "H0439-2", "H4513-55", "H4407-4", "H1290-21", "H5410-32", "H4513-60",
  "H4513-35", "H5410-25", "H1290-2", "H1290-3", "H1290-62", "H0439-22", "H1290-1",
  "H5410-47", "H4513-63", "H4513-80", "H5410-42", "H4513-53", "H1290-56", "H5410-31",
  "H5410-13", "H1290-64", "H1290-19", "H4513-27", "H5410-55", "H4513-75", "H1290-20",
  "H5410-56",
];

async function main() {
  const plans = await prisma.plan.findMany({
    where: { planId: { in: SB_CONFIRMED_ZERO }, specialistCopay: null, specialistCoinsPct: null },
    distinct: ["planId"],
    select: { planId: true, organizationName: true, planCategory: true, dsnpTargetGroup: true },
  });
  console.log(`Plans matching SB-confirmed-zero list and still NULL: ${plans.length} (expected ${SB_CONFIRMED_ZERO.length})`);
  if (plans.length !== SB_CONFIRMED_ZERO.length) {
    const found = new Set(plans.map((p) => p.planId));
    console.log("Missing/already-set:", SB_CONFIRMED_ZERO.filter((id) => !found.has(id)));
  }

  let changedRows = 0;
  for (const p of plans) {
    console.log(`  ${p.planId} ${p.organizationName} (${p.planCategory}/${p.dsnpTargetGroup || ""}): specialistCopay NULL -> 0`);
    if (APPLY) {
      const r = await prisma.plan.updateMany({
        where: { planId: p.planId },
        data: { specialistCopay: 0 },
      });
      changedRows += r.count;
    }
  }
  if (APPLY) console.log(`\nRows written: ${changedRows}`);
  else console.log(`\nDry-run — no writes. Re-run with --apply to persist.`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
