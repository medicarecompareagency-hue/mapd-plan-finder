// scripts/sb2027/fix-mri.js — MRI / CT cost share for 2027, per plan-SEGMENT.
//
//   python3 scripts/sb2027/mri-from-sb.py     # reads every 2027 SB -> scripts/data/mri-sb-2027.json (no DB)
//   node scripts/sb2027/fix-mri.js            # dry-run
//   node scripts/sb2027/fix-mri.js --apply
//
// Replaces, for 2027, the three 2026 steps rederive-mri-cat-copay.js + audit-mri-copay-outliers.js +
// fix-mri-outpatient-from-sb.js. Differences from those:
//   * per plan-SEGMENT. The 2026 scripts key by plan ID and keep the highest value across segments.
//   * it does not wipe the D-SNP full-dual $0 (rederive-mri-cat-copay.js does).
//   * every 2027 SB is read, not only the outliers.
//
// Rules, in order:
//   CMS value (PBP b8b "diagnostic radiology services", this segment): the copay (top of the filed range),
//     else the coinsurance (top of the filed range). The low end of a range is a carve-out (mammogram, EKG).
//   SB wins over CMS when it states a cost share: the OUTPATIENT HOSPITAL amount when the SB lists imaging by
//     place of service (Dale's rule, 2026-07-06), else its one flat amount.
//   D-SNP: the SB shows what a member with Medicaid pays. For a FULL_DUAL plan an SB "$0" is stored as a $0
//     copay (the coinsurance % stays underneath, as in 2026). For any other D-SNP an SB "$0" is ignored and the
//     plan keeps the CMS-filed cost share, unless the SB has a "Without Medicaid cost share assistance" column.
//   A non-D-SNP SB that says $0 / 0% while CMS files a real cost share is not applied; it is listed for review.
//
// Writes mriCopay, catScanCopay, mriCoinsPct, catScanCoinsPct. One set-based UPDATE. 2027 rows only.
// The applied change list, with the SB sentence behind each SB-based value, is kept in scripts/data/mri-fixes-2027.json.
const fs = require('fs'), path = require('path');
const { num, keyOf, updateBySegment, makePrisma, YEAR, ROOT } = require('./lib');
const APPLY = process.argv.includes('--apply');
const PBP_FILE = path.join(ROOT, '.cms-import-tmp', `pbp-${YEAR}`, 'pbp_b8_clin_diag_ther.txt');
const SB_FILE = path.join(ROOT, 'scripts', 'data', 'mri-sb-2027.json');
const OUT_FILE = path.join(ROOT, 'scripts', 'data', 'mri-fixes-2027.json');

const f = (s) => { const t = String(s == null ? '' : s).trim(); if (!t) return null; const v = parseFloat(t.replace(/,/g, '')); return Number.isFinite(v) ? v : null; };

function loadPbp() {
  const lines = fs.readFileSync(PBP_FILE, 'latin1').replace(/\r\n/g, '\n').split('\n');
  const H = lines[0].split('\t');
  const col = (n) => { const i = H.indexOf(n); if (i < 0) throw new Error('PBP column missing: ' + n); return i; };
  const c = { h: col('pbp_a_hnumber'), p: col('pbp_a_plan_identifier'), s: col('segment_id'), cy: col('pbp_b8b_copay_yn'), mn: col('pbp_b8b_copay_amt_drs'),
    mx: col('pbp_b8b_copay_amt_drs_max'), oy: col('pbp_b8b_coins_yn'), om: col('pbp_b8b_coins_pct_drs_max') };
  const m = new Map();
  for (let i = 1; i < lines.length; i++) {
    const r = lines[i].split('\t');
    const h = (r[c.h] || '').trim(), p = (r[c.p] || '').trim();
    if (!h || !p) continue;
    const key = `${h}-${p.padStart(3, '0')}-${parseInt(r[c.s] || '0', 10) || 0}`;
    let copay = null, coins = null;
    if ((r[c.cy] || '').trim() === '1') { const v = [f(r[c.mn]), f(r[c.mx])].filter((x) => x != null); if (v.length) copay = Math.max(...v); }
    if (copay == null && (r[c.oy] || '').trim() === '1') coins = f(r[c.om]);
    m.set(key, { copay, coins });
  }
  return m;
}

function decide(P, S, cat, tg, cur) {
  const base = P.copay != null ? { copay: P.copay, coins: null } : { copay: null, coins: P.coins };
  const sbZero = S && ((S.kind === 'copay' && S.value === 0) || (S.kind === 'coins' && S.value === 0));
  const sbPos = S && ((S.kind === 'copay' && S.value > 0) || (S.kind === 'coins' && S.value > 0));
  const fromSb = () => (S.kind === 'copay' ? { copay: S.value, coins: null } : { copay: null, coins: S.value });
  if (cat === 'DSNP' && tg === 'FULL_DUAL') {
    if (sbPos && S.kind === 'copay') return { ...fromSb(), rule: 'SB' };
    if (sbZero) return { copay: 0, coins: P.copay == null ? P.coins : null, rule: 'FULL-DUAL-SB-$0' };
    // no SB statement: keep the full-dual $0 the import set over a coinsurance, refresh the % underneath
    if (P.copay == null) return { copay: cur.copay === 0 ? 0 : null, coins: P.coins, rule: 'CMS' };
    return { ...base, rule: 'CMS' };
  }
  if (cat === 'DSNP') {
    if (S && /without-medicaid/.test(S.basis || '') && S.kind !== 'none') return { ...fromSb(), rule: 'SB-WITHOUT-MEDICAID' };
    if (sbPos && S.kind === 'copay') return { ...fromSb(), rule: 'SB' };
    return { ...base, rule: 'CMS' };
  }
  if (sbPos) return { ...fromSb(), rule: 'SB' };
  if (sbZero) {
    const cmsReal = (P.copay != null && P.copay > 0) || (P.copay == null && P.coins != null && P.coins > 0);
    if (cmsReal) return { ...base, rule: 'CMS', review: 'SB says $0, CMS files a cost share' };
    return { copay: 0, coins: null, rule: 'SB' };
  }
  return { ...base, rule: 'CMS' };
}

(async () => {
  const prisma = makePrisma();
  const pbp = loadPbp();
  const sb = JSON.parse(fs.readFileSync(SB_FILE, 'utf8'));
  const db = num(await prisma.$queryRawUnsafe(`select "planId", coalesce("segmentId",'0') seg, min("planCategory"::text) cat, min("dsnpTargetGroup"::text) tg,
      min("organizationName") org, count(*)::int n, min("mriCopay") c0, max("mriCopay") c1, min("mriCoinsPct") p0, max("mriCoinsPct") p1,
      min("catScanCopay") k0, min("catScanCoinsPct") q0, count("mriCopay")::int cn, count("mriCoinsPct")::int pn
      from "Plan" where "planYear" = ${YEAR} group by 1,2`));
  const changes = [], review = [], tally = {};
  let noPbp = 0, mixed = 0, same = 0;
  for (const r of db) {
    const key = keyOf(r.planId, r.seg === '0' ? null : r.seg);
    const P = pbp.get(key);
    if (!P) { noPbp++; continue; }
    if (r.c0 !== r.c1 || r.p0 !== r.p1 || (r.cn !== 0 && r.cn !== r.n) || (r.pn !== 0 && r.pn !== r.n)) mixed++;
    const cur = { copay: r.c0, coins: r.p0 };
    const S = sb[key] || null;
    const t = decide(P, S, r.cat, r.tg, cur);
    if (t.review) review.push({ key, carrier: r.org, category: r.cat, sb: S && S.evidence, cmsCopay: P.copay, cmsCoinsPct: P.coins });
    if (t.copay === cur.copay && t.coins === cur.coins && r.k0 === cur.copay && r.q0 === cur.coins && r.c0 === r.c1 && r.p0 === r.p1) { same++; continue; }
    const group = `${t.rule} | ${r.cat}${r.tg ? ' ' + r.tg : ''}`;
    tally[group] = tally[group] || { planSegments: 0, rows: 0 };
    tally[group].planSegments++; tally[group].rows += r.n;
    changes.push({ planId: r.planId, seg: r.seg, key, carrier: r.org, category: r.cat, targetGroup: r.tg, rows: r.n, rule: t.rule,
      oldCopay: cur.copay, oldCoinsPct: cur.coins, newCopay: t.copay, newCoinsPct: t.coins, cmsCopay: P.copay, cmsCoinsPct: P.coins,
      sbBasis: S ? S.basis : null, sbEvidence: t.rule === 'CMS' ? null : S && S.evidence });
  }
  console.log(`${db.length} plan-segments in ${YEAR}. Unchanged ${same}. To change ${changes.length}. No CMS row ${noPbp}. Mixed within a plan-segment ${mixed}.`);
  for (const [g, v] of Object.entries(tally).sort((a, b) => b[1].planSegments - a[1].planSegments)) console.log(`  ${String(v.planSegments).padStart(4)} plan-segments ${String(v.rows).padStart(6)} rows  ${g}`);
  console.log(`Review list (not applied): ${review.length}`);
  for (const x of review.slice(0, 10)) console.log('   ', x.key, x.carrier, '| CMS', x.cmsCopay, x.cmsCoinsPct, '|', (x.sb || '').slice(0, 90));
  const show = (c) => `${c.key} ${c.carrier.slice(0, 10)} ${c.category}: ${c.oldCopay == null ? (c.oldCoinsPct == null ? 'blank' : c.oldCoinsPct + '%') : '$' + c.oldCopay} -> ${c.newCopay == null ? (c.newCoinsPct == null ? 'blank' : c.newCoinsPct + '%') : '$' + c.newCopay} [${c.rule}]`;
  for (const g of Object.keys(tally)) { const ex = changes.filter((c) => `${c.rule} | ${c.category}${c.targetGroup ? ' ' + c.targetGroup : ''}` === g).slice(0, 3); for (const c of ex) console.log('     e.g.', show(c)); }
  // The applied change list is a running record: an --apply run merges into it (latest entry per plan-segment wins).
  // A dry-run never touches it; it writes its list to .cms-import-tmp/sb-2027/mri-dry-run.json instead.
  const today = new Date().toISOString().slice(0, 10);
  if (APPLY) {
    const prev = fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')) : { changes: [] };
    const byKey = new Map((prev.changes || []).map((c) => [c.key, c]));
    for (const c of changes) byKey.set(c.key, { ...c, appliedOn: today });
    fs.writeFileSync(OUT_FILE, JSON.stringify({ planYear: YEAR, lastApplied: today, changes: [...byKey.values()], review }, null, 1));
    console.log('Change list ->', path.relative(ROOT, OUT_FILE));
  } else {
    const dry = path.join(ROOT, '.cms-import-tmp', 'sb-2027', 'mri-dry-run.json');
    fs.writeFileSync(dry, JSON.stringify({ planYear: YEAR, generatedAt: today, changes, review }, null, 1));
    console.log('Dry-run list ->', path.relative(ROOT, dry));
  }
  if (APPLY && changes.length) {
    const rows = changes.map((c) => ({ planId: c.planId, seg: c.seg, c: c.newCopay, k: c.newCopay, p: c.newCoinsPct, q: c.newCoinsPct }));
    const nUpd = await updateBySegment(prisma, rows, { mriCopay: ['c', 'double precision'], catScanCopay: ['k', 'double precision'], mriCoinsPct: ['p', 'double precision'], catScanCoinsPct: ['q', 'double precision'] });
    console.log('Rows written:', nUpd);
  } else if (!APPLY) console.log('Dry-run. Re-run with --apply to write.');
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
