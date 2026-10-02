// scripts/sb2027/build-plan-list.js
// Builds the 2027 SB worklist from the CMS CY2027 Landscape (18 licensed states, 6 licensed carriers).
// Output: .cms-import-tmp/sb-2027/plans.json  — one entry per contract-plan-segment.
//   node scripts/sb2027/build-plan-list.js
const fs = require('fs'), path = require('path');
const { parse } = require('csv-parse/sync');
const { LICENSED_STATES } = require('../licensed-states');
const { LICENSED_CARRIERS } = require('../licensed-carriers');
const ROOT = path.join(__dirname, '..', '..');
const CSV = path.join(ROOT, '.cms-import-tmp', 'cy2027-landscape', 'CY2027_Landscape_202609.csv');
const OUT = path.join(ROOT, '.cms-import-tmp', 'sb-2027', 'plans.json');
const ST = new Set(LICENSED_STATES);
const norm = (n) => (n === 'Cigna' || n === 'Cigna Healthcare') ? 'HealthSpring' : n;
const CAR = new Set(LICENSED_CARRIERS);
const rows = parse(fs.readFileSync(CSV), { columns: true, bom: true, skip_empty_lines: true, relax_column_count: true });
const m = new Map();
for (const r of rows) {
  if (r['Contract Category Type'] === 'PDP') continue;
  const st = r['State Territory Abbreviation']; if (!ST.has(st)) continue;
  const carrier = norm(r['Organization Marketing Name']); if (!CAR.has(carrier)) continue;
  const contract = r['Contract ID'], plan3 = String(r['Plan ID']).padStart(3, '0'), seg = String(r['Segment ID'] || '0');
  const key = contract + '-' + plan3 + '-' + seg;
  let e = m.get(key);
  if (!e) { e = { key, contract, plan3, seg, planId: contract + '-' + parseInt(plan3, 10), carrier, planName: r['Plan Name'], planType: r['Plan Type'], snpType: r['SNP Type'], partD: r['Part D Coverage Indicator'], states: [], counties: 0 }; m.set(key, e); }
  if (!e.states.includes(st)) e.states.push(st);
  e.counties++;
}
const list = [...m.values()].sort((a, b) => a.key.localeCompare(b.key));
// mark segmented plans
const segs = {}; for (const e of list) (segs[e.planId] = segs[e.planId] || []).push(e.seg);
for (const e of list) e.segmented = segs[e.planId].length > 1 || e.seg !== '0';
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(list, null, 1));
const by = {}; for (const e of list) { by[e.carrier] = by[e.carrier] || { keys: 0, planIds: new Set(), seg: 0 }; by[e.carrier].keys++; by[e.carrier].planIds.add(e.planId); if (e.segmented) by[e.carrier].seg++; }
for (const [c, v] of Object.entries(by)) console.log(c.padEnd(18), 'plan-segments', v.keys, 'planIds', v.planIds.size, 'segmented-keys', v.seg);
console.log('total plan-segments', list.length, 'planIds', new Set(list.map(e => e.planId)).size);
