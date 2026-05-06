// scripts/enrich-ma-only-from-pbp.js
//
// Targeted enrichment for the 7,186 MA_ONLY rows the backfill just inserted.
//
// Reads only PBP B7 (PCP/specialist), B1a (hospital stay), B16 (dental
// numeric + descriptive) and updates MA_ONLY rows in the DB.
//
// Why targeted instead of running enrich-plan-copays-from-pbp.js?
//   - We have 101 distinct MA_ONLY planIds, much smaller than the full DB
//   - Existing enrichment has a documented coinsurance-skip (per memory)
//     that we don't want triggering on these flat-copay MA-Only plans
//   - Avoids re-processing 24k DSNP rows where the Part 3 $0-fill already
//     wrote good values
//
// Strategy: parse the 3 PBP files into per-plan-key maps, then for each
// distinct MA_ONLY planId in DB, update all county-rows in one updateMany.
//
// Idempotent: only writes when the source PBP value is non-null. Re-runs
// are safe.
//
// Usage:
//   node scripts/enrich-ma-only-from-pbp.js              # dry-run summary
//   node scripts/enrich-ma-only-from-pbp.js --apply      # write to DB

const fs = require('fs');
const path = require('path');
const { makePrisma } = require('./prisma-client');

const APPLY = process.argv.includes('--apply');
const PLAN_YEAR = 2026;
const PBP_DIR = path.join(process.cwd(), '.cms-import-tmp', `pbp-${PLAN_YEAR}`);

// ----- TSV parser (kept-first-occurrence for duplicate column names) -----
function parseTSV(filePath) {
  if (!fs.existsSync(filePath)) {
    console.warn(`  Missing: ${filePath}`);
    return [];
  }
  const buf = fs.readFileSync(filePath, 'utf-8');
  const lines = buf.split(/\r?\n/);
  if (lines.length === 0) return [];
  const header = lines[0].split('\t');
  const idx = new Map();
  header.forEach((name, i) => { if (!idx.has(name)) idx.set(name, i); });
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cells = line.split('\t');
    const row = {};
    for (const [name, j] of idx) row[name] = cells[j] ?? '';
    rows.push(row);
  }
  return rows;
}

function num(s) {
  if (!s) return null;
  const t = s.trim();
  if (!t) return null;
  const n = parseFloat(t);
  return isNaN(n) ? null : n;
}

function planKey(r) {
  const h = (r.pbp_a_hnumber || '').trim();
  const p = (r.pbp_a_plan_identifier || '').trim();
  const s = (r.segment_id || '').trim();
  return h && p ? `${h}-${p}-${s || '0'}` : null;
}

// CMS period code -> label (mirrors import-cms-data.ts)
function periodLabel(code) {
  switch ((code || '').trim()) {
    case '1': return '/month';
    case '2': return '/quarter';
    case '3': return '/year';
    case '4': return '/2 years';
    case '6': return '/episode';
    case '7': return '/benefit period';
    default:  return '';
  }
}

function buildDayStructure(row, prefix, tier) {
  const parts = [];
  for (let i = 1; i <= 3; i++) {
    const amt = num(row[`${prefix}_amt_int${i}${tier}`]);
    const bgn = row[`${prefix}_bgnd_int${i}${tier}`];
    const end = row[`${prefix}_endd_int${i}${tier}`];
    if (amt != null && bgn && end) parts.push(`$${amt}/day days ${bgn}-${end}`);
  }
  return parts.length ? parts.join(', ') : null;
}

async function main() {
  console.log(`=== Enrich MA_ONLY plans from PBP (year=${PLAN_YEAR}) ===`);
  console.log(`Mode: ${APPLY ? 'APPLY (will write to DB)' : 'DRY RUN'}\n`);

  if (!fs.existsSync(PBP_DIR)) {
    console.error(`PBP dir not found: ${PBP_DIR}`);
    process.exit(1);
  }

  // --- Build per-plan-key maps from PBP ---
  console.log('Parsing pbp_b7_health_prof.txt...');
  const pcpMap = new Map();
  const specMap = new Map();
  for (const r of parseTSV(path.join(PBP_DIR, 'pbp_b7_health_prof.txt'))) {
    const k = planKey(r);
    if (!k) continue;
    if (r.pbp_b7a_copay_yn === '1') {
      const v = num(r.pbp_b7a_copay_amt_mc_min);
      if (v != null) pcpMap.set(k, v);
    }
    if (r.pbp_b7b_copay_yn === '1') {
      const v = num(r.pbp_b7b_copay_mc_amt_min);
      if (v != null) specMap.set(k, v);
    }
  }
  console.log(`  PCP copay entries: ${pcpMap.size}, specialist: ${specMap.size}`);

  console.log('Parsing pbp_b1a_inpat_hosp.txt...');
  const hospMap = new Map();
  for (const r of parseTSV(path.join(PBP_DIR, 'pbp_b1a_inpat_hosp.txt'))) {
    const k = planKey(r);
    if (!k) continue;
    if (r.pbp_b1a_copay_yn === '1') {
      const v = buildDayStructure(r, 'pbp_b1a_copay_mcs', '_t1');
      if (v) hospMap.set(k, v);
    }
  }
  console.log(`  Hospital stay entries: ${hospMap.size}`);

  console.log('Parsing pbp_b16_dental.txt...');
  const dentalStrMap = new Map();
  const dentalNumMap = new Map();
  for (const r of parseTSV(path.join(PBP_DIR, 'pbp_b16_dental.txt'))) {
    const k = planKey(r);
    if (!k) continue;
    // Comprehensive dental first (preferred), then preventive
    let amt = null, label = null, per = '';
    if (r.pbp_b16c_maxplan_cmp_yn === '1') {
      amt = num(r.pbp_b16c_maxplan_cmp_amt) ?? num(r.pbp_b16c_maxenr_cmp_amt);
      per = periodLabel(r.pbp_b16c_maxplan_cmp_per || r.pbp_b16c_maxenr_cmp_per);
      if (amt != null) label = `Comprehensive dental - $${amt}${per} max`;
      else label = 'Comprehensive dental (no max)';
    } else if (r.pbp_b16b_maxplan_pv_yn === '1') {
      amt = num(r.pbp_b16b_maxplan_pv_amt) ?? num(r.pbp_b16b_maxenr_pv_amt);
      per = periodLabel(r.pbp_b16b_maxplan_pv_per || r.pbp_b16b_maxenr_pv_per);
      if (amt != null) label = `Preventive dental - $${amt}${per} max`;
      else label = 'Preventive dental (no max)';
    } else if (r.pbp_b16a_maxenr_mc_yn === '1' || r.pbp_b16a_maxenr_mc_yn === '2') {
      amt = num(r.pbp_b16a_maxenr_mc_amt);
      per = periodLabel(r.pbp_b16a_maxenr_mc_per);
      if (amt != null) label = `Preventive dental - $${amt}${per} max`;
      else label = 'Preventive dental (no max)';
    }
    if (label) dentalStrMap.set(k, label);
    if (amt != null) dentalNumMap.set(k, amt);
  }
  console.log(`  Dental string entries: ${dentalStrMap.size}, numeric: ${dentalNumMap.size}`);

  // --- Pull MA_ONLY rows from DB to enrich ---
  const prisma = makePrisma();

  // Distinct planIds + segmentid wouldn't normally be queryable cleanly; we
  // assume segment 0 unless we stored it. The DB schema has planId as a
  // String "${contractId}-${planIdNoPad}". We'll match by full key
  // by parsing the planId string back out and trying segment "0" first.
  const distinctPlans = await prisma.plan.findMany({
    where: { planYear: PLAN_YEAR, planCategory: 'MA_ONLY' },
    select: { planId: true },
    distinct: ['planId'],
  });
  console.log(`\n${distinctPlans.length} distinct MA_ONLY planIds in DB.`);

  let updates = 0;
  let totalRowsTouched = 0;
  let noBenefitData = 0;
  for (const p of distinctPlans) {
    // planId in DB is "H1234-7" (no zero pad). Convert to PBP key "H1234-007-0"
    const m = p.planId.match(/^([A-Z]\d{4,5})-(\d+)$/);
    if (!m) { noBenefitData++; continue; }
    const h = m[1];
    const padded = m[2].padStart(3, '0');
    const key = `${h}-${padded}-0`;

    const data = {};
    if (pcpMap.has(key)) data.pcpCopay = pcpMap.get(key);
    if (specMap.has(key)) data.specialistCopay = specMap.get(key);
    if (hospMap.has(key)) data.hospitalStayCopay = hospMap.get(key);
    if (dentalStrMap.has(key)) data.dentalBenefits = dentalStrMap.get(key);
    if (dentalNumMap.has(key)) data.dentalAnnualMax = dentalNumMap.get(key);

    if (Object.keys(data).length === 0) { noBenefitData++; continue; }

    if (APPLY) {
      const r = await prisma.plan.updateMany({
        where: { planYear: PLAN_YEAR, planCategory: 'MA_ONLY', planId: p.planId },
        data,
      });
      totalRowsTouched += r.count;
    }
    updates++;
  }
  console.log(`\nDistinct planIds with at least one PBP field to write: ${updates}`);
  console.log(`Distinct planIds with no PBP match (skipped): ${noBenefitData}`);
  if (APPLY) console.log(`DB rows updated: ${totalRowsTouched}`);
  else console.log('\n[DRY RUN] Re-run with --apply to write.');

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
