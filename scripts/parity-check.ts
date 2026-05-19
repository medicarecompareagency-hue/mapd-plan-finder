/**
 * Parity check — compare a NEON snapshot against a SUPABASE snapshot to
 * confirm Neon is ready to receive prod traffic.
 *
 * Drop this file into c:\Users\dbuir\mapd-plan-finder\scripts\parity-check.ts
 * and run with:
 *   npx tsx scripts/parity-check.ts
 *
 * Required env vars (add to .env.local for the run):
 *   NEON_URL    = your Neon pooled URL with ?pgbouncer=true
 *   SUPA_URL    = your Supabase pooled URL with ?pgbouncer=true
 *
 * Exit code is 0 if parity gate passes, 1 if not — so you can wire this
 * into a pre-deploy check later.
 */

import { PrismaClient } from "@prisma/client";

const NEON_URL = process.env.NEON_URL;
const SUPA_URL = process.env.SUPA_URL;
const PLAN_YEAR = Number(process.env.PARITY_YEAR ?? 2026);

if (!NEON_URL || !SUPA_URL) {
  console.error("Set NEON_URL and SUPA_URL env vars before running.");
  process.exit(2);
}

// Licensed scope mirrors Neon's intended slice
const LICENSED_STATES = [
  "AL","AR","FL","GA","IL","IN","KS","KY","LA","MO",
  "MS","OH","OK","SC","TN","TX","VA","WV",
];

// 8 licensed carriers — adjust if your licensed-carriers.ts diverges
const LICENSED_CARRIERS_HINT =
  "Filter to your licensed-carriers.ts allowlist before reading numbers below.";

const neon = new PrismaClient({ datasources: { db: { url: NEON_URL } } });
const supa = new PrismaClient({ datasources: { db: { url: SUPA_URL } } });

type CountsByKey = Record<string, number>;

async function snapshot(label: string, client: PrismaClient) {
  const whereLicensedSlice = {
    planYear: PLAN_YEAR,
    state: { in: LICENSED_STATES },
  };

  const total = await client.plan.count({ where: whereLicensedSlice });

  // Distribution by planCategory
  const byCategory = await client.plan.groupBy({
    by: ["planCategory"],
    where: whereLicensedSlice,
    _count: { _all: true },
  });

  // Distribution by medicaidLevel (DSNPs only)
  const byMedicaidLevel = await client.plan.groupBy({
    by: ["medicaidLevel"],
    where: { ...whereLicensedSlice, planCategory: "DSNP" as any },
    _count: { _all: true },
  });

  // Distinct carriers
  const carrierRows = await client.plan.findMany({
    where: whereLicensedSlice,
    distinct: ["organizationName"],
    select: { organizationName: true },
  });

  // NULL-rate audit on critical fields
  // monthlyPremium is non-nullable in the schema; skip it.
  const fields = [
    "medicalDeductible",
    "maxOutOfPocket",
    "pcpCopay",
    "specialistCopay",
    "starRating",
  ] as const;

  const nullCounts: CountsByKey = {};
  for (const f of fields) {
    const n = await client.plan.count({
      where: { ...whereLicensedSlice, [f]: null } as any,
    });
    nullCounts[f] = n;
  }

  // sbPdfUrl coverage (Neon-only feature, expected 0 on Supabase)
  let sbPdfRows = 0;
  try {
    sbPdfRows = await (client as any).planCounty.count({
      where: { sbPdfUrl: { not: null } as any },
    });
  } catch {
    // column may not exist on Supabase — that's fine
  }

  return {
    label,
    total,
    byCategory: Object.fromEntries(
      byCategory.map((r) => [String(r.planCategory ?? "NULL"), r._count._all]),
    ) as CountsByKey,
    byMedicaidLevel: Object.fromEntries(
      byMedicaidLevel.map((r) => [
        String(r.medicaidLevel ?? "NULL"),
        r._count._all,
      ]),
    ) as CountsByKey,
    distinctCarriers: carrierRows.length,
    carriers: carrierRows.map((r) => r.organizationName).sort(),
    nullCounts,
    sbPdfRows,
  };
}

function diffTable(
  title: string,
  a: CountsByKey,
  b: CountsByKey,
  labelA: string,
  labelB: string,
) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  console.log(`\n--- ${title} ---`);
  console.log(`${"key".padEnd(20)} ${labelA.padStart(10)} ${labelB.padStart(10)}  delta`);
  for (const k of Array.from(keys).sort()) {
    const av = a[k] ?? 0;
    const bv = b[k] ?? 0;
    const delta = av - bv;
    console.log(
      `${k.padEnd(20)} ${String(av).padStart(10)} ${String(bv).padStart(10)}  ${delta > 0 ? "+" : ""}${delta}`,
    );
  }
}

(async () => {
  const [n, s] = await Promise.all([
    snapshot("NEON", neon),
    snapshot("SUPA", supa),
  ]);

  console.log(`\n=== PARITY REPORT (year=${PLAN_YEAR}, ${LICENSED_STATES.length} licensed states) ===`);
  console.log(`Note: ${LICENSED_CARRIERS_HINT}`);
  console.log(`\nTotal plans in licensed slice:`);
  console.log(`  NEON: ${n.total}`);
  console.log(`  SUPA: ${s.total}`);
  console.log(`  delta: ${n.total - s.total}`);

  diffTable("planCategory distribution", n.byCategory, s.byCategory, "NEON", "SUPA");
  diffTable("medicaidLevel distribution (DSNP only)", n.byMedicaidLevel, s.byMedicaidLevel, "NEON", "SUPA");
  diffTable("NULL counts on critical fields", n.nullCounts, s.nullCounts, "NEON", "SUPA");

  console.log(`\n--- Distinct carriers ---`);
  console.log(`  NEON (${n.distinctCarriers}): ${n.carriers.join(", ")}`);
  console.log(`  SUPA (${s.distinctCarriers}): ${s.carriers.join(", ")}`);
  const onlyNeon = n.carriers.filter((c) => !s.carriers.includes(c));
  const onlySupa = s.carriers.filter((c) => !n.carriers.includes(c));
  if (onlyNeon.length) console.log(`  only in NEON: ${onlyNeon.join(", ")}`);
  if (onlySupa.length) console.log(`  only in SUPA: ${onlySupa.join(", ")}`);

  console.log(`\n--- sbPdfUrl coverage (Neon feature) ---`);
  console.log(`  NEON planCounty rows w/ sbPdfUrl: ${n.sbPdfRows}`);
  console.log(`  SUPA planCounty rows w/ sbPdfUrl: ${s.sbPdfRows} (expected 0)`);

  // Gate
  const gateFailures: string[] = [];

  // a) No SNP category on Neon = FAIL (the original 5/14 bug)
  if ((n.byCategory["DSNP"] ?? 0) === 0) gateFailures.push("Neon has 0 DSNP plans");
  if ((n.byCategory["CSNP"] ?? 0) === 0) gateFailures.push("Neon has 0 CSNP plans");

  // b) medicaidLevel must be populated for >50% of Neon DSNPs
  const neonDsnpTotal = n.byCategory["DSNP"] ?? 0;
  const neonDsnpNullLevel = n.byMedicaidLevel["NULL"] ?? 0;
  if (neonDsnpTotal > 0 && neonDsnpNullLevel / neonDsnpTotal > 0.5) {
    gateFailures.push(
      `Neon medicaidLevel NULL on ${neonDsnpNullLevel}/${neonDsnpTotal} DSNPs (>50%)`,
    );
  }

  // c) NULL rate on pcpCopay/specialistCopay must be within 10pp of Supabase
  for (const f of ["pcpCopay", "specialistCopay"]) {
    const neonRate = n.total ? n.nullCounts[f] / n.total : 0;
    const supaRate = s.total ? s.nullCounts[f] / s.total : 0;
    if (neonRate - supaRate > 0.1) {
      gateFailures.push(
        `${f} NULL rate on Neon (${(neonRate * 100).toFixed(1)}%) > Supabase (${(supaRate * 100).toFixed(1)}%) by >10pp`,
      );
    }
  }

  // d) Carrier set must be identical (licensed allowlist enforced)
  if (onlyNeon.length || onlySupa.length) {
    gateFailures.push("Carrier sets differ — gate enforcement mismatch");
  }

  console.log(`\n=== GATE ===`);
  if (gateFailures.length === 0) {
    console.log("PASS — safe to proceed to preview deploy.");
    process.exit(0);
  } else {
    console.log("FAIL:");
    for (const f of gateFailures) console.log(`  - ${f}`);
    console.log("\nFix the failures above before swapping prod.");
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
