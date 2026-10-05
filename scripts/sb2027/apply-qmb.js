// scripts/sb2027/apply-qmb.js — write the 2027 QMB cost-share-protection classification to planYear=2027 rows.
//
//   node scripts/sb2027/apply-qmb.js            # dry-run
//   node scripts/sb2027/apply-qmb.js --apply
//
// Source: scripts/data/qmb-protection-2027.json (classify-qmb.py + merge-uhc-mpp-qmb.py), keyed by plan-SEGMENT.
// Each row gets its own segment's answer. Entries with protected:null are skipped (the row stays NULL = hidden from a
// plain-QMB search, which is the fail-safe). planYear is hard-coded to 2027; 2026 rows are never read or written.
// One set-based UPDATE. Idempotent.
const fs = require('fs'), path = require('path');
const { makePrisma } = require('../prisma-client');
const YEAR = 2027, APPLY = process.argv.includes('--apply');
const num = (r) => JSON.parse(JSON.stringify(r, (k, v) => (typeof v === 'bigint' ? Number(v) : v)));
(async () => {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'qmb-protection-2027.json'), 'utf8'));
  const entries = Object.values(data).filter((v) => v.protected === true || v.protected === false)
    .map((v) => ({ planId: v.planId, seg: String(v.seg), prot: v.protected, levels: (v.levels || []).join(',') || null }));
  console.log(`classification file: ${Object.keys(data).length} plan-segments, ${entries.length} with an answer (${entries.filter((e) => e.prot).length} show / ${entries.filter((e) => !e.prot).length} hide)`);
  const prisma = makePrisma();
  const payload = JSON.stringify(entries);
  const V = `jsonb_to_recordset($1::jsonb) AS v("planId" text, seg text, prot boolean, levels text)`;
  const JOIN = `p."planYear" = ${YEAR} AND p."planId" = v."planId" AND coalesce(p."segmentId", '0') = v.seg`;
  const DIFF = `(p."qmbCostShareProtected" IS DISTINCT FROM v.prot OR p."costShareProtectedLevels" IS DISTINCT FROM v.levels)`;
  try {
    const m = num(await prisma.$queryRawUnsafe(
      `SELECT count(*) AS rows, count(DISTINCT (p."planId", coalesce(p."segmentId", '0'))) AS segs, count(*) FILTER (WHERE ${DIFF}) AS to_change,
              count(*) FILTER (WHERE p."planCategory" <> 'DSNP') AS non_dsnp
       FROM "Plan" p JOIN ${V} ON ${JOIN}`, payload))[0];
    const orphans = num(await prisma.$queryRawUnsafe(`SELECT v."planId", v.seg FROM ${V} WHERE NOT EXISTS (SELECT 1 FROM "Plan" p WHERE ${JOIN})`, payload));
    console.log(`matches ${m.rows} rows in ${m.segs} plan-segments; ${m.to_change} would change; non-DSNP rows matched: ${m.non_dsnp}; entries with no 2027 row: ${orphans.length}`);
    if (m.non_dsnp > 0) { console.log('refusing: classification matched non-DSNP rows'); process.exit(1); }
    if (APPLY) {
      const n = await prisma.$executeRawUnsafe(
        `UPDATE "Plan" p SET "qmbCostShareProtected" = v.prot, "costShareProtectedLevels" = v.levels, "updatedAt" = now() FROM ${V} WHERE ${JOIN} AND ${DIFF}`, payload);
      console.log(`APPLIED: ${n} rows updated`);
    } else console.log('[dry-run] nothing written. Re-run with --apply.');
    const rep = num(await prisma.$queryRawUnsafe(
      `SELECT "dsnpTargetGroup" AS grp, "qmbCostShareProtected" AS prot, count(DISTINCT "planId") AS plans, count(*) AS rows
       FROM "Plan" WHERE "planYear" = ${YEAR} AND "planCategory" = 'DSNP' GROUP BY 1, 2 ORDER BY 1, 2`));
    console.log('2027 D-SNP rows now (target group / protected / plan IDs / rows):');
    for (const r of rep) console.log(`  ${String(r.grp).padEnd(13)} ${String(r.prot).padEnd(6)} ${String(r.plans).padStart(4)} ${String(r.rows).padStart(6)}`);
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error(e); process.exit(1); });
