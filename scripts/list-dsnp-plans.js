// Rebuild the dsnp-plans.json list from the live DB.
// Lives in the repo at scripts/list-dsnp-plans.js. Run with:
//   node scripts/list-dsnp-plans.js
//
// Output path defaults to scripts/data/dsnp-plans.json — override with --out=<path>.

const path = require('path');
const fs = require('fs');

const { makePrisma } = require('./prisma-client.js');
const LICENSED_STATES = require('./licensed-states.js');

const outArg = process.argv.find(a => a.startsWith('--out='));
const OUT_PATH = outArg
  ? outArg.slice('--out='.length)
  : path.join(__dirname, 'data', 'dsnp-plans.json');

(async () => {
  const prisma = makePrisma();

  // Licensed-states list might be exported as either an array or { LICENSED_STATES: [...] }.
  const states = Array.isArray(LICENSED_STATES)
    ? LICENSED_STATES
    : (LICENSED_STATES.LICENSED_STATES || LICENSED_STATES.default);

  // Pull every 2026 DSNP row in licensed states, then dedupe by planId in JS.
  // (Prisma `distinct` requires Postgres DISTINCT ON which the pooler can be flaky on.)
  const rows = await prisma.plan.findMany({
    where: {
      planYear: 2026,
      planCategory: 'DSNP',
      state: { in: states },
    },
    select: {
      planId: true,
      organizationName: true,
      planName: true,
    },
  });

  // Sample one row so we can SEE the planId format before parsing.
  if (rows.length === 0) {
    console.error('No DSNP rows found — aborting.');
    await prisma.$disconnect();
    process.exit(1);
  }
  console.log('Sample planId values:');
  for (const r of rows.slice(0, 5)) {
    console.log(`  planId=${JSON.stringify(r.planId)} planName=${JSON.stringify(r.planName)}`);
  }

  // Common CMS planId formats we'll handle:
  //   "H1036-226"        → contract=H1036, plan=226, segment=0
  //   "H1036-226-0"      → contract=H1036, plan=226, segment=0
  //   "H1036226"         → contract=H1036, plan=226, segment=0
  //   "H1036-226-001"    → contract=H1036, plan=226, segment=1
  function parsePlanId(pid) {
    if (!pid) return null;
    const s = String(pid).trim();
    // Format A: H1036-226 or H1036-226-0
    let m = s.match(/^([A-Z]\d{4})[-_](\d{1,3})(?:[-_](\d{1,3}))?$/i);
    if (m) {
      return {
        contract: m[1].toUpperCase(),
        plan: m[2].padStart(3, '0'),
        segment: m[3] ? String(parseInt(m[3], 10)) : '0',
      };
    }
    // Format B: H1036226 (no separators)
    m = s.match(/^([A-Z]\d{4})(\d{3})$/i);
    if (m) {
      return { contract: m[1].toUpperCase(), plan: m[2], segment: '0' };
    }
    return null;
  }

  const seen = new Set();
  const plans = [];
  let unparsed = 0;
  for (const r of rows) {
    if (seen.has(r.planId)) continue;
    seen.add(r.planId);
    const parts = parsePlanId(r.planId);
    if (!parts) {
      unparsed++;
      continue;
    }
    plans.push({
      planId: r.planId,
      contract: parts.contract,
      plan: parts.plan,
      segment: parts.segment,
      organizationName: r.organizationName,
      planName: r.planName,
    });
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(plans, null, 2), 'utf8');
  console.log(`Wrote ${plans.length} distinct DSNPs to ${OUT_PATH}`);
  console.log(`Source rows: ${rows.length}`);
  console.log(`Unparsed planIds: ${unparsed}`);

  await prisma.$disconnect();
})().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
