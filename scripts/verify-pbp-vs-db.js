// scripts/verify-pbp-vs-db.js
// Compares CMS 2026 PBP files against the live Neon DB.
// Run: node scripts/verify-pbp-vs-db.js

const fs   = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

// Use DIRECT_URL (non-pooled) for bulk reads — PgBouncer pool times out on 145K-row findMany
function makeDirectPrisma() {
  const envPath = path.join(__dirname, '..', '.env');
  const envContent = fs.readFileSync(envPath, 'utf8');
  const match = envContent.match(/^\s*DIRECT_URL\s*=\s*["']?([^"'\n\r]+)["']?\s*$/m);
  if (!match) throw new Error('DIRECT_URL not found in .env');
  return new PrismaClient({ datasources: { db: { url: match[1] } } });
}

// ── Config ────────────────────────────────────────────────────────────────────
const PBP_DIR = 'C:\\Users\\dbuir\\OneDrive\\Documents\\Claude\\Projects\\MAPD Plan Finder';

const LICENSED_FIPS = new Set([
  '01','05','12','13','17','18','20','21','22',
  '29','28','39','40','45','47','48','51','54'
]);

const LICENSED_STATES = [
  'AL','AR','FL','GA','IL','IN','KS','KY','LA',
  'MO','MS','OH','OK','SC','TN','TX','VA','WV'
];

// PBP planId format: H0628-11  (parseInt strips leading zeros)
function pbpKey(hnumber, planIdentifier) {
  return `${hnumber}-${parseInt(planIdentifier, 10)}`;
}

// ── Tab-delimited file reader ─────────────────────────────────────────────────
function* readTsv(filename) {
  const filepath = path.join(PBP_DIR, filename);
  if (!fs.existsSync(filepath)) {
    console.warn(`  WARN: ${filename} not found at ${filepath}`);
    return;
  }
  const lines = fs.readFileSync(filepath, 'latin1').split('\n');
  const headers = lines[0].trim().split('\t');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split('\t');
    const row = {};
    headers.forEach((h, idx) => { row[h] = cols[idx] || ''; });
    yield row;
  }
}

// ── Parse PBP files ───────────────────────────────────────────────────────────
function loadPbpData() {
  const data = {};  // planId -> benefit values from PBP

  const ensure = (planId) => {
    if (!data[planId]) data[planId] = {};
    return data[planId];
  };

  // 1. PlanArea.txt — which plan combos exist in licensed states
  console.log('Reading PlanArea.txt...');
  let planAreaCount = 0;
  for (const row of readTsv('PlanArea.txt')) {
    const county = (row.county_code || '').trim();
    if (county.length < 2 || !LICENSED_FIPS.has(county.slice(0, 2))) continue;
    const key = pbpKey(row.pbp_a_hnumber.trim(), row.pbp_a_plan_identifier.trim());
    ensure(key).inLicensedState = true;
    planAreaCount++;
  }
  const licensedPlanIds = new Set(Object.keys(data).filter(k => data[k].inLicensedState));
  console.log(`  Licensed-state plans in PBP: ${licensedPlanIds.size}`);

  // 2. Section D — MOOP and deductible
  console.log('Reading pbp_Section_D.txt...');
  for (const row of readTsv('pbp_Section_D.txt')) {
    const key = pbpKey(row.pbp_a_hnumber.trim(), row.pbp_a_plan_identifier.trim());
    if (!licensedPlanIds.has(key)) continue;
    const moop = (row.pbp_d_out_pocket_amt || '').trim();
    const dedInn  = (row.pbp_d_inn_deduct_amt || '').trim();
    const dedComb = (row.pbp_d_comb_deduct_amt || '').trim();
    if (moop) ensure(key).pbpMoop = parseFloat(moop);
    if (dedInn || dedComb) ensure(key).pbpDeductible = parseFloat(dedInn || dedComb);
  }

  // 3. B7 — PCP (b7a) and Specialist (b7b)
  console.log('Reading pbp_b7_health_prof.txt...');
  for (const row of readTsv('pbp_b7_health_prof.txt')) {
    const key = pbpKey(row.pbp_a_hnumber.trim(), row.pbp_a_plan_identifier.trim());
    if (!licensedPlanIds.has(key)) continue;
    const pcpCopay    = (row.pbp_b7a_copay_amt_mc_min || '').trim();
    const pcpCoins    = (row.pbp_b7a_coins_pct_mc_min || '').trim();
    const specCopay   = (row.pbp_b7d_copay_amt_mc_min || '').trim();
    const specCoins   = (row.pbp_b7d_coins_pct_mc_min || '').trim();
    if (pcpCopay  !== '') ensure(key).pbpPcpCopay  = parseFloat(pcpCopay);
    if (pcpCoins  !== '') ensure(key).pbpPcpCoins  = parseFloat(pcpCoins);
    if (specCopay !== '') ensure(key).pbpSpecCopay = parseFloat(specCopay);
    if (specCoins !== '') ensure(key).pbpSpecCoins = parseFloat(specCoins);
  }

  // 4. B1a — Hospital (per-day tier-1 copay)
  console.log('Reading pbp_b1a_inpat_hosp.txt...');
  for (const row of readTsv('pbp_b1a_inpat_hosp.txt')) {
    const key = pbpKey(row.pbp_a_hnumber.trim(), row.pbp_a_plan_identifier.trim());
    if (!licensedPlanIds.has(key)) continue;
    const copayYn   = (row.pbp_b1a_copay_yn || '').trim();
    const copayDay1 = (row.pbp_b1a_copay_mcs_amt_int1_t1 || '').trim();
    const copayT1   = (row.pbp_b1a_copay_mcs_amt_t1 || '').trim();
    const coinsT1   = (row.pbp_b1a_coins_mcs_pct_t1 || '').trim();
    // copay_yn='2' with no coinsurance = $0 hospital (covered in full)
    if (copayYn === '2' && !coinsT1) ensure(key).pbpHospitalIsZero = true;
    if (copayDay1 !== '') ensure(key).pbpHospitalDay1 = parseFloat(copayDay1);
    else if (copayT1 !== '') ensure(key).pbpHospitalDay1 = parseFloat(copayT1);
    if (coinsT1 !== '') ensure(key).pbpHospitalCoins = parseFloat(coinsT1);
  }

  // 5. MRX tier — drug tier 1 (preferred generic, 30-day retail)
  console.log('Reading pbp_mrx_tier.txt...');
  for (const row of readTsv('pbp_mrx_tier.txt')) {
    const key = pbpKey(row.pbp_a_hnumber.trim(), row.pbp_a_plan_identifier.trim());
    if (!licensedPlanIds.has(key)) continue;
    const tierId = (row.mrx_tier_id || '').trim();
    if (tierId === '1') {
      const cost = (row.mrx_tier_rstd_1m_num || '').trim();
      if (cost !== '') ensure(key).pbpDrugTier1 = parseFloat(cost);
    }
    if (tierId === '2') {
      const cost = (row.mrx_tier_rstd_1m_num || '').trim();
      if (cost !== '') ensure(key).pbpDrugTier2 = parseFloat(cost);
    }
    if (tierId === '3') {
      const cost = (row.mrx_tier_rstd_1m_num || '').trim();
      if (cost !== '') ensure(key).pbpDrugTier3 = parseFloat(cost);
    }
  }

  return { data, licensedPlanIds };
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const prisma = makeDirectPrisma();

  // 1. Load PBP data
  const { data: pbp, licensedPlanIds } = loadPbpData();

  // 2. Query DB — all distinct 2026 plan combos in licensed states
  console.log('\nQuerying DB...');
  const dbRows = await prisma.plan.findMany({
    where: { planYear: 2026, state: { in: LICENSED_STATES } },
    select: {
      planId: true,
      state: true,
      planCategory: true,
      organizationName: true,
      maxOutOfPocket: true,
      medicalDeductible: true,
      pcpCopay: true,
      specialistCopay: true,
      hospitalStayCopay: true,
      drugTier1Copay: true,
      drugTier2Copay: true,
      drugTier3Copay: true,
      starRating: true,
    },
  });

  // Dedupe by planId (one representative row per plan — same benefits across counties)
  const dbPlans = new Map();
  for (const row of dbRows) {
    if (!dbPlans.has(row.planId)) dbPlans.set(row.planId, row);
  }
  console.log(`  DB distinct plans (2026, licensed states): ${dbPlans.size}`);

  // 3. Gap analysis
  const missingFromDb    = [];  // in PBP, not in DB
  const missingFromPbp   = [];  // in DB, not in PBP licensed set
  const nullMoop         = [];
  const nullPcp          = [];
  const nullSpecialist   = [];
  const nullHospital     = [];
  const nullDrugTier1    = [];
  const nullStarRating   = [];
  const moopMismatch     = [];

  // Plans in PBP but not in DB
  for (const planId of licensedPlanIds) {
    if (!dbPlans.has(planId)) missingFromDb.push(planId);
  }

  // Plans in DB — check benefit NULLs and mismatches vs PBP
  for (const [planId, db] of dbPlans) {
    const p = pbp[planId] || {};

    if (db.maxOutOfPocket === null || db.maxOutOfPocket === undefined) {
      nullMoop.push({ planId, org: db.organizationName, state: db.state, pbpMoop: p.pbpMoop });
    } else if (p.pbpMoop !== undefined) {
      const diff = Math.abs(db.maxOutOfPocket - p.pbpMoop);
      if (diff > 100) {
        moopMismatch.push({ planId, org: db.organizationName, state: db.state, db: db.maxOutOfPocket, pbp: p.pbpMoop });
      }
    }

    if (db.pcpCopay === null || db.pcpCopay === undefined) {
      if (p.pbpPcpCopay !== undefined) {
        nullPcp.push({ planId, org: db.organizationName, state: db.state, pbpVal: p.pbpPcpCopay });
      }
    }

    if (db.specialistCopay === null || db.specialistCopay === undefined) {
      if (p.pbpSpecCopay !== undefined) {
        nullSpecialist.push({ planId, org: db.organizationName, state: db.state, pbpVal: p.pbpSpecCopay });
      }
    }

    if (!db.hospitalStayCopay) {
      if (p.pbpHospitalDay1 !== undefined && !p.pbpHospitalIsZero) {
        nullHospital.push({ planId, org: db.organizationName, state: db.state, pbpVal: p.pbpHospitalDay1 });
      }
    }

    if (db.drugTier1Copay === null || db.drugTier1Copay === undefined) {
      if (p.pbpDrugTier1 !== undefined) {
        nullDrugTier1.push({ planId, org: db.organizationName, state: db.state, pbpVal: p.pbpDrugTier1 });
      }
    }

    if (db.starRating === null || db.starRating === undefined) {
      nullStarRating.push({ planId, org: db.organizationName, state: db.state });
    }
  }

  // 4. Spot-check 5 specific plans
  const SPOT_CHECK = ['H0028-7','H1290-20','H4461-76','H5216-164','H7849-2'];
  console.log('\n=== SPOT-CHECK (5 specific plans) ===');
  for (const planId of SPOT_CHECK) {
    const db = dbPlans.get(planId);
    const p  = pbp[planId] || {};
    if (!db) {
      console.log(`  ${planId}: NOT IN DB`);
      continue;
    }
    console.log(`  ${planId} (${db.organizationName}, ${db.state}):`);
    console.log(`    MOOP:       DB=$${db.maxOutOfPocket ?? 'NULL'} | PBP=$${p.pbpMoop ?? 'n/a'}`);
    console.log(`    PCP:        DB=$${db.pcpCopay ?? 'NULL'}      | PBP=$${p.pbpPcpCopay ?? 'n/a'}`);
    console.log(`    Specialist: DB=$${db.specialistCopay ?? 'NULL'} | PBP=$${p.pbpSpecCopay ?? 'n/a'}`);
    console.log(`    Hospital:   DB=${db.hospitalStayCopay ?? 'NULL'} | PBP day1=$${p.pbpHospitalDay1 ?? (p.pbpHospitalIsZero ? '$0 (CIF)' : 'n/a')}`);
    console.log(`    Tier1 drug: DB=$${db.drugTier1Copay ?? 'NULL'} | PBP=$${p.pbpDrugTier1 ?? 'n/a'}`);
    console.log(`    Star rating: DB=${db.starRating ?? 'NULL'}`);
  }

  // 5. Print full gap report
  console.log('\n======= PBP vs DB GAP REPORT =======');
  console.log(`PBP licensed-state plans:          ${licensedPlanIds.size}`);
  console.log(`DB distinct plans (2026, licensed): ${dbPlans.size}`);
  console.log(`Plans in PBP missing from DB:       ${missingFromDb.length}`);
  console.log('');
  console.log(`DB plans with NULL MOOP (PBP has value):      ${nullMoop.length}`);
  console.log(`DB plans with NULL PCP (PBP has value):       ${nullPcp.length}`);
  console.log(`DB plans with NULL Specialist (PBP has val):  ${nullSpecialist.length}`);
  console.log(`DB plans with NULL Hospital (PBP has value):  ${nullHospital.length}`);
  console.log(`DB plans with NULL Tier1 drug (PBP has val):  ${nullDrugTier1.length}`);
  console.log(`DB plans with NULL star rating:               ${nullStarRating.length}`);
  console.log(`MOOP mismatch >$100 between DB and PBP:       ${moopMismatch.length}`);

  if (missingFromDb.length > 0) {
    console.log('\n--- Plans in PBP not in DB (first 20) ---');
    missingFromDb.slice(0, 20).forEach(id => console.log(`  ${id}`));
    fs.writeFileSync('missing-from-db.txt', missingFromDb.join('\n'), 'utf8');
    console.log(`  Full list saved to missing-from-db.txt`);
  }

  if (moopMismatch.length > 0) {
    console.log('\n--- MOOP mismatches (first 10) ---');
    moopMismatch.slice(0, 10).forEach(r =>
      console.log(`  ${r.planId} (${r.org}, ${r.state}): DB=$${r.db} PBP=$${r.pbp}`)
    );
  }

  if (nullMoop.length > 0) {
    console.log('\n--- NULL MOOP in DB but PBP has value (first 10) ---');
    nullMoop.slice(0, 10).forEach(r =>
      console.log(`  ${r.planId} (${r.org}, ${r.state}): PBP MOOP=$${r.pbpMoop}`)
    );
  }

  if (nullHospital.length > 0) {
    console.log('\n--- NULL hospital in DB but PBP has value (first 10) ---');
    nullHospital.slice(0, 10).forEach(r =>
      console.log(`  ${r.planId} (${r.org}, ${r.state}): PBP day1=$${r.pbpVal}`)
    );
  }

  // Save full gap data to file for Dale to review
  const report = {
    summary: {
      pbpLicensedPlans: licensedPlanIds.size,
      dbDistinctPlans: dbPlans.size,
      missingFromDb: missingFromDb.length,
      nullMoop: nullMoop.length,
      nullPcp: nullPcp.length,
      nullSpecialist: nullSpecialist.length,
      nullHospital: nullHospital.length,
      nullDrugTier1: nullDrugTier1.length,
      nullStarRating: nullStarRating.length,
      moopMismatch: moopMismatch.length,
    },
    missingFromDb,
    moopMismatch,
    nullMoop: nullMoop.slice(0, 50),
    nullPcp: nullPcp.slice(0, 50),
    nullSpecialist: nullSpecialist.slice(0, 50),
    nullHospital: nullHospital.slice(0, 50),
    nullDrugTier1: nullDrugTier1.slice(0, 50),
  };
  fs.writeFileSync('pbp-gap-report.json', JSON.stringify(report, null, 2), 'utf8');
  console.log('\nFull gap report saved to pbp-gap-report.json');

  await prisma.$disconnect();
})();
