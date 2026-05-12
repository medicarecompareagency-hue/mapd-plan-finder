// scripts/import-pbp.js
//
// Imports CMS PBP Benefits 2026 data into Plan rows.
// See PBP-IMPORT-SPEC-2026-04-27.md for the field map and design rationale.
//
// Usage:
//   node scripts/import-pbp.js
//
// Optional env vars:
//   PBP_DIR            — directory holding the unzipped PBP txt files.
//                        Default: ./scripts/data/pbp-2026/
//   PBP_YEAR           — plan year to update. Default: 2026.
//   PBP_DRY_RUN=1      — print what would happen, do not write to DB.
//   PBP_VERBOSE=1      — log every per-plan update.
//
// One-time data prep before running:
//   curl -L -o scripts/data/pbp-benefits-2026.zip https://www.cms.gov/files/zip/pbp-benefits-2026.zip
//   unzip scripts/data/pbp-benefits-2026.zip -d scripts/data/pbp-2026/
//
// Idempotent. Safe to re-run after CMS quarterly refreshes.
//
// 2026-04-27 fix: dental/vision/hearing MAX BENEFIT caps are NOT
// frequency-based; the amount is already per year (per code 3 = per
// benefit period = annual). Do NOT multiply by 4. Only OTC b13b uses
// the frequency-based PERIOD_MULT_OTC mapping (where per=5 means monthly).

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { makePrisma } = require('./prisma-client');

const PBP_DIR  = process.env.PBP_DIR  || path.join(__dirname, 'data', 'pbp-2026');
const PBP_YEAR = parseInt(process.env.PBP_YEAR || '2026', 10);
const DRY_RUN  = process.env.PBP_DRY_RUN === '1';
const VERBOSE  = process.env.PBP_VERBOSE === '1';

// PBP per-codes -> annual multiplier.
// Source: PBP Benefits codebook. Most files use codes 1-5; OTC also uses 5.
//   1 = Per Year         (x1)
//   2 = Per Month        (x12)
//   3 = Per Quarter      (x4)
//   4 = Per 6 Months     (x2)
//   5 = Other / unspecified - for OTC fields plans typically file as
//       "Per Month" so we annualize by 12. For all other fields we
//       fall back to x1 (treat the amount as already annual).
const PERIOD_MULT_DEFAULT = { '1': 1, '2': 12, '3': 4, '4': 2, '5': 1 };
const PERIOD_MULT_OTC     = { '1': 1, '2': 12, '3': 4, '4': 2, '5': 12 };

// Human-readable label for the OTC card filing period. Per code 5 ("other")
// is treated as monthly for OTC (carriers typically file OTC cards as
// monthly even when they pick "other"), matching PERIOD_MULT_OTC.
const PERIOD_LABEL_OTC = {
  '1': 'year', '2': 'month', '3': 'quarter', '4': '6 months',
  '5': 'month', '6': 'episode', '7': 'benefit period',
};

function num(s) {
  if (s == null || s === '') return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function annualize(amt, perCode, mults) {
  const table = mults || PERIOD_MULT_DEFAULT;
  const m = (table[perCode] !== undefined) ? table[perCode] : 1;
  return num(amt) * m;
}

function planIdFor(row) {
  // pbp_a_hnumber = "H0628", pbp_a_plan_identifier = "011" -> "H0628-11"
  const h = row.pbp_a_hnumber;
  const p = parseInt(row.pbp_a_plan_identifier, 10);
  if (!h || Number.isNaN(p)) return null;
  return `${h}-${p}`;
}

// Stream a PBP tab-delimited file, yield row objects keyed by header.
async function* readPbp(file) {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let header = null;
  for await (const line of rl) {
    if (!line) continue;
    const cols = line.split('\t');
    if (!header) {
      header = cols;
      continue;
    }
    const row = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = cols[i] || '';
    yield row;
  }
}

function fileMust(name) {
  const full = path.join(PBP_DIR, name);
  if (!fs.existsSync(full)) {
    console.error(`Missing PBP file: ${full}`);
    console.error(`Set PBP_DIR or run the unzip step from the script header.`);
    process.exit(1);
  }
  return full;
}

// agg: planId -> { otcAllowance, foodCardAllowance, dentalAnnualMax,
//                  visionAnnualMax, hearingAnnualMax }
async function buildAgg() {
  const agg = new Map();
  const upsertMax = (planId, key, value) => {
    if (!planId) return;
    const v = num(value);
    if (v <= 0) return;
    let cur = agg.get(planId);
    if (!cur) {
      cur = { otcAllowance: 0, foodCardAllowance: 0, dentalAnnualMax: 0, visionAnnualMax: 0, hearingAnnualMax: 0, b13cMeal: 0, otcMaxPeriod: null, hearingBenefits: null };
      agg.set(planId, cur);
    }
    if (v > cur[key]) cur[key] = v;
  };

  // ----- OTC + B13c meal fallback -----
  console.log('Reading pbp_b13_other_services.txt ...');
  let n = 0;
  for await (const row of readPbp(fileMust('pbp_b13_other_services.txt'))) {
    const pid = planIdFor(row);
    if (!pid) continue;
    n++;
    // OTC: pbp_b13b_maxplan_amt x period from pbp_b13b_otc_maxplan_per
    const otc = annualize(row.pbp_b13b_maxplan_amt, row.pbp_b13b_otc_maxplan_per, PERIOD_MULT_OTC);
    upsertMax(pid, 'otcAllowance', otc);
    // Capture the period label — the carrier's filed cadence, NOT annualized.
    // Only record when we actually saw an OTC max filed (otherwise the agg
    // will overwrite a useful label with an empty one).
    if (otc > 0) {
      const lbl = PERIOD_LABEL_OTC[row.pbp_b13b_otc_maxplan_per];
      if (lbl) {
        const cur = agg.get(pid);
        if (cur && !cur.otcMaxPeriod) cur.otcMaxPeriod = lbl;
      }
    }
    // Meal fallback: pbp_b13c_maxplan_amt x period from pbp_b13c_maxplan_per
    const meal = annualize(row.pbp_b13c_maxplan_amt, row.pbp_b13c_maxplan_per);
    upsertMax(pid, 'b13cMeal', meal);
  }
  console.log(`  scanned ${n} rows`);

  // ----- Food card (SSBCI primary) -----
  console.log('Reading pbp_b13i_b19b_services_vbid_ssbci.txt ...');
  n = 0;
  for await (const row of readPbp(fileMust('pbp_b13i_b19b_services_vbid_ssbci.txt'))) {
    const pid = planIdFor(row);
    if (!pid) continue;
    n++;
    const fd = annualize(row.pbp_b13i_fd_maxplan_amt, row.pbp_b13i_fd_maxplan_per);
    upsertMax(pid, 'foodCardAllowance', fd);
  }
  console.log(`  scanned ${n} rows`);

  // Apply meal fallback for plans where SSBCI didn't yield a food card.
  for (const [pid, v] of agg) {
    if (v.foodCardAllowance === 0 && v.b13cMeal > 0) {
      v.foodCardAllowance = v.b13cMeal;
    }
    delete v.b13cMeal;
  }

  // ----- Dental annual max -----
  // Use maxplan_* (what the plan pays) not maxenr_* (what the enrollee pays).
  // b16a Medicare-cov dental has no maxplan field, so we skip it.
  // b16b preventive plan max (col 27): ~3,236 plans populated.
  // b16c comprehensive plan max (col 139): ~1,028 plans populated, usually
  // the higher value when present (often $4,000-$10,000).
  console.log('Reading pbp_b16_dental.txt ...');
  n = 0;
  for await (const row of readPbp(fileMust('pbp_b16_dental.txt'))) {
    const pid = planIdFor(row);
    if (!pid) continue;
    n++;
    // per=3 (dominant) means per benefit period = annual. Do not annualize.
    const pv  = num(row.pbp_b16b_maxplan_pv_amt);
    const cmp = num(row.pbp_b16c_maxplan_cmp_amt);
    upsertMax(pid, 'dentalAnnualMax', Math.max(pv, cmp));
  }
  console.log(`  scanned ${n} rows`);

  // ----- Vision annual max -----
  console.log('Reading pbp_b17_eye_exams_wear.txt ...');
  n = 0;
  for await (const row of readPbp(fileMust('pbp_b17_eye_exams_wear.txt'))) {
    const pid = planIdFor(row);
    if (!pid) continue;
    n++;
    // per=3 (dominant) means per benefit period = annual. Do not annualize.
    const comb = num(row.pbp_b17b_comb_maxplan_amt);
    if (comb > 0) {
      upsertMax(pid, 'visionAnnualMax', comb);
    } else {
      const exam = num(row.pbp_b17a_maxenr_amt);
      const indv = ['cl', 'egs', 'egl', 'egf', 'upg']
        .reduce((s, sfx) => s + num(row[`pbp_b17b_indv_maxplan_amt_${sfx}`]), 0);
      upsertMax(pid, 'visionAnnualMax', exam + indv);
    }
  }
  console.log(`  scanned ${n} rows`);

  // ----- Hearing annual max + description -----
  // Carriers file hearing two ways: a maxplan_amt cap (Aetna, UHC) OR
  // a fixed per-aid copay (HealthSpring, Devoted, Humana). The latter
  // was previously dropped on the floor; we now emit a description
  // string so the UI shows "$399-$1800 per aid" instead of "No Hearing".
  console.log('Reading pbp_b18_hearing_exams_aids.txt ...');
  n = 0;
  for await (const row of readPbp(fileMust('pbp_b18_hearing_exams_aids.txt'))) {
    const pid = planIdFor(row);
    if (!pid) continue;
    n++;
    // Annual max path (carrier filed a $/year cap)
    const exams = num(row.pbp_b18a_maxplan_amt);
    const aids  = num(row.pbp_b18b_maxplan_amt);
    upsertMax(pid, 'hearingAnnualMax', Math.max(exams, aids));

    // Copay-based path. Only build a description when annual max is 0
    // (otherwise the $X/yr display wins). Detects b18b copays (hearing
    // aid copay) first, then b18c (fitting/evaluation copay) as fallback.
    if (Math.max(exams, aids) === 0) {
      let desc = null;
      const hasAids = row.pbp_b18b_bendesc_yn === '1';
      if (hasAids && row.pbp_b18b_copay_yn === '1') {
        const min = num(row.pbp_b18b_copay_at_min_amt);
        const max = num(row.pbp_b18b_copay_at_max_amt);
        if (min === 0 && max === 0) {
          desc = '$0 per hearing aid';
        } else if (min === max) {
          desc = `$${min.toLocaleString()} per hearing aid`;
        } else if (min > 0 || max > 0) {
          desc = `$${min.toLocaleString()}-$${max.toLocaleString()} per hearing aid`;
        }
      }
      if (!desc && hasAids && row.pbp_b18c_copay_yn === '1') {
        const c = num(row.pbp_b18c_copay_amt);
        if (c > 0) desc = `$${c.toLocaleString()} fitting copay`;
      }
      if (!desc && hasAids) {
        desc = 'Hearing aid benefit (see plan summary)';
      } else if (!desc && row.pbp_b18a_bendesc_yn === '1') {
        desc = 'Hearing exam covered';
      }
      if (desc) {
        const cur = agg.get(pid);
        if (cur && !cur.hearingBenefits) cur.hearingBenefits = desc;
      }
    }
  }
  console.log(`  scanned ${n} rows`);

  return agg;
}

async function main() {
  console.log(`PBP import - year=${PBP_YEAR} dir=${PBP_DIR} dry=${DRY_RUN}`);
  const agg = await buildAgg();

  // Distribution preview
  const dist = (key) => {
    let zero = 0, low = 0, mid = 0, hi = 0;
    for (const v of agg.values()) {
      const x = v[key];
      if (x === 0) zero++;
      else if (x < 100) low++;
      else if (x < 1000) mid++;
      else hi++;
    }
    return { zero, low, mid, hi };
  };
  console.log('\n=== Aggregate distributions (per planId) ===');
  console.log(`unique planIds aggregated: ${agg.size}`);
  for (const k of ['otcAllowance', 'foodCardAllowance', 'dentalAnnualMax', 'visionAnnualMax', 'hearingAnnualMax']) {
    const d = dist(k);
    console.log(`  ${k.padEnd(20)} 0=${d.zero}  <100=${d.low}  100-999=${d.mid}  1000+=${d.hi}`);
  }

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Skipping DB writes. Sample 5 entries:');
    let i = 0;
    for (const [pid, v] of agg) {
      console.log(`  ${pid}  ${JSON.stringify(v)}`);
      if (++i >= 5) break;
    }
    return;
  }

  console.log('\n=== Writing to DB ===');
  const prisma = makePrisma();
  let updated = 0, missed = 0, plansWritten = 0, processed = 0;
  const total = agg.size;
  const CONCURRENCY = parseInt(process.env.PBP_CONCURRENCY || '10', 10);

  const entries = [...agg.entries()];

  async function writeOne(planId, v) {
    try {
      const data = {
        otcAllowance:      v.otcAllowance,
        foodCardAllowance: v.foodCardAllowance,
        dentalAnnualMax:   v.dentalAnnualMax,
        visionAnnualMax:   v.visionAnnualMax,
        hearingAnnualMax:  v.hearingAnnualMax,
      };
      // Only set otcMaxPeriod / hearingBenefits when we actually computed
      // one — don't blast nulls over existing values.
      if (v.otcMaxPeriod) data.otcMaxPeriod = v.otcMaxPeriod;
      if (v.hearingBenefits) data.hearingBenefits = v.hearingBenefits;
      const r = await prisma.plan.updateMany({
        where: { planId, planYear: PBP_YEAR },
        data,
      });
      if (r.count === 0) {
        missed++;
      } else {
        updated++;
        plansWritten += r.count;
        if (VERBOSE) console.log(`  ok ${planId}  rows=${r.count}  ${JSON.stringify(v)}`);
      }
    } catch (e) {
      console.error(`  fail ${planId} - ${e.message}`);
      missed++;
    } finally {
      processed++;
      if (processed % 100 === 0) {
        console.log(`  progress: ${processed}/${total} planIds  (updated=${updated} missed=${missed} rows=${plansWritten})`);
      }
    }
  }

  // Worker pool: keep CONCURRENCY in flight at any time
  let cursor = 0;
  async function worker() {
    while (cursor < entries.length) {
      const i = cursor++;
      const [planId, v] = entries[i];
      await writeOne(planId, v);
    }
  }
  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);

  console.log(`\nDone. planIds updated: ${updated}, planIds not found in DB: ${missed} (likely non-licensed states), total Plan rows touched: ${plansWritten}.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
