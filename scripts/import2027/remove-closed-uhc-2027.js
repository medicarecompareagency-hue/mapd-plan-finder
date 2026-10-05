// scripts/import2027/remove-closed-uhc-2027.js — take UHC D-SNPs that are closed to new members out of the 2027 rows.
//
//   node scripts/import2027/remove-closed-uhc-2027.js            # dry-run
//   node scripts/import2027/remove-closed-uhc-2027.js --apply
//
// Dale's decision 2026-10-05: agents should not see a 2027 plan they cannot sell. Source: UHC's agent portal (mpp.uhc.com),
// "This plan isn't accepting new members starting Jan 1, 2027" on the plan page (also flagged `closed` in scripts/data/uhc-mpp-otc-2027.json).
// planYear is hard-coded to 2027. Every removed row is first saved, whole, to scripts/import2027/removed-closed-uhc-2027-backup.json;
// to undo, re-insert from that file. A 2027 re-import brings these rows back — re-run this script after it.
const fs = require('fs'), path = require('path');
const { makePrisma } = require('../prisma-client');
const APPLY = process.argv.includes('--apply');
const CLOSED = [   // [planId, segment]  ("0" = non-segmented)
  ['H0421-1', '0'], ['H1889-2', '1'], ['H1889-2', '2'], ['H1889-8', '0'], ['H1889-26', '0'], ['H1889-30', '0'], ['H4527-60', '2'], ['R0759-3', '0'],
];
const BACKUP = path.join(__dirname, 'removed-closed-uhc-2027-backup.json');
(async () => {
  const prisma = makePrisma();
  const payload = JSON.stringify(CLOSED.map(([planId, seg]) => ({ planId, seg })));
  const V = `jsonb_to_recordset($1::jsonb) AS v("planId" text, seg text)`;
  const WHERE = `p."planYear" = 2027 AND p."organizationName" = 'UnitedHealthcare' AND EXISTS (SELECT 1 FROM ${V} WHERE v."planId" = p."planId" AND v.seg = coalesce(p."segmentId", '0'))`;
  try {
    const rows = await prisma.$queryRawUnsafe(`SELECT p.* FROM "Plan" p WHERE ${WHERE} ORDER BY p."planId", p."segmentId", p.state, p.county`, payload);
    const by = {}; for (const r of rows) { const k = `${r.planId} seg ${r.segmentId || '0'} — ${r.planName}`; by[k] = (by[k] || 0) + 1; }
    console.log(`2027 rows to remove: ${rows.length}`); for (const [k, n] of Object.entries(by)) console.log(`  ${String(n).padStart(4)}  ${k}`);
    if (!rows.length) { console.log('nothing to do'); return; }
    if (!APPLY) { console.log('[dry-run] nothing removed. Re-run with --apply.'); return; }
    const prev = fs.existsSync(BACKUP) ? JSON.parse(fs.readFileSync(BACKUP, 'utf8')) : [];
    fs.writeFileSync(BACKUP, JSON.stringify(prev.concat(rows), (k, v) => (typeof v === 'bigint' ? Number(v) : v), 1));
    console.log(`backup written: ${path.basename(BACKUP)} (${prev.length + rows.length} rows)`);
    const n = await prisma.$executeRawUnsafe(`DELETE FROM "Plan" p WHERE ${WHERE}`, payload);
    console.log(`REMOVED: ${n} rows`);
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error(e); process.exit(1); });
