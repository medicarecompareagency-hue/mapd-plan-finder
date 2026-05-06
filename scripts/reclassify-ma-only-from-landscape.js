// scripts/reclassify-ma-only-from-landscape.js
//
// Repairs the contract-level Part-D-flag mis-classification (2026-05-06).
//
// Background: derivePlanCategory() in import-cms-data.ts uses
// pbp_a_contract_partd_flag from PBP Section A — but that flag is
// CONTRACT-level, not plan-level. Multi-plan contracts (e.g. Humana's
// H4461) have BOTH MA-PD plans and MA-Only "Honor Giveback" plans on
// them. The contract-level flag is "1" because some plans on the
// contract have drug coverage, so the entire contract gets stamped
// MAPD — including the actual MA-Only plans.
//
// Authoritative signal: the CMS landscape CSV (ma2026.csv) has a
// `drugbenefittype` column that's EMPTY for MA-Only plans and
// populated ("Enhanced" / "Basic" / etc.) for MA-PD. Confirmed via
// Humana Honor Giveback samples (H4461-075, H5216-236, R0110-017).
//
// This script:
//   1. Reads ma2026.csv
//   2. For each row with drugbenefittype empty AND no SNP indication,
//      collects (planId, state, county) keys to reclassify
//   3. By default DRY-RUN: prints counts and samples, no DB writes
//   4. With --apply: updates planCategory MAPD -> MA_ONLY in matching rows
//
// Usage:
//   node scripts/reclassify-ma-only-from-landscape.js              # dry run
//   node scripts/reclassify-ma-only-from-landscape.js --apply      # write

const fs = require('fs');
const path = require('path');
const { makePrisma } = require('./prisma-client');

const APPLY = process.argv.includes('--apply');
const PLAN_YEAR = 2026;
const LANDSCAPE_PATH = path.join(process.cwd(), '.cms-import-tmp', `ma${PLAN_YEAR}.csv`);

const STATE_ABBREVS = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA',
  Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE', 'District of Columbia': 'DC',
  Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL',
  Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA',
  Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN',
  Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV',
  'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY',
  'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK',
  Oregon: 'OR', Pennsylvania: 'PA', 'Puerto Rico': 'PR', 'Rhode Island': 'RI',
  'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX',
  Utah: 'UT', Vermont: 'VT', Virginia: 'VA', Washington: 'WA',
  'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY',
};

// Naive CSV parser — landscape CSV doesn't quote fields with commas in
// the cells we care about (state, contractid, planid, segmentid,
// drugbenefittype, typeofmedicarehealthplan).
function parseCSV(filePath) {
  const text = fs.readFileSync(filePath, 'utf-8');
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) return [];
  const hdr = lines[0].split(',');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const c = line.split(',');
    const row = {};
    for (let j = 0; j < hdr.length; j++) row[hdr[j]] = (c[j] || '').trim();
    out.push(row);
  }
  return out;
}

async function main() {
  console.log(`=== Reclassify MA-Only from landscape (year=${PLAN_YEAR}) ===`);
  console.log(`Mode: ${APPLY ? 'APPLY (will write to DB)' : 'DRY RUN (no writes)'}\n`);

  if (!fs.existsSync(LANDSCAPE_PATH)) {
    console.error(`Landscape file not found: ${LANDSCAPE_PATH}`);
    process.exit(1);
  }

  console.log('Reading landscape CSV...');
  const rows = parseCSV(LANDSCAPE_PATH);
  console.log(`  ${rows.length} rows\n`);

  // Build set of MA-Only candidates from landscape: (planId, state, county)
  // where drugbenefittype is empty AND planType isn't a clear non-MA category.
  const candidates = new Map(); // key = planId|state|county -> { planId, state, county, planType, organizationname }
  let landscapeMatched = 0;
  let skippedHasDrug = 0;
  let skippedSnpType = 0;
  let skippedPdp = 0;
  let skippedNoState = 0;

  for (const r of rows) {
    const drugBenefit = (r.drugbenefittype || '').trim();
    const typeofMA = (r.typeofmedicarehealthplan || '').trim();
    const contractId = (r.contractid || '').trim();
    const planId = (r.planid || '').trim();
    if (!contractId || !planId) continue;
    if (drugBenefit) { skippedHasDrug++; continue; }
    // MA-Only never includes the SNP types
    if (/SNP|Special Need/i.test(typeofMA)) { skippedSnpType++; continue; }
    // PDP would have drugbenefittype set; safety check
    if (/PDP|prescription/i.test(typeofMA)) { skippedPdp++; continue; }

    const stateAbbrev = STATE_ABBREVS[r.state] || r.state;
    const county = (r.county || '').trim();
    if (!county || !stateAbbrev) { skippedNoState++; continue; }

    const dbPlanId = `${contractId}-${planId}`; // matches DB format (no zero pad on plan portion)
    const key = `${dbPlanId}|${stateAbbrev}|${county}`;
    if (!candidates.has(key)) {
      candidates.set(key, {
        planId: dbPlanId,
        state: stateAbbrev,
        county,
        planType: typeofMA,
        organizationname: (r.organizationname || '').trim(),
      });
    }
    landscapeMatched++;
  }

  console.log(`Landscape filter:`);
  console.log(`  Has drugbenefittype (skipped):  ${skippedHasDrug.toLocaleString()}`);
  console.log(`  SNP-type plans (skipped):       ${skippedSnpType.toLocaleString()}`);
  console.log(`  PDP-type plans (skipped):       ${skippedPdp.toLocaleString()}`);
  console.log(`  Missing state/county (skipped): ${skippedNoState.toLocaleString()}`);
  console.log(`  MA-Only candidate landscape rows: ${landscapeMatched.toLocaleString()}`);
  console.log(`  Distinct (planId, state, county) MA-Only candidates: ${candidates.size.toLocaleString()}\n`);

  // Now match against DB
  const prisma = makePrisma();

  console.log('Counting DB rows that match candidates and are currently MAPD...');
  // Pull all currently-MAPD rows for the year; intersect with candidates.
  const allMapd = await prisma.plan.findMany({
    where: { planYear: PLAN_YEAR, planCategory: 'MAPD' },
    select: { id: true, planId: true, state: true, county: true, planName: true, organizationName: true },
  });
  console.log(`  ${allMapd.length.toLocaleString()} MAPD rows in DB for year ${PLAN_YEAR}`);

  const toReclassify = [];
  for (const r of allMapd) {
    const key = `${r.planId}|${r.state}|${r.county}`;
    if (candidates.has(key)) toReclassify.push(r);
  }
  console.log(`  ${toReclassify.length.toLocaleString()} of those match landscape MA-Only signal\n`);

  // Carrier breakdown
  const byOrg = new Map();
  for (const r of toReclassify) {
    byOrg.set(r.organizationName, (byOrg.get(r.organizationName) || 0) + 1);
  }
  console.log('=== Top 15 carriers by reclassification count ===');
  for (const [org, n] of [...byOrg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${String(n).padStart(6)}  ${org}`);
  }

  // Distinct-plan breakdown
  const distinctPlans = new Map();
  for (const r of toReclassify) {
    if (!distinctPlans.has(r.planId)) {
      distinctPlans.set(r.planId, { planId: r.planId, planName: r.planName, organizationName: r.organizationName, rowCount: 0 });
    }
    distinctPlans.get(r.planId).rowCount++;
  }
  console.log(`\n=== ${distinctPlans.size} distinct planIds will reclassify ===`);
  console.log('First 20 by row-count:');
  for (const p of [...distinctPlans.values()].sort((a, b) => b.rowCount - a.rowCount).slice(0, 20)) {
    console.log(`  ${String(p.rowCount).padStart(5)}  ${p.planId}  ${p.organizationName}  ${p.planName}`);
  }

  if (!APPLY) {
    console.log('\n[DRY RUN] No DB writes. Re-run with --apply to perform the update.');
    await prisma.$disconnect();
    return;
  }

  // APPLY mode — bulk update by id
  console.log('\nApplying reclassification...');
  const ids = toReclassify.map((r) => r.id);
  const BATCH = 500;
  let updated = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    const res = await prisma.plan.updateMany({
      where: { id: { in: slice } },
      data: { planCategory: 'MA_ONLY' },
    });
    updated += res.count;
    process.stdout.write(`  ${updated.toLocaleString()}/${ids.length.toLocaleString()}\r`);
  }
  console.log(`\nReclassified ${updated.toLocaleString()} rows from MAPD -> MA_ONLY.`);

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
