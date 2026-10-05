// scripts/import2027/pbp-by-segment.js — makes the import-pbp.js columns right per plan-SEGMENT for 2027.
//
//   node scripts/import2027/pbp-by-segment.js            # dry-run
//   node scripts/import2027/pbp-by-segment.js --apply
//
// Why: import-pbp.js aggregates by plan ID and keeps the highest value across a plan's segments, so every
// segment of a segmented plan shows the richest segment's OTC, food card, dental, vision and hearing amounts.
// This script recomputes the same columns with the same code (buildAgg from import-pbp.js) keyed by
// plan-segment, and corrects a row only when it still holds the plan-level value the import wrote.
// A value changed since the import (for example by an SB-based step) is left alone and counted.
//
// Run after import-pbp.js and backfill-segment-ids.js. 2027 rows only. One set-based UPDATE per column.
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const YEAR = 2027;
process.env.PBP_DIR = process.env.PBP_DIR || path.join(ROOT, '.cms-import-tmp', `pbp-${YEAR}`);
process.env.PBP_YEAR = String(YEAR);
const { buildAgg, planIdFor } = require('../import-pbp');
const { makePrisma } = require('../prisma-client');
const APPLY = process.argv.includes('--apply');

const NUM = ['otcAllowance', 'foodCardAllowance', 'dentalAnnualMax', 'visionAnnualMax', 'hearingAnnualMax'];
const TXT = ['otcMaxPeriod', 'foodCardMaxPeriod', 'hearingBenefits'];
const same = (a, b) => (a == null && b == null) || (a != null && b != null && (typeof a === 'number' || typeof b === 'number' ? Number(a) === Number(b) : a === b));

(async () => {
  const quiet = console.log; console.log = () => {};
  const planAgg = await buildAgg();
  const segAgg = await buildAgg((row) => { const id = planIdFor(row); return id ? `${id}|${parseInt(row.segment_id || '0', 10) || 0}` : null; });
  console.log = quiet;
  const prisma = makePrisma();
  const sel = [...NUM, ...TXT].map((c) => `min("${c}"::text) "${c}_a", max("${c}"::text) "${c}_b", count("${c}")::int "${c}_n"`).join(', ');
  const db = await prisma.$queryRawUnsafe(`select "planId", "segmentId" seg, min("organizationName") org, count(*)::int n, ${sel}
      from "Plan" where "planYear" = ${YEAR} and "segmentId" is not null group by 1,2 order by 1,2`);
  console.log(`${db.length} segmented plan-segments in ${YEAR} (${new Set(db.map((r) => r.planId)).size} plans).`);
  const changes = {}; const skipped = {}; const examples = {};
  for (const c of [...NUM, ...TXT]) { changes[c] = []; skipped[c] = 0; examples[c] = []; }
  for (const r of db) {
    const P = planAgg.get(r.planId); if (!P) continue;
    const S = segAgg.get(`${r.planId}|${parseInt(r.seg, 10) || 0}`) || {};
    for (const c of [...NUM, ...TXT]) {
      const isNum = NUM.includes(c);
      const pv = isNum ? (P[c] || 0) : (P[c] || null);
      const sv = isNum ? (S[c] || 0) : (S[c] || null);
      if (same(pv, sv)) continue;
      // text columns: the import never writes an empty value, so "no value at plan level" means it wrote nothing
      if (!isNum && pv == null) continue;
      const uniform = r[c + '_a'] === r[c + '_b'] && (r[c + '_n'] === 0 || r[c + '_n'] === r.n);
      const cur = r[c + '_a'] == null ? null : (isNum ? Number(r[c + '_a']) : r[c + '_a']);
      if (!uniform || !same(cur, pv)) { skipped[c]++; continue; }
      changes[c].push({ planId: r.planId, seg: r.seg, old: pv, val: sv, rows: r.n });
      if (examples[c].length < 4) examples[c].push(`${r.planId} seg ${r.seg} (${r.org.slice(0, 12)}): ${pv} -> ${sv}`);
    }
  }
  let total = 0;
  for (const c of [...NUM, ...TXT]) {
    const rows = changes[c].reduce((a, x) => a + x.rows, 0);
    console.log(`  ${c.padEnd(20)} ${String(changes[c].length).padStart(3)} plan-segments ${String(rows).padStart(5)} rows to correct | ${skipped[c]} left alone (changed since import)`);
    for (const e of examples[c]) console.log('       ' + e);
    if (APPLY && changes[c].length) {
      const isNum = NUM.includes(c);
      const n = await prisma.$executeRawUnsafe(
        `UPDATE "Plan" p SET "${c}" = v.val, "updatedAt" = now()
           FROM jsonb_to_recordset($1::jsonb) AS v("planId" text, seg text, old ${isNum ? 'double precision' : 'text'}, val ${isNum ? 'double precision' : 'text'})
          WHERE p."planYear" = ${YEAR} AND p."planId" = v."planId" AND p."segmentId" = v.seg AND p."${c}" IS NOT DISTINCT FROM v.old`,
        JSON.stringify(changes[c]));
      total += Number(n);
      console.log(`       rows written: ${n}`);
    }
  }
  console.log(APPLY ? `Done. ${total} column-rows written.` : 'Dry-run. Re-run with --apply to write.');
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
