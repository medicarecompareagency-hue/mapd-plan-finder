import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";

const prisma = new PrismaClient();

function buildQueries(planName: string, organization: string, year: number, planId: string) {
  const base = `${organization} ${planName} ${year} summary of benefits PDF ${planId}`;

  return [
    `${base}`,
    `${organization} ${year} SB PDF ${planId}`,
    `${organization} ${planId} summary of benefits pdf`,
    `${organization} medicare advantage summary of benefits ${year} pdf`,
  ];
}

async function main() {
  const plans = await prisma.plan.findMany({
    where: {
      planYear: 2026,
      planCategory: {
        in: ["MAPD", "DSNP", "CSNP"],
      },
    },
    select: {
      planId: true,
      planName: true,
      organizationName: true,
      planYear: true,
    },
    take: 500,
  });

  const out: Array<Record<string, unknown>> = [];

  for (const plan of plans) {
    out.push({
      planId: plan.planId,
      organizationName: plan.organizationName,
      planName: plan.planName,
      queries: buildQueries(
        plan.planName,
        plan.organizationName,
        plan.planYear,
        plan.planId,
      ),
    });
  }

  const output = path.join(process.cwd(), "sb-search-queries.json");
  await fs.promises.writeFile(output, JSON.stringify(out, null, 2));

  console.log(`Wrote ${out.length} plan search query sets to ${output}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
