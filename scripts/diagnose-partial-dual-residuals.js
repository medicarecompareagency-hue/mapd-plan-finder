// scripts/diagnose-partial-dual-residuals.js
//
// READ-ONLY diagnostic. Inspects PBP files to figure out WHY non-FULL_DUAL
// DSNP plans have NULL cost-share fields, so we can decide on a fix path.
//
// For each NULL field on a non-FULL_DUAL DSNP plan, classifies the
// underlying PBP filing into one of these buckets:
//
//   COINS_FILED     - copay_yn=2 (no flat copay) AND coins_yn=1 (coinsurance
//                     applies). Recoverable: extend enrichment to write
//                     coinsurance percentage to a string field.
//   ZERO_FILED      - copay_yn=2 AND coins_yn≠1. Means $0 cost-share. The
//                     original enrichment SHOULD have written 0 here. If we
//                     see these, the enrichment had a bug or was never run.
//   GENUINE_GAP     - copay_yn is neither 1 nor 2 (blank / "N/A" code).
//                     CMS data gap. Carrier didn't file. Display "Contact
//                     Plan" or "—".
//   NO_PBP_MATCH    - No PBP row found for this planId. Likely a planId
//                     normalization issue.
//
// Usage (from repo root):
//   node scripts/diagnose-partial-dual-residuals.js
//   node scripts/diagnose-partial-dual-residuals.js --year 2026
//   node scripts/diagnose-partial-dual-residuals.js --plan H3239-2  # focus mode

const fs = require("fs");
const path = require("path");
const { makePrisma } = require("./prisma-client");

const prisma = makePrisma();

const yearArgIdx = process.argv.indexOf("--year");
const PLAN_YEAR = yearArgIdx >= 0 ? parseInt(process.argv[yearArgIdx + 1], 10) : 2026;
const planArgIdx = process.argv.indexOf("--plan");
const FOCUS_PLAN = planArgIdx >= 0 ? process.argv[planArgIdx + 1] : null;

const EXTRACT_DIR = path.join(process.cwd(), ".cms-import-tmp", `pbp-${PLAN_YEAR}`);

const C = { g: "\x1b[32m", c: "\x1b[36m", y: "\x1b[33m", r: "\x1b[31m", m: "\x1b[35m", z: "\x1b[0m" };
function log(msg, color) {
  const pfx = color ? C[color] || "" : "";
  console.log(`${pfx}${msg}${C.z}`);
}
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

// Service definitions: which file + which yn fields + which coinsurance
// amount field to read if coins_yn=1.
const SERVICES = [
  {
    dbField: "pcpCopay",
    file: "pbp_b7_health_prof.txt",
    copayYn: "pbp_b7a_copay_yn",
    coinsYn: "pbp_b7a_coins_yn",
    coinsAmt: ["pbp_b7a_coins_pct_min", "pbp_b7a_coins_pct_max", "pbp_b7a_coins_amt"],
  },
  {
    dbField: "specialistCopay",
    file: "pbp_b7_health_prof.txt",
    copayYn: "pbp_b7b_copay_yn",
    coinsYn: "pbp_b7b_coins_yn",
    coinsAmt: ["pbp_b7b_coins_pct_min", "pbp_b7b_coins_pct_max", "pbp_b7b_coins_amt"],
  },
  {
    dbField: "emergencyRoomCopay",
    file: "pbp_b4_emerg_urgent.txt",
    copayYn: "pbp_b4a_copay_yn",
    coinsYn: "pbp_b4a_coins_yn",
    coinsAmt: ["pbp_b4a_coins_pct_min", "pbp_b4a_coins_pct_max"],
  },
  {
    dbField: "ambulanceCopay",
    file: "pbp_b10_amb_trans.txt",
    copayYn: "pbp_b10a_copay_yn",
    coinsYn: "pbp_b10a_coins_yn",
    coinsAmt: ["pbp_b10a_coins_pct_min", "pbp_b10a_coins_pct_max"],
  },
  {
    dbField: "outpatientHospitalCopay",
    file: "pbp_b9_outpat_hosp.txt",
    copayYn: "pbp_b9a_copay_yn",
    coinsYn: "pbp_b9a_coins_yn",
    coinsAmt: ["pbp_b9a_coins_pct_min", "pbp_b9a_coins_pct_max"],
  },
  {
    dbField: "mriCopay",
    file: "pbp_b8_clin_diag_ther.txt",
    copayYn: "pbp_b8a_copay_yn",
    coinsYn: "pbp_b8a_coins_yn",
    coinsAmt: ["pbp_b8a_coins_pct_min", "pbp_b8a_coins_pct_max"],
  },
  {
    dbField: "catScanCopay",
    file: "pbp_b8_clin_diag_ther.txt",
    copayYn: "pbp_b8a_copay_yn",
    coinsYn: "pbp_b8a_coins_yn",
    coinsAmt: ["pbp_b8a_coins_pct_min", "pbp_b8a_coins_pct_max"],
  },
];

const FIELDS = SERVICES.map((s) => s.dbField);

function classify(row, svc) {
  if (!row) return { bucket: "NO_PBP_MATCH", note: "" };
  const cy = row[svc.copayYn];
  const ny = row[svc.coinsYn];
  if (cy === "1") return { bucket: "COPAY_FILED", note: "(should already have value)" };
  if (cy === "2" && ny === "1") {
    // Look for coinsurance amount.
    let amt = null;
    for (const f of svc.coinsAmt) {
      const v = row[f];
      if (v !== undefined && v !== null && String(v).trim() !== "") {
        amt = String(v).trim();
        break;
      }
    }
    return { bucket: "COINS_FILED", note: amt ? `${amt}%` : "(rate column blank)" };
  }
  if (cy === "2" && ny !== "1") return { bucket: "ZERO_FILED", note: "" };
  return { bucket: "GENUINE_GAP", note: cy ? `copay_yn=${cy}` : "(blank)" };
}

async function main() {
  log(line(), "c");
  log(`Partial-dual DSNP residual NULL diagnostic — planYear=${PLAN_YEAR}`, "c");
  log(line(), "c");

  if (!fs.existsSync(EXTRACT_DIR)) {
    log(`\nERROR: PBP extract dir not found at ${EXTRACT_DIR}`, "r");
    log(`Run this first: npx tsx scripts/prepare-pbp.ts ${PLAN_YEAR}`, "y");
    process.exit(1);
  }

  // Load all PBP rows we care about, keyed by planId+file.
  log("\nLoading PBP files...", "c");
  const filesNeeded = [...new Set(SERVICES.map((s) => s.file))];
  const pbpByFile = {};
  for (const f of filesNeeded) {
    log(`  ${f} ...`);
    const rows = parseTSV(path.join(EXTRACT_DIR, f));
    const map = new Map();
    for (const r of rows) {
      const k = dbPlanKey(r);
      if (!k) continue;
      // First segment wins (matches enrichment behavior).
      if (!map.has(k)) map.set(k, r);
    }
    pbpByFile[f] = map;
  }

  // Pull DB residuals: non-FULL_DUAL DSNP plans with at least one NULL in
  // the target fields.
  const nullClause = FIELDS.map((f) => `"${f}" IS NULL`).join(" OR ");
  let plans;
  if (FOCUS_PLAN) {
    log(`\n[FOCUS MODE] Inspecting plan ${FOCUS_PLAN} only...`, "m");
    plans = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT "planId", "organizationName", "dsnpTargetGroup", "planName"
       FROM "Plan"
       WHERE "planYear" = $1
         AND "planCategory" = 'DSNP'
         AND "planId" = $2`,
      PLAN_YEAR,
      FOCUS_PLAN,
    );
  } else {
    plans = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT "planId", "organizationName", "dsnpTargetGroup", "planName"
       FROM "Plan"
       WHERE "planYear" = $1
         AND "planCategory" = 'DSNP'
         AND ("dsnpTargetGroup" IS NULL OR "dsnpTargetGroup" != 'FULL_DUAL')
         AND (${nullClause})`,
      PLAN_YEAR,
    );
  }
  log(`\n${plans.length.toLocaleString()} distinct non-FULL_DUAL DSNP planIds with at least one residual NULL`, "g");

  // Per-field, per-bucket counts.
  const counts = {};
  for (const f of FIELDS) counts[f] = { COPAY_FILED: 0, COINS_FILED: 0, ZERO_FILED: 0, GENUINE_GAP: 0, NO_PBP_MATCH: 0, _hadValue: 0 };

  // Per-carrier breakdown.
  const byCarrier = {};

  // For focus mode or first 5 plans, capture per-plan detail.
  const detailedSamples = [];

  for (const p of plans) {
    const planNullFields = [];
    // Check current DB state for each field.
    const dbRow = await prisma.plan.findFirst({
      where: { planId: p.planId, planYear: PLAN_YEAR },
      select: Object.fromEntries(FIELDS.map((f) => [f, true])),
    });
    if (!dbRow) continue;

    const planDetail = { planId: p.planId, carrier: p.organizationName, target: p.dsnpTargetGroup, name: p.planName, fields: {} };

    for (const svc of SERVICES) {
      const fieldVal = dbRow[svc.dbField];
      if (fieldVal !== null && fieldVal !== undefined) {
        counts[svc.dbField]._hadValue++;
        planDetail.fields[svc.dbField] = `(has $${fieldVal})`;
        continue;
      }
      // NULL — diagnose.
      const pbpRow = pbpByFile[svc.file]?.get(p.planId);
      const { bucket, note } = classify(pbpRow, svc);
      counts[svc.dbField][bucket]++;
      planDetail.fields[svc.dbField] = `${bucket}${note ? " " + note : ""}`;

      // Carrier rollup keyed by carrier+bucket.
      const ck = p.organizationName || "(unknown)";
      if (!byCarrier[ck]) byCarrier[ck] = { COPAY_FILED: 0, COINS_FILED: 0, ZERO_FILED: 0, GENUINE_GAP: 0, NO_PBP_MATCH: 0 };
      byCarrier[ck][bucket]++;
    }

    if (FOCUS_PLAN || detailedSamples.length < 5) {
      detailedSamples.push(planDetail);
    }
  }

  // === Output ===

  log("\n" + line(), "c");
  log("Per-field bucket counts (cells, not plans):", "c");
  log(line(), "c");
  log(`  ${"FIELD".padEnd(28)} ${"hadValue".padStart(8)} ${"COINS".padStart(7)} ${"ZERO".padStart(6)} ${"GAP".padStart(6)} ${"NOMATCH".padStart(8)}`);
  for (const f of FIELDS) {
    const c = counts[f];
    log(`  ${f.padEnd(28)} ${String(c._hadValue).padStart(8)} ${String(c.COINS_FILED).padStart(7)} ${String(c.ZERO_FILED).padStart(6)} ${String(c.GENUINE_GAP).padStart(6)} ${String(c.NO_PBP_MATCH).padStart(8)}`);
  }

  log("\n" + line(), "c");
  log("Per-carrier rollup (cells across all 7 fields):", "c");
  log(line(), "c");
  const carrierEntries = Object.entries(byCarrier).sort((a, b) => {
    const sumA = Object.values(a[1]).reduce((s, n) => s + n, 0);
    const sumB = Object.values(b[1]).reduce((s, n) => s + n, 0);
    return sumB - sumA;
  });
  log(`  ${"CARRIER".padEnd(28)} ${"COINS".padStart(7)} ${"ZERO".padStart(6)} ${"GAP".padStart(6)} ${"NOMATCH".padStart(8)}`);
  for (const [name, c] of carrierEntries) {
    log(`  ${name.substring(0, 28).padEnd(28)} ${String(c.COINS_FILED).padStart(7)} ${String(c.ZERO_FILED).padStart(6)} ${String(c.GENUINE_GAP).padStart(6)} ${String(c.NO_PBP_MATCH).padStart(8)}`);
  }

  log("\n" + line(), "c");
  log(FOCUS_PLAN ? `Detail for ${FOCUS_PLAN}:` : "Sample detail (first 5 plans):", "c");
  log(line(), "c");
  for (const d of detailedSamples) {
    log(`\n  ${d.planId}  [${d.target || "(target=null)"}]  ${d.carrier}  ${d.name || ""}`, "g");
    for (const f of FIELDS) {
      log(`    ${f.padEnd(28)} ${d.fields[f] || "(missing)"}`);
    }
  }

  log("\n" + line(), "c");
  log("Bucket meanings:", "c");
  log("  COINS  = coinsurance filed; recoverable by extending enrichment");
  log("  ZERO   = filed as $0 (carrier docs say '$0 cost'); enrichment bug — backfillable with confidence");
  log("  GAP    = neither copay nor coinsurance filed; true data gap, display 'Contact Plan'");
  log("  NOMATCH= no PBP row found for planId; likely planId normalization issue");

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
