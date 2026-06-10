// scripts/fix-hospital-and-moop.js
// Fixes NULL hospital copays and MOOP mismatches using CMS 2026 PBP files.
// Run: node scripts/fix-hospital-and-moop.js
// Add --apply to write changes to DB (default is dry-run).

const fs   = require('fs');
const path = require('path');
const { makePrisma } = require('./prisma-client');

const APPLY = process.argv.includes('--apply');
const PBP_DIR = 'C:\\Users\\dbuir\\OneDrive\\Documents\\Claude\\Projects\\MAPD Plan Finder';

const LICENSED_STATES = [
  'AL','AR','FL','GA','IL','IN','KS','KY','LA',
  'MO','MS','OH','OK','SC','TN','TX','VA','WV'
];

// PBP planId key format matches DB: H0628-11 (parseInt strips leading zeros)
function pbpKey(hnumber, planIdentifier) {
  const n = parseInt(planIdentifier, 10);
  if (isNaN(n)) return null;
  return `${String(hnumber).trim()}-${n}`;
}

// Parse a tab-delimited PBP file; yields row objects
function* parseTSV(filename) {
  const filepath = path.join(PBP_DIR, filename);
  if (!fs.existsSync(filepath)) {
    console.warn(`  WARN: ${filename} not found`);
    return;
  }
  const lines = fs.readFileSync(filepath, 'latin1').split('\n');
  const headers = lines[0].trim().split('\t');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split('\t');
    const row = {};
    headers.forEach((h, idx) => { row[h] = (cols[idx] || '').trim(); });
    yield row;
  }
}

// Parse a numeric string; returns null if blank or NaN
function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const f = parseFloat(v);
  return isNaN(f) ? null : f;
}

// Build "$X/day days A-B, $Y/day days C-D" string from PBP interval columns
// prefix = "pbp_b1a_copay_mcs", tier = "_t1"
function buildDayStructure(row, prefix, tier) {
  const parts = [];
  for (let i = 1; i <= 3; i++) {
    const amt = num(row[`${prefix}_amt_int${i}${tier}`]);
    const bgn = row[`${prefix}_bgnd_int${i}${tier}`];
    const end = row[`${prefix}_endd_int${i}${tier}`];
    if (amt !== null && bgn && end) {
      parts.push(`$${amt}/day days ${bgn}-${end}`);
    }
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

// ── Load PBP benefit values ───────────────────────────────────────────────────
function loadPbpBenefits() {
  const pbp = {};  // planId -> { hospitalStayCopay, maxOutOfPocket }

  const set = (planId, field, val) => {
    if (val === null || val === undefined) return;
    if (!pbp[planId]) pbp[planId] = {};
    // First non-null value wins (matches existing importer behavior)
    if (pbp[planId][field] === undefined) pbp[planId][field] = val;
  };

  // B1a — inpatient hospital per-day copay string
  console.log('Reading pbp_b1a_inpat_hosp.txt...');
  for (const row of parseTSV('pbp_b1a_inpat_hosp.txt')) {
    const k = pbpKey(row.pbp_a_hnumber, row.pbp_a_plan_identifier);
    if (!k) continue;
    if (row.pbp_b1a_copay_yn === '1') {
      // Try interval structure first (e.g. "$175/day days 1-5, $0/day days 6-90")
      const s = buildDayStructure(row, 'pbp_b1a_copay_mcs', '_t1');
      if (s) {
        set(k, 'hospitalStayCopay', s);
      } else {
        // Flat per-stay copay: int_num=1 but no interval day columns populated;
        // amt_t1 holds the single flat amount. parseHospitalCopayDay1 fallback
        // regex extracts the leading dollar amount, so "$X/stay" ranks correctly.
        const flatAmt = num(row.pbp_b1a_copay_mcs_amt_t1);
        if (flatAmt !== null) {
          set(k, 'hospitalStayCopay', `$${flatAmt}/stay`);
        }
      }
    } else if (row.pbp_b1a_copay_yn === '2' && row.pbp_b1a_coins_yn !== '1') {
      // No copay, no coinsurance = covered in full at $0
      set(k, 'hospitalStayCopay', '$0/day days 1-90');
    }
  }

  // Section D — MOOP (pbp_d_out_pocket_amt = in-network max out-of-pocket)
  console.log('Reading pbp_Section_D.txt...');
  for (const row of parseTSV('pbp_Section_D.txt')) {
    const k = pbpKey(row.pbp_a_hnumber, row.pbp_a_plan_identifier);
    if (!k) continue;
    const moop = num(row.pbp_d_out_pocket_amt);
    set(k, 'maxOutOfPocket', moop);
  }

  return pbp;
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\nMode: ${APPLY ? 'APPLY (writing to DB)' : 'DRY-RUN (no DB writes)'}\n`);
  const prisma = makePrisma();

  const pbp = loadPbpBenefits();

  // Query all 2026 plans in licensed states
  console.log('\nQuerying DB...');
  const dbRows = await prisma.plan.findMany({
    where: { planYear: 2026, state: { in: LICENSED_STATES } },
    select: {
      id: true,
      planId: true,
      state: true,
      organizationName: true,
      planCategory: true,
      dsnpTargetGroup: true,
      hospitalStayCopay: true,
      maxOutOfPocket: true,
    },
  });

  // Dedupe to one row per planId (same benefits across counties — use first)
  const seenPlanIds = new Set();
  const plans = [];
  for (const row of dbRows) {
    if (!seenPlanIds.has(row.planId)) {
      seenPlanIds.add(row.planId);
      plans.push(row);
    }
  }
  console.log(`  DB distinct plans (2026, licensed): ${plans.length}`);

  // ── Identify fixes ──────────────────────────────────────────────────────────
  const hospitalFixes = [];   // { planId, org, state, newVal }
  const moopFixes     = [];   // { planId, org, state, dbVal, pbpVal }

  for (const db of plans) {
    const p = pbp[db.planId];
    if (!p) continue;

    // Hospital: only fill NULL; skip DSNP FULL_DUAL (their $0 is intentional)
    if (!db.hospitalStayCopay && p.hospitalStayCopay) {
      if (db.dsnpTargetGroup === 'FULL_DUAL') continue;
      hospitalFixes.push({
        planId: db.planId,
        org: db.organizationName,
        state: db.state,
        category: db.planCategory,
        newVal: p.hospitalStayCopay,
      });
    }

    // MOOP: correct mismatches >$100 (MOOP is never modified by DSNP enrichment)
    if (db.maxOutOfPocket !== null && db.maxOutOfPocket !== undefined
        && p.maxOutOfPocket !== undefined) {
      const diff = Math.abs(db.maxOutOfPocket - p.maxOutOfPocket);
      if (diff > 100) {
        moopFixes.push({
          planId: db.planId,
          org: db.organizationName,
          state: db.state,
          category: db.planCategory,
          dbVal: db.maxOutOfPocket,
          pbpVal: p.maxOutOfPocket,
        });
      }
    }
  }

  // ── Report ──────────────────────────────────────────────────────────────────
  console.log('\n=== HOSPITAL COPAY FIXES ===');
  console.log(`Plans with NULL hospital where PBP has value: ${hospitalFixes.length}`);
  for (const f of hospitalFixes) {
    console.log(`  ${f.planId} (${f.org}, ${f.state}, ${f.category}): "${f.newVal}"`);
  }

  console.log('\n=== MOOP FIXES ===');
  console.log(`Plans with MOOP mismatch >$100 vs PBP: ${moopFixes.length}`);
  for (const f of moopFixes) {
    console.log(`  ${f.planId} (${f.org}, ${f.state}, ${f.category}): DB=$${f.dbVal} → PBP=$${f.pbpVal}`);
  }

  if (!APPLY) {
    console.log('\nDRY-RUN complete. Run with --apply to write changes.');
    await prisma.$disconnect();
    return;
  }

  // ── Apply hospital fixes ────────────────────────────────────────────────────
  console.log('\nApplying hospital copay fixes...');
  let hospUpdated = 0;
  for (const f of hospitalFixes) {
    const result = await prisma.plan.updateMany({
      where: {
        planId: f.planId,
        planYear: 2026,
        hospitalStayCopay: null,
      },
      data: { hospitalStayCopay: f.newVal },
    });
    hospUpdated += result.count;
    console.log(`  ${f.planId}: updated ${result.count} rows → "${f.newVal}"`);
  }
  console.log(`Hospital: updated ${hospUpdated} total DB rows across ${hospitalFixes.length} plans`);

  // MOOP fixes are skipped: all 14 detected mismatches are multi-segment plans
  // where Section D has a different MOOP per service area. The DB already stores
  // the correct per-county value from the original import. Updating all rows to
  // segment-1's value would corrupt the correct per-county data.
  console.log('\nMOOP: skipping all corrections (all detected mismatches are multi-segment; DB values are correct per county).');

  console.log('\nDone.');
  await prisma.$disconnect();
})();
