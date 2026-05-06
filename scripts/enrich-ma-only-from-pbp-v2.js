// scripts/enrich-ma-only-from-pbp-v2.js
//
// Extension of enrich-ma-only-from-pbp.js (which only populated 5 ranking
// inputs: PCP, specialist, hospital, dental). This v2 ALSO populates:
//
//   - emergencyRoomCopay     (PBP b4a)
//   - ambulanceCopay         (PBP b10a — ground ambulance)
//   - outpatientHospitalCopay (PBP b9a)
//   - skilledNursingCopay    (PBP b2 — day-structure string)
//   - mriCopay               (PBP b8a / b8b)
//   - catScanCopay           (same source as MRI)
//
// Also tightens dental extraction so the dollar amount lands when CMS
// files comprehensive + preventive sections separately.
//
// Idempotent. Only writes when source PBP value is non-null. Re-runs safe.
// Targets ONLY MA_ONLY plans (so we don't disturb DSNP $0 enrichment).

const fs = require('fs');
const path = require('path');
const { makePrisma } = require('./prisma-client');

const APPLY = process.argv.includes('--apply');
const PLAN_YEAR = 2026;
const PBP_DIR = path.join(process.cwd(), '.cms-import-tmp', `pbp-${PLAN_YEAR}`);

function parseTSV(filePath) {
  if (!fs.existsSync(filePath)) { console.warn(`  Missing: ${filePath}`); return []; }
  const buf = fs.readFileSync(filePath, 'utf-8');
  const lines = buf.split(/\r?\n/);
  const header = lines[0].split('\t');
  const idx = new Map();
  header.forEach((name, i) => { if (!idx.has(name)) idx.set(name, i); });
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]; if (!line) continue;
    const cells = line.split('\t');
    const row = {};
    for (const [name, j] of idx) row[name] = cells[j] ?? '';
    rows.push(row);
  }
  return rows;
}

function num(s) {
  if (!s) return null;
  const t = s.trim(); if (!t) return null;
  const n = parseFloat(t);
  return isNaN(n) ? null : n;
}

function planKey(r) {
  const h = (r.pbp_a_hnumber || '').trim();
  const p = (r.pbp_a_plan_identifier || '').trim();
  const s = (r.segment_id || '').trim();
  return h && p ? `${h}-${p}-${s || '0'}` : null;
}

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

(async () => {
  console.log(`=== Enrich MA_ONLY (v2: + ER/Ambulance/OutpatientHosp/SNF/MRI/CT) ===`);
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  if (!fs.existsSync(PBP_DIR)) { console.error(`PBP dir not found: ${PBP_DIR}`); process.exit(1); }

  // ---- Build per-plan-key maps ----
  console.log('Parsing pbp_b7_health_prof.txt...');
  const pcpMap = new Map(), specMap = new Map();
  for (const r of parseTSV(path.join(PBP_DIR, 'pbp_b7_health_prof.txt'))) {
    const k = planKey(r); if (!k) continue;
    if (r.pbp_b7a_copay_yn === '1') { const v = num(r.pbp_b7a_copay_amt_mc_min); if (v != null) pcpMap.set(k, v); }
    if (r.pbp_b7b_copay_yn === '1') { const v = num(r.pbp_b7b_copay_mc_amt_min); if (v != null) specMap.set(k, v); }
  }
  console.log(`  PCP: ${pcpMap.size}, specialist: ${specMap.size}`);

  console.log('Parsing pbp_b1a_inpat_hosp.txt...');
  const hospMap = new Map();
  for (const r of parseTSV(path.join(PBP_DIR, 'pbp_b1a_inpat_hosp.txt'))) {
    const k = planKey(r); if (!k) continue;
    if (r.pbp_b1a_copay_yn === '1') {
      const v = buildDayStructure(r, 'pbp_b1a_copay_mcs', '_t1');
      if (v) hospMap.set(k, v);
    }
  }
  console.log(`  Hospital stay: ${hospMap.size}`);

  console.log('Parsing pbp_b2_snf.txt...');
  const snfMap = new Map();
  for (const r of parseTSV(path.join(PBP_DIR, 'pbp_b2_snf.txt'))) {
    const k = planKey(r); if (!k) continue;
    if (r.pbp_b2_copay_yn === '1') {
      const v = buildDayStructure(r, 'pbp_b2_copay_mcs', '_t1');
      if (v) snfMap.set(k, v);
    }
  }
  console.log(`  Skilled nursing: ${snfMap.size}`);

  console.log('Parsing pbp_b4_emerg_urgent.txt...');
  const erMap = new Map();
  for (const r of parseTSV(path.join(PBP_DIR, 'pbp_b4_emerg_urgent.txt'))) {
    const k = planKey(r); if (!k) continue;
    if (r.pbp_b4a_copay_yn === '1') {
      const v = num(r.pbp_b4a_copay_amt_mc_min);
      if (v != null) erMap.set(k, v);
    }
  }
  console.log(`  Emergency Room: ${erMap.size}`);

  console.log('Parsing pbp_b9_outpat_hosp.txt...');
  const outpHospMap = new Map();
  for (const r of parseTSV(path.join(PBP_DIR, 'pbp_b9_outpat_hosp.txt'))) {
    const k = planKey(r); if (!k) continue;
    if (r.pbp_b9a_copay_yn === '1') {
      const v = num(r.pbp_b9a_copay_ohs_amt_max) ?? num(r.pbp_b9a_copay_ohs_amt_min);
      if (v != null) outpHospMap.set(k, v);
    }
  }
  console.log(`  Outpatient hospital: ${outpHospMap.size}`);

  console.log('Parsing pbp_b10_amb_trans.txt...');
  const ambMap = new Map();
  for (const r of parseTSV(path.join(PBP_DIR, 'pbp_b10_amb_trans.txt'))) {
    const k = planKey(r); if (!k) continue;
    if (r.pbp_b10a_copay_yn === '1') {
      const v = num(r.pbp_b10a_copay_gas_amt_min);
      if (v != null) ambMap.set(k, v);
    }
  }
  console.log(`  Ambulance: ${ambMap.size}`);

  console.log('Parsing pbp_b8_clin_diag_ther.txt...');
  const mriMap = new Map(), catMap = new Map();
  for (const r of parseTSV(path.join(PBP_DIR, 'pbp_b8_clin_diag_ther.txt'))) {
    const k = planKey(r); if (!k) continue;
    if (r.pbp_b8a_copay_yn === '1') {
      const v = num(r.pbp_b8a_copay_max_dmc_amt) ?? num(r.pbp_b8a_copay_min_dmc_amt);
      if (v != null) { mriMap.set(k, v); catMap.set(k, v); }
    }
    if (r.pbp_b8b_copay_yn === '1') {
      const drs = num(r.pbp_b8b_copay_amt_drs);
      if (drs != null) {
        if (!mriMap.has(k)) mriMap.set(k, drs);
        if (!catMap.has(k)) catMap.set(k, drs);
      }
    }
  }
  console.log(`  MRI: ${mriMap.size}, CT scan: ${catMap.size}`);

  console.log('Parsing pbp_b16_dental.txt (with harder amount extraction)...');
  const dentalStrMap = new Map();
  const dentalNumMap = new Map();
  for (const r of parseTSV(path.join(PBP_DIR, 'pbp_b16_dental.txt'))) {
    const k = planKey(r); if (!k) continue;
    // Try every dental-amount field CMS publishes; take the first non-null.
    // Comprehensive (b16c) preferred, then preventive (b16b, b16a).
    let amt = null, label = null, per = '';
    let coverageType = null; // 'comprehensive' | 'preventive'

    if (r.pbp_b16c_maxplan_cmp_yn === '1' || r.pbp_b16c_maxenr_cmp_yn === '1') {
      amt = num(r.pbp_b16c_maxplan_cmp_amt) ?? num(r.pbp_b16c_maxenr_cmp_amt);
      per = periodLabel(r.pbp_b16c_maxplan_cmp_per || r.pbp_b16c_maxenr_cmp_per);
      coverageType = 'Comprehensive';
    }
    if (amt == null && (r.pbp_b16b_maxplan_pv_yn === '1' || r.pbp_b16b_maxenr_pv_yn === '1')) {
      amt = num(r.pbp_b16b_maxplan_pv_amt) ?? num(r.pbp_b16b_maxenr_pv_amt);
      per = periodLabel(r.pbp_b16b_maxplan_pv_per || r.pbp_b16b_maxenr_pv_per);
      if (!coverageType) coverageType = 'Preventive';
    }
    if (amt == null && (r.pbp_b16a_maxenr_mc_yn === '1' || r.pbp_b16a_maxenr_mc_yn === '2' || r.pbp_b16a_maxplan_yn === '1')) {
      amt = num(r.pbp_b16a_maxenr_mc_amt) ?? num(r.pbp_b16a_maxplan_amt);
      per = periodLabel(r.pbp_b16a_maxenr_mc_per || r.pbp_b16a_maxplan_per);
      if (!coverageType) coverageType = 'Preventive';
    }

    if (coverageType && amt != null) label = `${coverageType} dental - $${amt}${per} max`;
    else if (coverageType) label = `${coverageType} dental (no max)`;

    if (label) dentalStrMap.set(k, label);
    if (amt != null) dentalNumMap.set(k, amt);
  }
  console.log(`  Dental string: ${dentalStrMap.size}, numeric: ${dentalNumMap.size}\n`);

  // ---- Pull MA_ONLY rows from DB ----
  const prisma = makePrisma();
  const distinctPlans = await prisma.plan.findMany({
    where: { planYear: PLAN_YEAR, planCategory: 'MA_ONLY' },
    select: { planId: true },
    distinct: ['planId'],
  });
  console.log(`${distinctPlans.length} distinct MA_ONLY planIds in DB.`);

  let updates = 0;
  let totalRowsTouched = 0;
  let noBenefitData = 0;
  for (const p of distinctPlans) {
    const m = p.planId.match(/^([A-Z]\d{4,5})-(\d+)$/);
    if (!m) { noBenefitData++; continue; }
    const h = m[1]; const padded = m[2].padStart(3, '0');
    const key = `${h}-${padded}-0`;

    const data = {};
    if (pcpMap.has(key))      data.pcpCopay              = pcpMap.get(key);
    if (specMap.has(key))     data.specialistCopay       = specMap.get(key);
    if (hospMap.has(key))     data.hospitalStayCopay     = hospMap.get(key);
    if (snfMap.has(key))      data.skilledNursingCopay   = snfMap.get(key);
    if (erMap.has(key))       data.emergencyRoomCopay    = erMap.get(key);
    if (outpHospMap.has(key)) data.outpatientHospitalCopay = outpHospMap.get(key);
    if (ambMap.has(key))      data.ambulanceCopay        = ambMap.get(key);
    if (mriMap.has(key))      data.mriCopay              = mriMap.get(key);
    if (catMap.has(key))      data.catScanCopay          = catMap.get(key);
    if (dentalStrMap.has(key)) data.dentalBenefits       = dentalStrMap.get(key);
    if (dentalNumMap.has(key)) data.dentalAnnualMax      = dentalNumMap.get(key);

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
  console.log(`\nDistinct planIds with PBP data: ${updates}`);
  console.log(`Distinct planIds skipped: ${noBenefitData}`);
  if (APPLY) console.log(`DB rows updated: ${totalRowsTouched}`);
  else console.log('\n[DRY RUN] Re-run with --apply.');

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
