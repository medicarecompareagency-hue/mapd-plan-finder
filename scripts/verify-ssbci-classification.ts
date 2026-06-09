// Read-only verification of the SSBCI Step D backfill.
const { makePrisma } = require("./prisma-client");
const prisma = makePrisma();

async function main() {
  const base = {
    sbPdfUrl: { not: null },
    OR: [
      { ssbciOffersFood: true }, { ssbciOffersMeals: true }, { ssbciOffersUtilities: true },
      { ssbciOffersHousing: true }, { ssbciOffersTransportation: true },
    ],
  };
  const total = await prisma.plan.count({ where: base });
  const conditional = await prisma.plan.count({ where: { ...base, ssbciIsConditional: true } });
  const standalone = await prisma.plan.count({ where: { ...base, ssbciIsStandalone: true } });
  const withNote = await prisma.plan.count({ where: { ...base, ssbciConditionNote: { not: null } } });
  console.log(`SSBCI-offering plans with an SB PDF: ${total}`);
  console.log(`  ssbciIsConditional = true : ${conditional}`);
  console.log(`  ssbciIsStandalone  = true : ${standalone}`);
  console.log(`  has conditionNote        : ${withNote}`);

  for (const id of ["H9888-1", "H5521-171", "H0628-1"]) {
    const p = await prisma.plan.findFirst({
      where: { planId: id },
      select: { planId: true, planName: true, ssbciIsConditional: true, ssbciIsStandalone: true, ssbciConditionNote: true, ssbciFoodAllowance: true, sbPdfUrl: true },
    });
    console.log(`\n${id}:`, p ? JSON.stringify(p, null, 2) : "NOT FOUND");
  }
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
