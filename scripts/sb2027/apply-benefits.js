// scripts/sb2027/apply-benefits.js — write the 2027 SB-derived OTC / food-card / wallet values to planYear=2027 rows.
//
//   node scripts/sb2027/apply-benefits.js            # dry-run: rows that would change, per column
//   node scripts/sb2027/apply-benefits.js --apply
//
// Source: scripts/data/sb-benefits-2027.json (build-benefits.js). Each plan-SEGMENT gets only the columns its SB supports;
// columns not named in a proposal are left exactly as they are. One set-based UPDATE. Idempotent. 2026 rows are never touched.
const fs = require('fs'), path = require('path');
const { ROOT, YEAR, num, makePrisma } = require('./lib');
const APPLY = process.argv.includes('--apply');
const COLS = { sbVerifiedOtcAmount: 'float8', sbVerifiedFoodAmount: 'float8', foodCardAllowance: 'float8', ssbciFoodAllowance: 'float8',
  sbVerifiedOtcPeriod: 'text', sbVerifiedFoodPeriod: 'text', foodCardMaxPeriod: 'text', ssbciConditionNote: 'text',
  ssbciIsConditional: 'boolean', ssbciIsStandalone: 'boolean', ssbciOffersFood: 'boolean', ssbciOffersUtilities: 'boolean', ssbciOffersTransportation: 'boolean', ssbciOffersMeals: 'boolean' };
(async () => {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'data', 'sb-benefits-2027.json'), 'utf8'));
  const rows = Object.values(data).map((p) => { for (const k of Object.keys(p.set)) if (!COLS[k]) throw new Error('unknown column ' + k); return { planId: p.planId, seg: String(p.seg), d: p.set }; });
  const payload = JSON.stringify(rows);
  const V = `jsonb_to_recordset($1::jsonb) AS v("planId" text, seg text, d jsonb)`;
  const JOIN = `p."planYear" = ${YEAR} AND p."planId" = v."planId" AND coalesce(p."segmentId", '0') = v.seg`;
  const val = (c) => `(v.d->>'${c}')::${COLS[c]}`;
  const differs = (c) => `(jsonb_exists(v.d, '${c}') AND p."${c}" IS DISTINCT FROM ${val(c)})`;
  const prisma = makePrisma();
  try {
    const counts = num(await prisma.$queryRawUnsafe(
      `SELECT count(*) AS matched_rows, count(DISTINCT (p."planId", coalesce(p."segmentId", '0'))) AS segs,
              ${Object.keys(COLS).map((c) => `count(*) FILTER (WHERE ${differs(c)}) AS "${c}"`).join(', ')}
       FROM "Plan" p JOIN ${V} ON ${JOIN}`, payload))[0];
    console.log(`proposals: ${rows.length} plan-segments -> ${counts.matched_rows} rows in ${counts.segs} plan-segments`);
    console.log('rows that would change, per column:'); for (const c of Object.keys(COLS)) console.log(`  ${c.padEnd(28)} ${counts[c]}`);
    if (counts.segs !== rows.length) console.log(`WARNING: ${rows.length - counts.segs} proposals matched no 2027 row`);
    if (APPLY) {
      const n = await prisma.$executeRawUnsafe(
        `UPDATE "Plan" p SET ${Object.keys(COLS).map((c) => `"${c}" = CASE WHEN jsonb_exists(v.d, '${c}') THEN ${val(c)} ELSE p."${c}" END`).join(', ')}, "updatedAt" = now()
         FROM ${V} WHERE ${JOIN} AND (${Object.keys(COLS).map(differs).join(' OR ')})`, payload);
      console.log(`APPLIED: ${n} rows updated`);
    } else console.log('[dry-run] nothing written. Re-run with --apply.');
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error(e); process.exit(1); });
