// Audit non-shoppable plans across all categories.
//
// 04-28 backlog item #3. The MAPD non-shoppable signature was: ALL of
// emergencyRoomCopay, outpatientHospitalCopay, hospitalStayCopay,
// skilledNursingCopay, catScanCopay are NULL. Yesterday's cleanup deleted
// 421 such MAPDs across licensed states.
//
// This script does the same audit for the remaining categories:
//   - PDP    (Part D drug-only plans)
//   - MA     (MA-Only — same shape as MAPD but no drug benefit)
//   - MMP    (Medicare-Medicaid Plans / dual demos)
//   - COST   (Cost plans)
//   - SNP    (DSNP/CSNP/ISNP — different signature, see below)
//
// Per-category signature:
//   - PDP:        drugDeductible IS NULL AND drugTier1Copay IS NULL AND
//                 drugTier2Copay IS NULL AND monthlyPremium IS NULL
//                 (PDPs don't have hospital data — they're drug-only)
//   - MA / MAPD:  same 5-NULL signature as the 04-27 MAPD cleanup
//   - MMP/COST:   same 5-NULL signature as MA/MAPD
//   - SNP:        legitimately have NULLs (per 04-28 handoff gotcha) — skip the
//                 cost-sharing signature. Use a different one: monthlyPremium IS
//                 NULL AND medicalDeductible IS NULL (suggests a stub row).
//
// Output: scripts/data/non-shoppable-candidates.json
//   { planCategory -> [{ planId, planName, organizationName, state_count }, ...] }
//
// This script ONLY identifies candidates. Verification (hitting medicare.gov's
// plan-compare API) is a separate step and requires an authenticated browser
// session per the 04-28 handoff.
//
// Run: node scripts/audit-non-shoppable.js [--out=<path>]

const path = require('path');
const fs = require('fs');

const { makePrisma } = require('./prisma-client.js');
const LICENSED_STATES = require('./licensed-states.js');

const outArg = process.argv.find(a => a.startsWith('--out='));
const OUT_PATH = outArg
  ? outArg.slice('--out='.length)
  : path.join(__dirname, 'data', 'non-shoppable-candidates.json');

// Only filtering on fields known to be nullable in the schema.
// monthlyPremium and medicalDeductible are non-nullable, so they can't be
// part of a NULL signature.
const SIGNATURES = {
  // MA, MAPD, MMP, COST share the "all 5 cost-sharing NULL" signature.
  // Confirmed working from the 04-27 MAPD cleanup.
  COST_SHARING_5: {
    AND: [
      { emergencyRoomCopay: null },
      { outpatientHospitalCopay: null },
      { hospitalStayCopay: null },
      { skilledNursingCopay: null },
      { catScanCopay: null },
    ],
  },
  // PDP — drug-tier NULL signature (no monthlyPremium since it's non-nullable
  // and $0 PDPs are common legitimate consumer plans).
  PDP_DRUG_NULLS: {
    AND: [
      { drugDeductible: null },
      { drugTier1Copay: null },
      { drugTier2Copay: null },
      { drugTier3Copay: null },
    ],
  },
};

// planCategory enum value -> signature key
// SNPs intentionally skipped: per 04-28 handoff, SNPs (DSNP/CSNP/ISNP) often
// have NULL cost-sharing for legitimate reasons. Different audit needed.
//
// MA (MA-Only) intentionally NOT listed: as of 2026-05-06 there are no
// MA-Only plans in the DB yet (Dale ships only MAPD/SNP/PDP today). Add
// MA: 'COST_SHARING_5' here once MA-Only plans are imported.
const CATEGORY_SIG = {
  PDP:  'PDP_DRUG_NULLS',
  MAPD: 'COST_SHARING_5', // already cleaned 04-27, sanity check should return 0
  MMP:  'COST_SHARING_5',
  COST: 'COST_SHARING_5',
};

(async () => {
  const prisma = makePrisma();
  const out = {};
  const summary = [];

  for (const [category, sigKey] of Object.entries(CATEGORY_SIG)) {
    const sig = SIGNATURES[sigKey];

    try {
      // First: total in licensed states for this category
      const totalDistinct = await prisma.plan.groupBy({
        by: ['planId'],
        where: { planYear: 2026, planCategory: category, state: { in: states() } },
      });

      // Then: candidates matching the signature
      const candidates = await prisma.plan.findMany({
        where: {
          planYear: 2026,
          planCategory: category,
          state: { in: states() },
          ...sig,
        },
        select: { planId: true, planName: true, organizationName: true, state: true },
      });

      // Group by planId
      const byPlanId = {};
      for (const r of candidates) {
        if (!byPlanId[r.planId]) {
          byPlanId[r.planId] = {
            planId: r.planId,
            planName: r.planName,
            organizationName: r.organizationName,
            state_count: 0,
            row_count: 0,
          };
        }
        byPlanId[r.planId].row_count++;
      }
      // state_count is distinct states per plan
      const stateSets = {};
      for (const r of candidates) {
        if (!stateSets[r.planId]) stateSets[r.planId] = new Set();
        stateSets[r.planId].add(r.state);
      }
      for (const [pid, set] of Object.entries(stateSets)) {
        byPlanId[pid].state_count = set.size;
      }

      const distinctCandidates = Object.values(byPlanId);
      out[category] = {
        signature: sigKey,
        total_distinct_plans_in_licensed_states: totalDistinct.length,
        candidates_count: distinctCandidates.length,
        candidate_rows_count: candidates.length,
        candidates: distinctCandidates,
      };
      summary.push({
        category,
        total: totalDistinct.length,
        candidates: distinctCandidates.length,
        rows: candidates.length,
      });
    } catch (err) {
      const msg = err?.message?.split('\n')[0] || String(err);
      console.warn(`[${category}] Skipped — ${msg}`);
      out[category] = { signature: sigKey, error: msg };
      summary.push({ category, total: '—', candidates: 'ERROR', rows: msg.slice(0, 60) });
    }
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2), 'utf8');

  console.log('Non-shoppable audit summary:');
  console.table(summary);
  console.log(`\nFull output: ${OUT_PATH}`);
  console.log('Next step: verify candidates by hitting the medicare.gov plan-compare API');
  console.log('(requires authenticated browser session per 04-28 handoff).');

  await prisma.$disconnect();
})().catch(async (err) => {
  console.error(err);
  process.exit(1);
});

function states() {
  return Array.isArray(LICENSED_STATES)
    ? LICENSED_STATES
    : (LICENSED_STATES.LICENSED_STATES || LICENSED_STATES.default);
}
