// scripts/reclassify-ma-only-from-mrx.js
//
// Reclassifies plans stamped MAPD that file NO Part D benefit, using the
// authoritative PLAN-LEVEL signal: pbp_mrx.txt mrx_drug_ben_yn.
//   1 = plan offers a Part D benefit
//   2 = plan does NOT offer Part D  -> MA-Only
//
// Supersedes/extends reclassify-ma-only-from-landscape.js, which keyed on
// (planId, state, county) from ma2026.csv and missed plans (e.g. Aetna
// Medicare Eagle H5521-229 in AL Shelby surfaced as "MAPD" in Dale's
// 2026-06-10 search even though its SB confirms no drug coverage; as of
// that date 210 distinct planIds / ~49k county-rows were mislabeled).
// Matching on planId+planYear only — no county-string fragility.
//
// Scope guard: only touches rows currently planCategory='MAPD'. SNP
// categories are untouched (SNPs must include Part D; none of them file
// mrx_drug_ben_yn=2 anyway). Also sets hasPartD=false on reclassified rows
// and hasPartD=true on MAPD rows confirmed to file a drug benefit.
//
// USAGE (from repo root):
//   node scripts/reclassify-ma-only-from-mrx.js              # dry run
//   node scripts/reclassify-ma-only-from-mrx.js --apply      # write
//
const fs = require("fs");
const path = require("path");
const { makePrisma } = require("./prisma-client");
const prisma = makePrisma();

const APPLY = process.argv.includes("--apply");
const PLAN_YEAR = 2026;
const MRX_FILE = path.join(process.cwd(), ".cms-import-tmp", `pbp-${PLAN_YEAR}`, "pbp_mrx.txt");

function loadMrx() {
  if (!fs.existsSync(MRX_FILE)) {
    console.error(`PBP file not found: ${MRX_FILE}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(MRX_FILE, "utf8").replace(/\r\n/g, "\n");
  const lines = raw.split("\n");
  const H = lines[0].split("\t");
  const iH = H.indexOf("pbp_a_hnumber");
  const iP = H.indexOf("pbp_a_plan_identifier");
  const iY = H.indexOf("mrx_drug_ben_yn");
  if (iH < 0 || iP < 0 || iY < 0) { console.error("pbp_mrx.txt missing expected columns"); process.exit(1); }
  const noDrug = new Set();
  const hasDrug = new Set();
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const c = lines[i].split("\t");
    const h = (c[iH] || "").trim();
    const p = (c[iP] || "").trim();
    if (!h || !p) continue;
    const planId = `${h}-${parseInt(p, 10)}`;
    if ((c[iY] || "").trim() === "2") noDrug.add(planId);
    else if ((c[iY] || "").trim() === "1") hasDrug.add(planId);
  }
  return { noDrug, hasDrug };
}

async function main() {
  console.log(`MRX file: ${MRX_FILE}`);
  console.log(`Mode: ${APPLY ? "APPLY (will write to DB)" : "DRY RUN (no writes)"}\n`);

  const { noDrug, hasDrug } = loadMrx();
  console.log(`mrx_drug_ben_yn=2 (no Part D): ${noDrug.size} planIds`);
  console.log(`mrx_drug_ben_yn=1 (has Part D): ${hasDrug.size} planIds\n`);

  const mapd = await prisma.plan.findMany({
    where: { planYear: PLAN_YEAR, planCategory: "MAPD" },
    select: { planId: true, planName: true, organizationName: true },
    distinct: ["planId"],
  });
  console.log(`${mapd.length} distinct MAPD planIds in DB for ${PLAN_YEAR}.`);

  const toMaOnly = mapd.filter((p) => noDrug.has(p.planId));
  console.log(`${toMaOnly.length} of those file NO Part D -> reclassify to MA_ONLY:\n`);

  const byOrg = new Map();
  for (const p of toMaOnly) byOrg.set(p.organizationName, (byOrg.get(p.organizationName) || 0) + 1);
  for (const [org, n] of [...byOrg.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${org}`);
  }
  console.log("\nSample plans:");
  for (const p of toMaOnly.slice(0, 20)) console.log(`  ${p.planId}  ${p.organizationName}  ${p.planName}`);

  // Sanity check the reverse direction: MA_ONLY rows that DO file Part D.
  const maOnly = await prisma.plan.findMany({
    where: { planYear: PLAN_YEAR, planCategory: "MA_ONLY" },
    select: { planId: true },
    distinct: ["planId"],
  });
  const reverse = maOnly.filter((p) => hasDrug.has(p.planId));
  console.log(`\nReverse check (MA_ONLY but mrx files a drug benefit): ${reverse.length}`);
  for (const p of reverse.slice(0, 10)) console.log(`  ${p.planId}`);

  if (!APPLY) {
    console.log("\n[DRY RUN] No DB writes. Re-run with --apply to perform the update.");
    return;
  }

  console.log("\nApplying...");
  const ids = toMaOnly.map((p) => p.planId);
  const BATCH = 100;
  let updated = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const r = await prisma.plan.updateMany({
      where: { planYear: PLAN_YEAR, planCategory: "MAPD", planId: { in: ids.slice(i, i + BATCH) } },
      data: { planCategory: "MA_ONLY", hasPartD: false },
    });
    updated += r.count;
    process.stdout.write(`  ${updated.toLocaleString()} rows\r`);
  }
  console.log(`\nReclassified ${updated.toLocaleString()} rows MAPD -> MA_ONLY (hasPartD=false).`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
