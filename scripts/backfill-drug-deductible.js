// backfill-drug-deductible.js
// Fixes drugDeductible and sets drugDeductibleTiers for all MAPD 2026 plans
// whose mrx_alt_ded_charge is "1" (standard $615) or "2" (alt amount).
//
// Root-cause: both importers previously only captured charge="2", leaving
// all charge="1" plans (standard $615) stored as $0 in the DB.
//
// Usage:
//   node scripts/backfill-drug-deductible.js           # dry-run (prints results)
//   node scripts/backfill-drug-deductible.js --apply   # writes to DB

"use strict";

const fs   = require("fs");
const path = require("path");
const { makePrisma } = require("./prisma-client");

const PLAN_YEAR  = 2026;
const PBP_MRX    = path.join(__dirname, "..", ".cms-import-tmp", "pbp-2026", "pbp_mrx.txt");
const APPLY      = process.argv.includes("--apply");

// ── Anchors ──────────────────────────────────────────────────────────────────
// Gate: abort (no writes) if any anchor fails.
const ANCHORS = [
  { planId: "H1112-44", expectAmount: 615, expectTierPrefix: 3 },
  { planId: "H2293-29", expectAmount: 615, expectTierPrefix: 3 },
  { planId: "H4141-17", expectAmount: 350, expectTierPrefix: 3 },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function num(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === "") return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// mrx_alt_no_ded_tier: 7-char bitmap, index 0 = padding, indexes 1-6 = Tiers 1-6.
// "0" = deductible applies to that tier; "1" = tier is exempt.
// Returns compact range like "3-5"; null if all tiers or no tiers have deductible.
function drugDeductibleTierLabel(bitmap, maxTier) {
  if (!bitmap || bitmap.length < 7 || !maxTier) return null;
  const cap = Math.min(6, maxTier);
  const applies = [];
  for (let t = 1; t <= cap; t++) if (bitmap[t] === "0") applies.push(t);
  if (applies.length === 0 || applies.length === cap) return null;
  const parts = [];
  let start = applies[0], prev = applies[0];
  for (let k = 1; k <= applies.length; k++) {
    const cur = applies[k];
    if (cur === prev + 1) { prev = cur; continue; }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = cur; prev = cur;
  }
  return parts.join(", ");
}

function parseTSV(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  if (lines.length === 0) return [];
  const headers = lines[0].split("\t").map(h => h.trim());
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

// DB planId format: "${hnumber}-${parseInt(plan_identifier, 10)}"
function dbPlanKey(row) {
  const h = row.pbp_a_hnumber;
  const p = row.pbp_a_plan_identifier;
  if (!h || !p) return null;
  const pNum = parseInt(String(p).trim(), 10);
  if (isNaN(pNum)) return null;
  return `${String(h).trim()}-${pNum}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== DRUG DEDUCTIBLE BACKFILL — planYear=${PLAN_YEAR} ${APPLY ? "(APPLY)" : "(DRY RUN)"} ===\n`);

  if (!fs.existsSync(PBP_MRX)) {
    console.error(`ERROR: pbp_mrx.txt not found at:\n  ${PBP_MRX}`);
    process.exit(1);
  }

  // ── Step 1: Read PBP mrx data ─────────────────────────────────────────────
  console.log(`Reading ${PBP_MRX} ...`);
  const mrxRows = parseTSV(PBP_MRX);
  console.log(`  ${mrxRows.length.toLocaleString()} rows loaded`);

  // Build map: planId → { amount, tierLabel } (first row wins per planId)
  const mrxMap = new Map();
  for (const row of mrxRows) {
    const planId = dbPlanKey(row);
    if (!planId || mrxMap.has(planId)) continue;
    const charge = (row.mrx_alt_ded_charge || "").trim();
    const amount = num(row.mrx_alt_ded_amount);
    const maxTier = num(row.mrx_formulary_tiers_num);
    const bitmap = row.mrx_alt_no_ded_tier || "";

    if (charge === "1" || charge === "2") {
      mrxMap.set(planId, {
        drugDeductible: amount ?? 0,
        drugDeductibleTiers: drugDeductibleTierLabel(bitmap, maxTier),
      });
    } else {
      // charge="3" (waived) or blank (no Part D) → $0, no tier label
      mrxMap.set(planId, { drugDeductible: 0, drugDeductibleTiers: null });
    }
  }
  console.log(`  ${mrxMap.size.toLocaleString()} unique planIds in mrx data`);

  // ── Step 2: Get current DB state for MAPD plans ───────────────────────────
  console.log("\nQuerying DB for MAPD plans ...");
  const prisma = makePrisma();

  const dbPlans = await prisma.plan.findMany({
    where: { planYear: PLAN_YEAR, planCategory: "MAPD" },
    select: {
      planId: true,
      drugDeductible: true,
      drugDeductibleTiers: true,
      drugTier1Copay: true,
      drugTier2Copay: true,
      drugTier3Copay: true,
      drugTier4Copay: true,
      drugTier5Copay: true,
      drugTier6Copay: true,
    },
    distinct: ["planId"],
  });
  console.log(`  ${dbPlans.length.toLocaleString()} distinct MAPD planIds found`);

  // ── Step 3: Compute changes ───────────────────────────────────────────────
  const changes = []; // { planId, oldAmount, newAmount, newTiers }
  let stayZero = 0;
  let noMrxData = 0;

  for (const plan of dbPlans) {
    const mrx = mrxMap.get(plan.planId);
    if (!mrx) { noMrxData++; continue; }

    const newAmount = mrx.drugDeductible;
    const newTiers  = mrx.drugDeductibleTiers;
    const oldAmount = plan.drugDeductible ?? 0;
    const oldTiers  = plan.drugDeductibleTiers;

    const amountChanged = newAmount !== oldAmount;
    const tiersChanged  = newTiers !== oldTiers;

    if (amountChanged || tiersChanged) {
      changes.push({ planId: plan.planId, oldAmount, newAmount, oldTiers, newTiers });
    } else if (newAmount === 0) {
      stayZero++;
    }
  }

  const zeroToNonzero = changes.filter(c => c.oldAmount === 0 && c.newAmount > 0);
  const nonzeroToSame = changes.filter(c => c.oldAmount > 0 || c.newAmount === 0);

  console.log(`\n── Summary ──────────────────────────────────────────────────────`);
  console.log(`  Plans $0 → non-zero (main fix):     ${zeroToNonzero.length}`);
  console.log(`  Plans getting tier label only:        ${nonzeroToSame.length}`);
  console.log(`  Plans legitimately staying $0:        ${stayZero}`);
  console.log(`  Plans not in mrx data (no change):   ${noMrxData}`);
  console.log(`  Total rows to update (unique planId): ${changes.length}`);

  // ── Step 4: ANCHOR GATE ───────────────────────────────────────────────────
  console.log(`\n── Anchor checks ────────────────────────────────────────────────`);
  let anchorFail = false;
  for (const anchor of ANCHORS) {
    const mrx = mrxMap.get(anchor.planId);
    if (!mrx) {
      console.log(`  FAIL  ${anchor.planId}: not found in mrx data`);
      anchorFail = true;
      continue;
    }
    const amtOk   = mrx.drugDeductible === anchor.expectAmount;
    const tierOk  = mrx.drugDeductibleTiers != null &&
                    mrx.drugDeductibleTiers.startsWith(String(anchor.expectTierPrefix));
    const status  = amtOk && tierOk ? "PASS" : "FAIL";
    if (!amtOk || !tierOk) anchorFail = true;
    console.log(`  ${status}  ${anchor.planId}: amount=$${mrx.drugDeductible} tiers="${mrx.drugDeductibleTiers}"`);
  }

  if (anchorFail) {
    console.error("\n  *** ANCHOR GATE FAILED — aborting, no writes made ***\n");
    await prisma.$disconnect();
    process.exit(1);
  }
  console.log("  All anchors passed.\n");

  if (!APPLY) {
    console.log("DRY RUN — pass --apply to write changes to DB.\n");
    await prisma.$disconnect();
    return;
  }

  // ── Step 5: Apply ─────────────────────────────────────────────────────────
  console.log(`Applying ${changes.length} updates ...`);
  const BATCH = 50;
  let done = 0;
  let errors = 0;

  // Group changes by (newAmount, newTiers) to batch updateMany where possible
  for (let i = 0; i < changes.length; i += BATCH) {
    const slice = changes.slice(i, i + BATCH);
    for (const ch of slice) {
      try {
        await prisma.plan.updateMany({
          where: { planId: ch.planId, planYear: PLAN_YEAR },
          data: {
            drugDeductible: ch.newAmount,
            drugDeductibleTiers: ch.newTiers,
          },
        });
        done++;
      } catch (e) {
        errors++;
        if (errors <= 5) console.error(`  error on ${ch.planId}: ${e.message}`);
      }
    }
    if ((i + BATCH) % 500 === 0 || i + BATCH >= changes.length) {
      console.log(`  ${done.toLocaleString()} / ${changes.length.toLocaleString()} done`);
    }
  }

  console.log(`\nDone. ${done} unique planIds updated, ${errors} errors.`);
  console.log(`(Each planId update touches all county-rows for that plan.)\n`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
