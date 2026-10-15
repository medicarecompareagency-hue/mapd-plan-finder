// scripts/commission/apply-noncommissionable.js — flag 2027 plan-segments the carrier pays no commission on.
//
//   node scripts/commission/apply-noncommissionable.js            # dry-run
//   node scripts/commission/apply-noncommissionable.js --apply    # ensure column, write flags
//
// Source: scripts/data/noncommissionable-2027.json (one entry per carrier list line: planId, seg (0 = all segments),
// state, counties (null = whole state)). Dale's decision 2026-10-15: agents should not see a plan they can't be paid on,
// so /api/plans filters nonCommissionable = false. Scope: planYear 2027 rows of the carriers named in `sources`;
// rows of those carriers NOT in the list are reset to false, other carriers / years are never touched. Idempotent.
// A 2027 re-import (delete-and-reload) wipes the column — re-run this after one (listed in reapply-sb-truth.js).
const fs = require('fs'), path = require('path');
const { makePrisma } = require('../prisma-client');
const APPLY = process.argv.includes('--apply');
const REC = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'noncommissionable-2027.json'), 'utf8'));
const YEAR = REC.planYear, carriers = Object.keys(REC.sources);
const norm = (s) => String(s || '').toLowerCase().replace(/\s+(county|parish|city)$/,'').replace(/[^a-z]/g, '');
(async () => {
  const p = makePrisma();
  if (APPLY) await p.$executeRawUnsafe(`ALTER TABLE "Plan" ADD COLUMN IF NOT EXISTS "nonCommissionable" BOOLEAN NOT NULL DEFAULT false`);
  const hasCol = (await p.$queryRawUnsafe(`select 1 from information_schema.columns where table_name='Plan' and column_name='nonCommissionable'`)).length > 0;
  const rows = await p.$queryRawUnsafe(`select id, "planId", "segmentId", state, county, "organizationName" o${hasCol ? ', "nonCommissionable" nc' : ''} from "Plan" where "planYear"=${YEAR} and "organizationName" in (${carriers.map(c => `'${c}'`).join(',')})`);
  const flag = new Set();
  const perEntry = [];
  for (const e of REC.entries) {
    const cset = e.counties ? new Set(e.counties.map(norm)) : null;
    const m = rows.filter(r => r.o === e.carrier && r.planId === e.planId && r.state === e.state && (e.seg === 0 || Number(r.segmentId || 0) === e.seg) && (!cset || cset.has(norm(r.county))));
    m.forEach(r => flag.add(r.id)); perEntry.push({ ...e, rows: m.length });
  }
  const miss = perEntry.filter(x => x.rows === 0);
  const toTrue = rows.filter(r => flag.has(r.id) && !r.nc).map(r => r.id);
  const toFalse = rows.filter(r => !flag.has(r.id) && r.nc).map(r => r.id);
  const byCarrier = {};
  for (const r of rows) { const b = byCarrier[r.o] ||= { rows: 0, flagged: 0, segs: new Set() }; b.rows++; if (flag.has(r.id)) { b.flagged++; b.segs.add(r.planId + '/' + (r.segmentId || 0)); } }
  for (const [c, b] of Object.entries(byCarrier)) console.log(`${c}: ${b.segs.size} plan-segments, ${b.flagged} of ${b.rows} ${YEAR} rows non-commissionable (${(100 * b.flagged / b.rows).toFixed(1)}%)`);
  console.log(`entries ${REC.entries.length}, matching no row: ${miss.length}`, miss.slice(0, 10).map(x => `${x.planId}-s${x.seg} ${x.state}`));
  console.log(`would set true: ${toTrue.length} rows; reset to false: ${toFalse.length} rows`);
  if (!APPLY) { console.log('[dry-run] nothing written. Re-run with --apply.'); await p.$disconnect(); return; }
  let n = 0;
  for (const [val, ids] of [[true, toTrue], [false, toFalse]]) for (let i = 0; i < ids.length; i += 2000) {
    n += await p.$executeRawUnsafe(`update "Plan" set "nonCommissionable"=${val} where id in (${ids.slice(i, i + 2000).map(x => `'${x}'`).join(',')})`);
  }
  console.log(`APPLIED: ${n} rows updated`);
  await p.$disconnect();
})().catch(e => { console.error('ERR', e.message.slice(0, 500)); process.exit(1); });
