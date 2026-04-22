// scripts/cleanup-nonlicensed-states.js
// One-shot: delete Plan rows whose state is NOT in LICENSED_STATES.
//
// Usage (from repo root):
//   node scripts/cleanup-nonlicensed-states.js         # dry run (count only)
//   node scripts/cleanup-nonlicensed-states.js --apply # actually delete
//
// Safe to re-run: idempotent.
//
// Uses raw SQL (not Prisma queries) to avoid the Supabase transaction-pooler
// "prepared statement s0 already exists" error (Postgres 42P05) that hits
// when pooler backend connections are reused across separate Node runs.

const { Prisma } = require("@prisma/client");
const { LICENSED_STATES } = require("./licensed-states");
const { makePrisma } = require("./prisma-client");

const prisma = makePrisma();

function log(msg, color) {
  const c = { green: "\x1b[32m", cyan: "\x1b[36m", yellow: "\x1b[33m", red: "\x1b[31m", reset: "\x1b[0m" };
  console.log(`${c[color] || ""}${msg}${c.reset}`);
}

const APPLY = process.argv.includes("--apply");

// Build a Prisma.sql array of states for IN (...) clause
function statesInClause() {
  return Prisma.join(LICENSED_STATES.map((s) => Prisma.sql`${s}`));
}

async function main() {
  log(`Licensed states (${LICENSED_STATES.length}): ${LICENSED_STATES.join(", ")}`, "cyan");

  // Preview via raw SQL (no prepared-statement collision risk)
  const rows = await prisma.$queryRaw`
    SELECT state, COUNT(*)::int AS n
    FROM "Plan"
    GROUP BY state
    ORDER BY state
  `;

  const licensedSet = new Set(LICENSED_STATES);
  let keep = 0;
  let drop = 0;
  const dropStates = [];

  for (const row of rows) {
    const n = Number(row.n);
    if (licensedSet.has(row.state)) {
      keep += n;
    } else {
      drop += n;
      dropStates.push(`${row.state}=${n}`);
    }
  }

  log(`\nKeep:  ${keep.toLocaleString()} plans across ${LICENSED_STATES.length} licensed states`, "green");
  log(`Drop:  ${drop.toLocaleString()} plans across ${dropStates.length} non-licensed states`, "yellow");
  if (dropStates.length > 0) {
    log(`  (${dropStates.join(", ")})`, "yellow");
  }

  if (!APPLY) {
    log(`\nDRY RUN. Re-run with --apply to actually delete.`, "cyan");
    return;
  }

  if (drop === 0) {
    log(`\nNothing to delete. Already clean.`, "green");
    return;
  }

  log(`\nDeleting ${drop.toLocaleString()} rows...`, "cyan");
  const deleted = await prisma.$executeRaw`
    DELETE FROM "Plan"
    WHERE state NOT IN (${statesInClause()})
  `;
  log(`Deleted ${Number(deleted).toLocaleString()} rows.`, "green");

  // Confirm remaining count
  const remaining = await prisma.$queryRaw`SELECT COUNT(*)::int AS n FROM "Plan"`;
  log(`Remaining plans in DB: ${Number(remaining[0].n).toLocaleString()}`, "green");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
