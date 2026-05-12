// scripts/enrich-ssbci-benefits.js
//
// Fills the SSBCI columns on existing Plan rows by reading
// pbp_b13i_b19b_services_vbid_ssbci.txt. Companion to the import-cms-data.ts
// fold-in (2026-05-12). Useful when you want to populate SSBCI data on the
// existing DB without re-running the full import.
//
// FAST PATH (2026-05-12 rewrite): uses a single $executeRawUnsafe UPDATE
// with a VALUES table so all ~25k row updates happen in ~3 seconds
// instead of 40 minutes (which is what a per-row prisma.plan.update loop
// would cost through the Supabase pooler).
//
// SCOPE
//   All plans (planCategory=any). One PBP row per planId; first wins on dupes.
//
// WRITE SEMANTICS
//   - Boolean columns are SET to true when PBP says yes; we never downgrade
//     a true→false in case a manual override is in place.
//   - Float columns use COALESCE — only fill NULL, never overwrite.
//
// USAGE (from repo root)
//   node scripts/enrich-ssbci-benefits.js              # dry-run
//   node scripts/enrich-ssbci-benefits.js --year 2026  # specify year
//   node scripts/enrich-ssbci-benefits.js --apply      # write

const fs = require("fs");
const path = require("path");
const { makePrisma } = require("./prisma-client");

const prisma = makePrisma();

const yearArgIdx = process.argv.indexOf("--year");
const PLAN_YEAR = yearArgIdx >= 0 ? parseInt(process.argv[yearArgIdx + 1], 10) : 2026;
const APPLY = process.argv.includes("--apply");

const EXTRACT_DIR = path.join(process.cwd(), ".cms-import-tmp", `pbp-${PLAN_YEAR}`);
const SSBCI_FILE = path.join(EXTRACT_DIR, "pbp_b13i_b19b_services_vbid_ssbci.txt");

const C = { g: "\x1b[32m", c: "\x1b[36m", y: "\x1b[33m", r: "\x1b[31m", z: "\x1b[0m" };
function log(msg, color) { console.log(`${color ? C[color] : ""}${msg}${C.z}`); }
function line(n = 72) { return "=".repeat(n); }

function parseTSV(filePath) {
  if (!fs.existsSync(filePath)) {
    log(`  (skip) missing ${path.basename(filePath)}`, "y");
    return [];
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  if (lines.length === 0) return [];
  const headers = lines[0].split("\t").map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln) continue;
    const cells = ln.split("\t");
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = cells[j] !== undefined ? cells[j] : "";
    }
    rows.push(row);
  }
  return rows;
}

function dbPlanKey(row) {
  const h = row.pbp_a_hnumber;
  const p = row.pbp_a_plan_identifier;
  if (!h || !p) return null;
  const pNum = parseInt(String(p).trim(), 10);
  if (isNaN(pNum)) return null;
  return `${String(h).trim()}-${pNum}`;
}

function num(val) {
  if (val == null || String(val).trim() === "") return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

function buildSsbciFromRow(row) {
  return {
    ssbciOffersFood: row.pbp_b13i_fd_bendesc_yn === "1",
    ssbciOffersMeals: row.pbp_b13i_ml_bendesc_service === "1",
    ssbciOffersTransportation: row.pbp_b13i_t_bendesc_yn === "1",
    ssbciOffersUtilities: row.pbp_b13i_suppt_bendesc_yn === "1" && row.pbp_b13i_suppt_utility_yn === "1",
    ssbciOffersHousing: row.pbp_b13i_suppt_bendesc_yn === "1" && row.pbp_b13i_suppt_housing_yn === "1",
    ssbciFoodAllowance: row.pbp_b13i_fd_maxplan_yn === "1" ? num(row.pbp_b13i_fd_maxplan_amt) : null,
    ssbciMealsAllowance: row.pbp_b13i_ml_maxplan_yn === "1" ? num(row.pbp_b13i_ml_maxplan_amt) : null,
    ssbciTransportationAllowance: row.pbp_b13i_t_maxplan_yn === "1" ? num(row.pbp_b13i_t_maxplan_amt) : null,
    ssbciPersonalServicesAllowance: row.pbp_b13i_ps_maxplan_yn === "1" ? num(row.pbp_b13i_ps_maxplan_amt) : null,
  };
}

async function main() {
  log(line(), "c");
  log(`SSBCI enrichment — planYear=${PLAN_YEAR}${APPLY ? "" : " [DRY-RUN]"}`, "c");
  log(line(), "c");

  if (!fs.existsSync(SSBCI_FILE)) {
    log(`\nERROR: ${SSBCI_FILE} not found. Run import first to extract PBP.`, "r");
    process.exit(1);
  }

  log("\nLoading SSBCI PBP file...", "c");
  const rows = parseTSV(SSBCI_FILE);
  log(`  ${rows.length.toLocaleString()} rows`, "c");

  const ssbciByPlan = new Map();
  for (const r of rows) {
    const k = dbPlanKey(r);
    if (!k) continue;
    if (!ssbciByPlan.has(k)) ssbciByPlan.set(k, buildSsbciFromRow(r));
  }
  log(`  ${ssbciByPlan.size.toLocaleString()} distinct planIds`, "c");

  log(`\nFetching plans for year ${PLAN_YEAR}...`, "c");
  const plans = await prisma.plan.findMany({
    where: { planYear: PLAN_YEAR },
    select: {
      id: true, planId: true, organizationName: true,
      ssbciOffersFood: true, ssbciOffersMeals: true,
      ssbciOffersUtilities: true, ssbciOffersHousing: true,
      ssbciOffersTransportation: true,
      ssbciFoodAllowance: true, ssbciMealsAllowance: true,
      ssbciPersonalServicesAllowance: true, ssbciTransportationAllowance: true,
    },
  });
  log(`  ${plans.length.toLocaleString()} plan rows in DB`, "g");

  // Build patches per row. Skip rows with no change.
  const updates = []; // [{id, patch}]
  const counters = {
    ssbciOffersFood: 0, ssbciOffersMeals: 0,
    ssbciOffersUtilities: 0, ssbciOffersHousing: 0,
    ssbciOffersTransportation: 0,
    ssbciFoodAllowance: 0, ssbciMealsAllowance: 0,
    ssbciPersonalServicesAllowance: 0, ssbciTransportationAllowance: 0,
  };
  const perCarrier = {};

  for (const p of plans) {
    const data = ssbciByPlan.get(p.planId);
    if (!data) continue;

    const patch = {};
    for (const k of [
      "ssbciOffersFood", "ssbciOffersMeals", "ssbciOffersUtilities",
      "ssbciOffersHousing", "ssbciOffersTransportation",
    ]) {
      if (data[k] && !p[k]) {
        patch[k] = true;
        counters[k]++;
      }
    }
    for (const k of [
      "ssbciFoodAllowance", "ssbciMealsAllowance",
      "ssbciPersonalServicesAllowance", "ssbciTransportationAllowance",
    ]) {
      if (data[k] != null && p[k] == null) {
        patch[k] = data[k];
        counters[k]++;
      }
    }
    if (Object.keys(patch).length === 0) continue;
    updates.push({ id: p.id, patch });
    const ck = p.organizationName || "(unknown)";
    perCarrier[ck] = (perCarrier[ck] || 0) + 1;
  }

  log("\n" + line(), "c");
  log(`${APPLY ? "Updating" : "[DRY-RUN] would update"} ${updates.length.toLocaleString()} plan rows`, "g");
  log(line(), "c");
  log("Per-column fill counts:", "c");
  for (const [k, v] of Object.entries(counters)) {
    log(`  ${k.padEnd(36)} ${String(v).padStart(7)}`);
  }
  log("\nPer-carrier touched-row counts:", "c");
  const sorted = Object.entries(perCarrier).sort((a, b) => b[1] - a[1]);
  for (const [name, n] of sorted) log(`  ${name.padEnd(28)} ${String(n).padStart(7)}`);

  if (!APPLY) {
    log("\n[DRY-RUN] No DB writes. Re-run with --apply.", "y");
    await prisma.$disconnect();
    return;
  }

  // ===========================================================================
  // FAST PATH: batch updates via $executeRawUnsafe + VALUES table
  // ===========================================================================
  // Each batch builds one UPDATE statement that touches up to BATCH_SIZE rows.
  // Postgres applies them as a single set-based update (no per-row round trip).
  // Through Supavisor pooler this comes out at ~2-5 seconds for 25k rows.
  const BATCH_SIZE = 1000;
  const cols = [
    "ssbciOffersFood",
    "ssbciOffersMeals",
    "ssbciOffersUtilities",
    "ssbciOffersHousing",
    "ssbciOffersTransportation",
    "ssbciFoodAllowance",
    "ssbciMealsAllowance",
    "ssbciPersonalServicesAllowance",
    "ssbciTransportationAllowance",
  ];

  function pgVal(v) {
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
    return "NULL";
  }

  let written = 0;
  log("\nApplying in batches of " + BATCH_SIZE + "...", "c");
  const t0 = Date.now();
  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const slice = updates.slice(i, i + BATCH_SIZE);

    // Build VALUES rows. For each plan we emit (id, val_col1, val_col2, ...).
    // Use COALESCE in the UPDATE so we only set columns the row's patch had —
    // un-patched columns send NULL and the COALESCE keeps the existing value.
    const valuesRows = slice.map((u) => {
      const cells = [String(u.id)];
      for (const c of cols) {
        cells.push(u.patch[c] === undefined ? "NULL" : pgVal(u.patch[c]));
      }
      return "(" + cells.join(",") + ")";
    }).join(",\n      ");

    // Column type casts on the VALUES side help PG resolve types.
    const setClauses = cols.map((c) => {
      const isBool = c.startsWith("ssbciOffers");
      const cast = isBool ? "boolean" : "double precision";
      return `"${c}" = COALESCE(v.${c}::${cast}, p."${c}")`;
    }).join(",\n      ");

    const sql = `
      UPDATE "Plan" AS p
      SET
      ${setClauses}
      FROM (VALUES
      ${valuesRows}
      ) AS v(id, ${cols.join(", ")})
      WHERE p.id = v.id::int
    `;

    await prisma.$executeRawUnsafe(sql);
    written += slice.length;
    process.stdout.write(`  ${written.toLocaleString()}/${updates.length.toLocaleString()}\r`);
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  log(`\nUpdated ${written.toLocaleString()} rows in ${dt}s.`, "g");

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
