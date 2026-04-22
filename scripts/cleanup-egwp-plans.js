// scripts/cleanup-egwp-plans.js
// One-shot: delete Plan rows that are Employer/Union-Only Group Plans (EGWP).
// CMS marks these in landscape files by appending " *" to the planType
// (e.g. "Local HMO *", "Regional PPO *", "MSA *", "Cost *", "PFFS *").
//
// These plans are NOT individually enrollable — only retirees of a specific
// employer or union can join them. Dale sells to individuals, so these are
// pure clutter.
//
// Usage (from repo root):
//   node scripts/cleanup-egwp-plans.js         # dry run (count only)
//   node scripts/cleanup-egwp-plans.js --apply # actually delete
//
// Safe to re-run: idempotent.
//
// Uses raw SQL (not Prisma queries) to avoid the Supabase transaction-pooler
// "prepared statement s0 already exists" error (Postgres 42P05).

const { makePrisma } = require("./prisma-client");

const prisma = makePrisma();

function log(msg, color) {
  const c = { green: "\x1b[32m", cyan: "\x1b[36m", yellow: "\x1b[33m", red: "\x1b[31m", reset: "\x1b[0m" };
  console.log(`${c[color] || ""}${msg}${c.reset}`);
}

const APPLY = process.argv.includes("--apply");

async function main() {
  // Preview: group EGWP vs non-EGWP plans by planType.
  // EGWP plans have a trailing " *" in planType (CMS landscape convention).
  const rows = await prisma.$queryRaw`
    SELECT "planType", COUNT(*)::int AS n
    FROM "Plan"
    GROUP BY "planType"
    ORDER BY "planType"
  `;

  let keep = 0;
  let drop = 0;
  const dropTypes = [];
  const keepTypes = [];

  for (const row of rows) {
    const n = Number(row.n);
    const isEgwp = typeof row.planType === "string" && row.planType.trim().endsWith("*");
    if (isEgwp) {
      drop += n;
      dropTypes.push(`"${row.planType}"=${n.toLocaleString()}`);
    } else {
      keep += n;
      keepTypes.push(`"${row.planType}"=${n.toLocaleString()}`);
    }
  }

  log(`\nKeep (individually enrollable): ${keep.toLocaleString()} plans`, "green");
  for (const t of keepTypes) log(`    ${t}`, "green");

  log(`\nDrop (EGWP, employer/union-only): ${drop.toLocaleString()} plans`, "yellow");
  for (const t of dropTypes) log(`    ${t}`, "yellow");

  if (!APPLY) {
    log(`\nDRY RUN. Re-run with --apply to actually delete.`, "cyan");
    return;
  }

  if (drop === 0) {
    log(`\nNothing to delete. Already clean.`, "green");
    return;
  }

  log(`\nDeleting ${drop.toLocaleString()} EGWP rows...`, "cyan");
  // Match any planType whose trimmed value ends in "*".
  // Using LIKE '% *' handles the normal CMS format ("Local HMO *").
  // Also catch any stray trailing-asterisk variants via regex on trimmed value.
  const deleted = await prisma.$executeRaw`
    DELETE FROM "Plan"
    WHERE TRIM("planType") LIKE '%*'
  `;
  log(`Deleted ${Number(deleted).toLocaleString()} rows.`, "green");

  const remaining = await prisma.$queryRaw`SELECT COUNT(*)::int AS n FROM "Plan"`;
  log(`Remaining plans in DB: ${Number(remaining[0].n).toLocaleString()}`, "green");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
