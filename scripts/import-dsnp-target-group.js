/**
 * import-dsnp-target-group.js
 *
 * Pulls the CMS Plan Benefit Package (PBP) zip for a given plan year, extracts
 * pbp_Section_A.txt, and assigns each DSNP a 2-bucket target group:
 *
 *   FULL_DUAL    -> plan has $0 Medicare cost-sharing on A/B benefits.
 *                   Designed for: FBDE, QMB+, SLMB+. Putting a partial dual
 *                   here means they owe cost-sharing the plan assumes Medicaid
 *                   covers — bad outcome.
 *   PARTIAL_DUAL -> plan has Medicare cost-sharing. Accepts/designed for
 *                   QMB-only, SLMB-only, QI-1.
 *
 * This is the most granular dual-category targeting CMS publishes since
 * they discontinued DSNP "subtype" classification in 2015. For finer 6-way
 * QMB+/SLMB+/FBDE vs QMB/SLMB/QI-1 distinction, would need to scrape per-plan
 * Summary of Benefits PDFs (separate effort).
 *
 * Usage:
 *   node scripts/import-dsnp-target-group.js                    # year=2026
 *   node scripts/import-dsnp-target-group.js --year=2027        # next year
 *   node scripts/import-dsnp-target-group.js --zip=/path/to/pbp-benefits-2026.zip  # local file
 *   node scripts/import-dsnp-target-group.js --dry-run          # show counts, don't write
 *
 * Source: https://www.cms.gov/files/zip/pbp-benefits-{YEAR}.zip
 * Refresh cadence: CMS updates the PBP zip quarterly. New plan year drops
 * around Oct 1 (e.g., pbp-benefits-2027.zip becomes available Oct 2026 for AEP).
 *
 * Prerequisites:
 *   - Plan model needs a new column: dsnpTargetGroup (enum: FULL_DUAL | PARTIAL_DUAL | null)
 *   - See SCHEMA-MIGRATION-NOTES at bottom of this file for the migration.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const { makePrisma } = require('./prisma-client');

// --- CLI args ---
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, v] = a.replace(/^--/, '').split('=');
      return [k, v ?? true];
    })
);
const YEAR = parseInt(args.year || '2026', 10);
const DRY_RUN = !!args['dry-run'];
const LOCAL_ZIP = args.zip;

const TMP_DIR = path.join(__dirname, '.tmp-pbp');
const ZIP_PATH = LOCAL_ZIP || path.join(TMP_DIR, `pbp-benefits-${YEAR}.zip`);
const SECTION_A_TXT = path.join(TMP_DIR, 'pbp_Section_A.txt');

// --- helpers ---

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const req = https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    });
    req.on('error', reject);
  });
}

function unzipSectionA(zipPath, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  // Use built-in unzip on the platform.
  // Windows: tar (built into Win10+) handles zip files: `tar -xf file.zip`
  // Posix: unzip
  const isWin = process.platform === 'win32';
  if (isWin) {
    execSync(`tar -xf "${zipPath}" -C "${outDir}" pbp_Section_A.txt`, { stdio: 'inherit' });
  } else {
    execSync(`unzip -o "${zipPath}" pbp_Section_A.txt -d "${outDir}"`, { stdio: 'inherit' });
  }
}

// pbp_Section_A.txt is tab-delimited. Header on row 1.
// Columns we use (1-indexed for awk readability; 0-indexed in JS below):
//   1  pbp_a_hnumber                  (e.g., "H9955")
//   2  pbp_a_plan_identifier          (e.g., "007", zero-padded to 3)
//   3  segment_id                     (e.g., "0")
//   34 pbp_a_special_need_plan_type   ("3" = DSNP)
//   36 pbp_a_dsnp_zerodollar          ("1" = zero-dollar / FULL_DUAL,
//                                       "2" = has cost-sharing / PARTIAL_DUAL)
function parsePbpSectionA(txtPath) {
  const lines = fs.readFileSync(txtPath, 'utf8').split(/\r?\n/);
  const header = lines[0].split('\t');
  const idxHNumber = header.indexOf('pbp_a_hnumber');
  const idxPlanId = header.indexOf('pbp_a_plan_identifier');
  const idxSegment = header.indexOf('segment_id');
  const idxSnpType = header.indexOf('pbp_a_special_need_plan_type');
  const idxZeroDollar = header.indexOf('pbp_a_dsnp_zerodollar');

  for (const [name, idx] of [
    ['pbp_a_hnumber', idxHNumber],
    ['pbp_a_plan_identifier', idxPlanId],
    ['segment_id', idxSegment],
    ['pbp_a_special_need_plan_type', idxSnpType],
    ['pbp_a_dsnp_zerodollar', idxZeroDollar],
  ]) {
    if (idx === -1) throw new Error(`Column ${name} not found in PBP Section A header`);
  }

  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cols = line.split('\t');
    const snpType = cols[idxSnpType];
    if (snpType !== '3') continue; // only DSNPs

    const hnumber = cols[idxHNumber];
    const planId = cols[idxPlanId];
    const segment = cols[idxSegment];
    const zeroDollar = cols[idxZeroDollar];

    let group;
    if (zeroDollar === '1') group = 'FULL_DUAL';
    else if (zeroDollar === '2') group = 'PARTIAL_DUAL';
    else continue; // missing/unknown

    // Plan ID in DB is "{contract}-{int(planId)}" — drop leading zeros from plan_id.
    // e.g., PBP "007" -> DB "7"; PBP "226" -> DB "226".
    const dbPlanId = `${hnumber}-${parseInt(planId, 10)}`;
    out.push({ planId: dbPlanId, segment, group, source: { hnumber, pbpPlanId: planId, segment, zeroDollar } });
  }
  return out;
}

async function main() {
  console.log(`PBP DSNP target-group import — plan year ${YEAR}${DRY_RUN ? ' (dry run)' : ''}`);

  // 1. Get the PBP zip
  if (!LOCAL_ZIP) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    if (!fs.existsSync(ZIP_PATH)) {
      const url = `https://www.cms.gov/files/zip/pbp-benefits-${YEAR}.zip`;
      console.log(`Downloading ${url}`);
      await download(url, ZIP_PATH);
    } else {
      console.log(`Using cached ${ZIP_PATH}`);
    }
  } else {
    console.log(`Using local zip ${LOCAL_ZIP}`);
  }

  // 2. Extract Section A
  if (!fs.existsSync(SECTION_A_TXT) || LOCAL_ZIP) {
    console.log('Extracting pbp_Section_A.txt');
    unzipSectionA(ZIP_PATH, TMP_DIR);
  }

  // 3. Parse
  const records = parsePbpSectionA(SECTION_A_TXT);
  const counts = records.reduce((acc, r) => { acc[r.group] = (acc[r.group] || 0) + 1; return acc; }, {});
  console.log(`Parsed ${records.length} DSNP rows from PBP Section A:`, counts);

  // Distinct planIds (drop segment for DB matching)
  const byPlanId = {};
  for (const r of records) {
    // Conflict resolution: if same planId appears with both groups across segments, take FULL_DUAL
    // (rare; conservative since putting a partial dual on a full-targeted plan is the dangerous case).
    const prev = byPlanId[r.planId];
    if (!prev) byPlanId[r.planId] = r.group;
    else if (prev !== r.group) byPlanId[r.planId] = 'FULL_DUAL';
  }
  console.log(`Distinct DSNP planIds: ${Object.keys(byPlanId).length}`);

  if (DRY_RUN) {
    // Show 10 samples
    const samples = Object.entries(byPlanId).slice(0, 10);
    console.log('Sample assignments:', samples);
    console.log('Dry run — no DB writes.');
    return;
  }

  // 4. Apply to DB
  const prisma = makePrisma();
  let totalRows = 0;
  let unmatched = 0;
  const byGroup = { FULL_DUAL: 0, PARTIAL_DUAL: 0 };
  for (const [planId, group] of Object.entries(byPlanId)) {
    const r = await prisma.plan.updateMany({
      where: { planId, planYear: YEAR, planCategory: 'DSNP' },
      data: { dsnpTargetGroup: group },
    });
    if (r.count === 0) {
      unmatched++;
    } else {
      totalRows += r.count;
      byGroup[group] += r.count;
    }
  }
  console.log(`Applied to ${totalRows} DB rows total:`, byGroup);
  console.log(`Unmatched planIds (not in DB or not DSNP): ${unmatched}`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });

/* ============================================================================
   SCHEMA MIGRATION NOTES — apply BEFORE running this script.
   ============================================================================
   In prisma/schema.prisma, add the enum and field:

     enum DsnpTargetGroup {
       FULL_DUAL      // dsnp_zerodollar=1 in PBP. Designed for FBDE, QMB+, SLMB+.
       PARTIAL_DUAL   // dsnp_zerodollar=2 in PBP. Accepts/designed for QMB, SLMB, QI-1.
     }

     model Plan {
       // ...existing fields...
       dsnpTargetGroup  DsnpTargetGroup?   // null for non-DSNP plans
     }

   Then run:
     npx prisma migrate dev --name add_dsnp_target_group
     npx prisma generate

   Then run this script:
     node scripts/import-dsnp-target-group.js
   ============================================================================
*/
