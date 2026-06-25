// scripts/reapply-sb-truth.js — re-apply every SB-derived correction after a CMS re-import (idempotent).
//
// WHY: specialist $0 (SB-vs-PBP, ranking key #4) and converting-wallet / Extra-Supports food cards
// (DSNP ranking key #1) live ONLY in the SB, not in scripts/import-cms-data.ts. A full re-import
// (e.g. 2027 AEP) re-writes specialist from PBP coinsurance and drops the SB-only wallet data.
// Each fixer below re-PROVES itself from the SB at run time (re-fetch + re-classify), is NULL-only
// or drift-guarded, and is safe to re-run. Missing fixers are skipped (some ship in sibling prompts).
//
//   node scripts/reapply-sb-truth.js            # dry-run: runs each fixer's own dry-run
//   node scripts/reapply-sb-truth.js --apply    # re-apply all (passes --apply down to each fixer)
//
const { execFileSync } = require('child_process');
const { makePrisma } = require('./prisma-client');
const fs = require('fs');
const APPLY = process.argv.includes('--apply');

// Re-applies SB-derived QMB cost-share protection from the pre-built JSON artifact.
// Safe to run in dry-run mode (just reports what would change) or --apply.
async function reapplyQmbProtection() {
  const path = 'scripts/data/qmb-protection.json';
  if (!fs.existsSync(path)) { console.log('  qmb-protection.json missing — skip'); return; }
  const data = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (!APPLY) {
    console.log(`  [dry-run] would reapply qmb-protection to ${Object.keys(data).length} planIds`);
    return;
  }
  const prisma = makePrisma();
  let n = 0;
  try {
    for (const [planId, v] of Object.entries(data)) {
      const r = await prisma.plan.updateMany({
        where: { planId },
        data: {
          qmbCostShareProtected: v.protected,
          costShareProtectedLevels: (v.levels || []).join(',') || null,
        },
      });
      n += r.count;
    }
    console.log(`  reapply-sb-truth: qmb-protection reapplied to ${n} rows`);
  } finally {
    await prisma.$disconnect();
  }
}

// Each fixer is independent + idempotent; loose order. Add new SB-truth fixers here as they ship.
const FIXERS = [
  'scripts/fix-specialist-typediff-zero.js',       // 82 specialist coins -> $0 copay (re-classifies from SB; STOPs if >110)
  'scripts/set-uhc-specialist-choice-display.js', // UHC-16 "$0 or NN%" display (re-proves from SB; STOPs if >30)
  'scripts/fix-aetna-extra-supports-wallet.js',   // Aetna converting wallet -> Food Card + chronic-only chips
  'scripts/sweep-converting-wallets.js',          // Humana/UHC/Wellcare converting wallets (if shipped)
  'scripts/fill-uhc-foodcard-from-sb.js',         // UHC/Wellcare converting-wallet food $ from SB monthly credits
  'scripts/fill-aetna-quarterly-foodcard.js',     // Aetna quarterly Extra Supports -> Food Card (if shipped)
];

let ran = 0, skipped = 0;
for (const f of FIXERS) {
  if (!fs.existsSync(f)) { console.log(`SKIP (not present): ${f}`); skipped++; continue; }
  const args = [f]; if (APPLY) args.push('--apply');
  console.log(`\n=== ${APPLY ? 'APPLY' : 'DRY-RUN'}: node ${args.join(' ')} ===`);
  try { execFileSync('node', args, { stdio: 'inherit' }); ran++; }
  catch (e) { console.error(`\nFIXER FAILED: ${f} (exit ${e.status}). Stopping so you can inspect — re-apply is all-or-nothing on a failure.`); process.exit(e.status || 1); }
}

// Async fixers (DB-direct, no child process)
console.log(`\n=== ${APPLY ? 'APPLY' : 'DRY-RUN'}: reapplyQmbProtection (inline) ===`);
reapplyQmbProtection().then(() => {
  console.log(`\nreapply-sb-truth: ran ${ran}, skipped ${skipped}. ${APPLY ? 'Re-applied all present fixers.' : 'Dry-run only — re-run with --apply.'}`);
  console.log('NOTE: the 15 HealthSpring + 3 other one-off specialist point-fixes from 2026-06-18 are NOT in a re-runnable script.');
  console.log('      They are captured in audit-specialist-allcarriers.csv — re-run the all-carrier specialist audit after a re-import to re-detect them.');
}).catch((e) => { console.error('reapplyQmbProtection failed:', e); process.exit(1); });
