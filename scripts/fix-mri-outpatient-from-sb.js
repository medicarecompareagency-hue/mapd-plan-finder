// scripts/fix-mri-outpatient-from-sb.js
// Applies the SB-verified outpatient-hospital-rule fixes for mriCopay/catScanCopay
// (Dale's 2026-07-06 law: when an SB lists advanced-imaging copays by place of
// service, always use the OUTPATIENT HOSPITAL amount; a flat SB copay with no
// per-setting split is used as-is). Source of truth:
//   scripts/data/mri-outpatient-fixes-2026-07.json (produced by
//   scripts/extract-mri-outpatient.py --finalize)
//
//   node scripts/fix-mri-outpatient-from-sb.js            # dry-run
//   node scripts/fix-mri-outpatient-from-sb.js --apply    # write
//
const fs = require("fs");
const { makePrisma } = require("./prisma-client");
const prisma = makePrisma();

const APPLY = process.argv.includes("--apply");
const DATA_PATH = "scripts/data/mri-outpatient-fixes-2026-07.json";
const PLAN_YEAR = 2026;

async function main() {
  if (!fs.existsSync(DATA_PATH)) {
    console.log(`${DATA_PATH} missing — skip fix-mri-outpatient-from-sb`);
    return;
  }
  const { fixes } = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  console.log(`${fixes.length} SB-verified fixes loaded. ${APPLY ? "APPLY" : "DRY-RUN"}.`);

  let toApply = 0, alreadyAtTarget = 0, rowsUpdated = 0;
  const samples = [];

  for (const f of fixes) {
    if (f.newMri == null) continue; // shouldn't happen (only "ok" entries have newMri), defensive
    if (f.oldMri === f.newMri) { alreadyAtTarget++; continue; }
    toApply++;
    samples.push(`${f.planId} (${f.organizationName}): ${f.oldMri} -> ${f.newMri} [${f.source}]`);
    if (APPLY) {
      const res = await prisma.plan.updateMany({
        where: { planId: f.planId, planYear: PLAN_YEAR, mriCopay: f.oldMri },
        data: { mriCopay: f.newMri, catScanCopay: f.newMri, mriCoinsPct: null, catScanCoinsPct: null },
      });
      rowsUpdated += res.count;
    }
  }

  console.log(`\nAlready at target (no-op): ${alreadyAtTarget}`);
  console.log(`To ${APPLY ? "apply" : "would apply"}: ${toApply} plans`);
  for (const s of samples.slice(0, 30)) console.log(`  ${s}`);
  if (samples.length > 30) console.log(`  ... and ${samples.length - 30} more`);
  if (APPLY) console.log(`\nRows updated: ${rowsUpdated}`);

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
