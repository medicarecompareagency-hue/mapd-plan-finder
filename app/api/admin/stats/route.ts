export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  const expected = process.env.ADMIN_PASSWORD || "mapd-admin-2024";
  if (authHeader !== `Bearer ${expected}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { prisma } = await import("@/lib/prisma");

  const totalPlans = await prisma.plan.count();
  const latestPlan = await prisma.plan.findFirst({ orderBy: { updatedAt: "desc" } });

  const plansByYear = await prisma.plan.groupBy({
    by: ["planYear"],
    _count: { id: true },
    orderBy: { planYear: "desc" },
  });

  return Response.json({
    totalPlans,
    lastImportDate: latestPlan?.updatedAt ?? null,
    plansByYear: plansByYear.map((g) => ({ year: g.planYear, count: g._count.id })),
  });
}
