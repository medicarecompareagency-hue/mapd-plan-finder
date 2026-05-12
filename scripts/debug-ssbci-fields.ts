import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const plans = await prisma.plan.findMany({
    where: {
      OR: [
        { ssbciOffersFood: true },
        { ssbciOffersMeals: true },
        { ssbciOffersUtilities: true },
        { ssbciOffersHousing: true },
        { ssbciOffersTransportation: true },
      ],
    },
    select: {
      planId: true,
      planName: true,
      organizationName: true,
      planYear: true,
      ssbciOffersFood: true,
      ssbciOffersMeals: true,
      ssbciOffersUtilities: true,
      ssbciOffersHousing: true,
      ssbciOffersTransportation: true,
      ssbciFoodAllowance: true,
      ssbciMealsAllowance: true,
      ssbciTransportationAllowance: true,
    },
    take: 250,
  });

  console.table(plans);

  const missingDollarAmounts = plans.filter(
    (p) =>
      (p.ssbciOffersFood && !p.ssbciFoodAllowance) ||
      (p.ssbciOffersMeals && !p.ssbciMealsAllowance),
  );

  console.log(`Plans missing filed dollar amounts: ${missingDollarAmounts.length}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
