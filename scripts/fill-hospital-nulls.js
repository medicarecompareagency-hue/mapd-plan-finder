// scripts/fill-hospital-nulls.js
//
// Fills hospitalStayCopay ONLY where it is currently NULL, from PBP b1a inpatient.
// Handles BOTH interval structure ("$X/day days A-B, ...") and flat per-stay ("$X/stay").
// Never overwrites an existing value. Catches the ~24 Devoted flat-per-stay plans the
// interval-only fix-hospital-and-moop.js missed.
//
// USAGE (from repo root):
//   node scripts/fill-hospital-nulls.js                 # dry-run
//   node scripts/fill-hospital-nulls.js --apply         # write
//   node scripts/fill-hospital-nulls.js --pbp <path>    # override PBP file path
//
const fs = require("fs");
const path = require("path");
const { makePrisma } = require("./prisma-client");
const prisma = makePrisma();

const APPLY = process.argv.includes("--apply");
const pIdx = process.argv.indexOf("--pbp");
const PLAN_YEAR = 2026;
const PBP_FILE = pIdx >= 0
  ? process.argv[pIdx + 1]
  : path.join(process.cwd(), ".cms-import-tmp", `pbp-${PLAN_YEAR}`, "pbp_b1a_inpat_hosp.txt");

function num(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (t === "") return null;
  const v = parseFloat(t.replace(/,/g, ""));
  return Number.isFinite(v) ? v : null;
}
function fmt(n) { return Number.isInteger(n) ? String(n) : String(n); }

// Build the hospitalStayCopay string for one b1a row (tier 1).
function buildHospitalString(get) {
  // 1) interval structure
  const parts = [];
  for (let i = 1; i <= 3; i++) {
    const amt = num(get(`pbp_b1a_copay_mcs_amt_int${i}_t1`));
    const bgn = (get(`pbp_b1a_copay_mcs_bgnd_int${i}_t1`) || "").trim();
    const end = (get(`pbp_b1a_copay_mcs_endd_int${i}_t1`) || "").trim();
    if (amt != null && bgn && end) parts.push(`$${fmt(amt)}/day days ${bgn}-${end}`);
  }
  if (parts.length > 0) return parts.join(", ");
  // 2) flat per-stay
  const flat = num(get("pbp_b1a_copay_mcs_amt_t1"));
  if (flat != null && flat > 0) return `$${fmt(flat)}/stay`;
  // 3) yn=1 but no amount filed
  if ((get("pbp_b1a_copay_yn") || "").trim() === "1") return "$0/day days 1-90";
  return null;
}

function loadPbp() {
  if (!fs.existsSync(PBP_FILE)) {
    console.error(`PBP file not found: ${PBP_FILE}`);
    console.error(`Point --pbp at pbp_b1a_inpat_hosp.txt (the b1a inpatient-hospital staging file).`);
    process.exit(1);
  }
  const raw = fs.readFileSync(PBP_FILE, "utf8").replace(/\r\n/g, "\n");
  const lines = raw.split("\n");
  const H = lines[0].split("\t");
  const idx = {}; H.forEach((h, i) => { idx[h] = i; });
  const cHnum = idx["pbp_a_hnumber"], cPlan = idx["pbp_a_plan_identifier"];
  if (cHnum == null || cPlan == null) throw new Error("b1a key columns missing");

  const byPlan = new Map(); // planId -> string (last non-null row wins)
  for (let i = 1; i < lines.length; i++) {
    const r = lines[i].split("\t");
    if (r.length <= cPlan) continue;
    const hnum = (r[cHnum] || "").trim();
    const pid = (r[cPlan] || "").trim();
    if (!hnum || !pid) continue;
    const planId = `${hnum}-${parseInt(pid, 10)}`;
    const s = buildHospitalString((name) => (idx[name] != null ? r[idx[name]] : undefined));
    if (s != null) byPlan.set(planId, s);
  }
  return byPlan;
}

async function main() {
  console.log(`PBP file: ${PBP_FILE}`);
  const pbp = loadPbp();
  console.log(`Built hospital strings for ${pbp.size} planIds from b1a.`);

  // only NULL hospital plans
  const dbPlans = await prisma.plan.findMany({
    where: { planYear: PLAN_YEAR, hospitalStayCopay: null },
    select: { planId: true, organizationName: true },
    distinct: ["planId"],
  });
  console.log(`${dbPlans.length} distinct DB plans with NULL hospitalStayCopay.`);

  let filled = 0, stillNull = 0, rows = 0;
  const samples = [];
  for (const p of dbPlans) {
    const s = pbp.get(p.planId);
    if (s == null) { stillNull++; continue; }
    filled++;
    if (samples.length < 30) samples.push(`${p.planId} (${p.organizationName}): ${s}`);
    if (APPLY) {
      const r = await prisma.plan.updateMany({
        where: { planId: p.planId, planYear: PLAN_YEAR, hospitalStayCopay: null },
        data: { hospitalStayCopay: s },
      });
      rows += r.count;
    }
  }

  console.log(`\nNULL plans fillable from b1a: ${filled} | still NULL (no b1a copay, likely coinsurance): ${stillNull}`);
  console.log(`\nSample fills:`);
  for (const s of samples) console.log("  " + s);
  if (APPLY) console.log(`\nRows written: ${rows}`);
  else console.log(`\nDry-run — no writes. Re-run with --apply to persist.`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
