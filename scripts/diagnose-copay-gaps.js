// scripts/diagnose-copay-gaps.js
// Diagnose why some plans show N/A for PCP/Specialist/MRI/etc. copays.
//
// Three sections:
//   1. OVERALL:  % of plans missing each copay field
//   2. BY TYPE:  null-rate of pcpCopay broken down by planType
//   3. SAMPLE:   dump 10 plans in a specific state + planType with raw values
//
// Usage (from repo root):
//   node scripts/diagnose-copay-gaps.js                       # sections 1 + 2 only
//   node scripts/diagnose-copay-gaps.js AL "Local PPO"        # all three sections

const { makePrisma } = require("./prisma-client");
const prisma = makePrisma();

const COPAY_COLS = [
  "pcpCopay",
  "specialistCopay",
  "emergencyRoomCopay",
  "ambulanceCopay",
  "outpatientHospitalCopay",
  "mriCopay",
  "catScanCopay",
  "hospitalStayCopay",
  "skilledNursingCopay",
  "drugDeductible",
  "drugTier1Copay",
  "drugTier2Copay",
  "drugTier3Copay",
  "drugTier4Copay",
  "drugTier5Copay",
  "drugTier6Copay",
];

function line(n = 64) { return "=".repeat(n); }

async function main() {
  const [, , stateArg, planTypeArg] = process.argv;

  const totalRows = await prisma.$queryRaw`SELECT COUNT(*)::int AS n FROM "Plan"`;
  const total = Number(totalRows[0].n);

  console.log(line());
  console.log(`OVERALL: plans missing each copay field (of ${total.toLocaleString()} total)`);
  console.log(line());

  for (const col of COPAY_COLS) {
    // Some fields are numeric, some are text. IS NULL works for both.
    // Empty strings only exist on the two text fields.
    const sql = `
      SELECT COUNT(*)::int AS n
      FROM "Plan"
      WHERE "${col}" IS NULL
         OR (pg_typeof("${col}")::text = 'text' AND "${col}"::text = '')
    `;
    const rows = await prisma.$queryRawUnsafe(sql);
    const missing = Number(rows[0].n);
    const pct = total > 0 ? ((missing / total) * 100).toFixed(1) : "0.0";
    console.log(`  ${col.padEnd(26)} ${missing.toLocaleString().padStart(8)} missing (${pct.padStart(5)}%)`);
  }

  console.log("\n" + line());
  console.log("BY CONTRACT TYPE: pcpCopay null-rate (canary field)");
  console.log(line());

  const byType = await prisma.$queryRaw`
    SELECT
      "planType",
      COUNT(*)::int AS total,
      SUM(CASE WHEN "pcpCopay" IS NULL THEN 1 ELSE 0 END)::int AS pcp_null
    FROM "Plan"
    GROUP BY "planType"
    ORDER BY "planType"
  `;

  for (const r of byType) {
    const pct = r.total > 0 ? ((r.pcp_null / r.total) * 100).toFixed(0) : "0";
    console.log(
      `  ${String(r.planType).padEnd(20)} ` +
      `${String(r.pcp_null).padStart(6)}/${String(r.total).padStart(6)} null (${pct.padStart(3)}%)`
    );
  }

  if (stateArg && planTypeArg) {
    console.log("\n" + line());
    console.log(`SAMPLE: up to 15 plans where state=${stateArg} AND planType="${planTypeArg}"`);
    console.log(line());

    const sample = await prisma.$queryRawUnsafe(
      `SELECT id, state, "planType", "pcpCopay", "specialistCopay",
              "mriCopay", "catScanCopay",
              "drugTier1Copay", "drugTier5Copay",
              "monthlyPremium", "starRating"
       FROM "Plan"
       WHERE state = $1 AND "planType" = $2
       ORDER BY "monthlyPremium" NULLS LAST
       LIMIT 15`,
      stateArg,
      planTypeArg,
    );

    for (const r of sample) {
      const nullMark = (v) => (v === null || v === undefined ? "NULL" : String(v));
      console.log(
        `  id=${r.id}  prem=${nullMark(r.monthlyPremium)}  star=${nullMark(r.starRating)}`
      );
      console.log(
        `    pcp=${nullMark(r.pcpCopay)}  spec=${nullMark(r.specialistCopay)}  ` +
        `mri=${nullMark(r.mriCopay)}  cat=${nullMark(r.catScanCopay)}  ` +
        `t1=${nullMark(r.drugTier1Copay)}  t5=${nullMark(r.drugTier5Copay)}`
      );
    }

    // Also: does the organizationName / carrier column exist? If so, bucket the gaps.
    const cols = await prisma.$queryRaw`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'Plan'
        AND column_name IN ('organizationName', 'carrierName', 'contractId', 'planId')
    `;
    const colNames = cols.map((c) => c.column_name);

    if (colNames.includes("organizationName")) {
      console.log("\n" + line());
      console.log(`BY CARRIER in ${stateArg}/${planTypeArg}: pcpCopay null-rate`);
      console.log(line());

      const byCarrier = await prisma.$queryRawUnsafe(
        `SELECT "organizationName",
                COUNT(*)::int AS total,
                SUM(CASE WHEN "pcpCopay" IS NULL THEN 1 ELSE 0 END)::int AS pcp_null
         FROM "Plan"
         WHERE state = $1 AND "planType" = $2
         GROUP BY "organizationName"
         ORDER BY pcp_null DESC, total DESC
         LIMIT 30`,
        stateArg,
        planTypeArg,
      );

      for (const r of byCarrier) {
        const pct = r.total > 0 ? ((r.pcp_null / r.total) * 100).toFixed(0) : "0";
        console.log(
          `  ${String(r.organizationName).padEnd(40)} ` +
          `${String(r.pcp_null).padStart(4)}/${String(r.total).padStart(4)} null (${pct.padStart(3)}%)`
        );
      }
    }
  } else {
    console.log(
      `\n(Pass a state + planType to see per-plan samples, e.g.:\n` +
      `   node scripts/diagnose-copay-gaps.js AL "Local PPO" )`
    );
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
