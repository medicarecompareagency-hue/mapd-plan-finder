// scripts/sb2027/fix-specialist.js — 2027 version of fix-specialist-typediff-zero.js + set-uhc-specialist-choice-display.js.
//
//   node scripts/sb2027/fix-specialist.js            # dry-run: lists what the 2027 SBs say
//   node scripts/sb2027/fix-specialist.js --apply
//
// Scope: 2027 plan-segments where the PBP import left specialistCopay NULL with a coinsurance %.
//  A) SB shows a clean in-network "$0" specialist line and no % (PBP type-difference)  -> specialistCopay = 0, specialistCoinsPct = NULL
//  B) UHC SB states "$0 copay or NN% coinsurance" (member choice)                       -> specialistDisplay = "$0 or NN%" (display only)
// analyze() and analyzeChoice() are copied VERBATIM from the 2026 scripts so the classification is identical.
// Reads the locally staged 2027 SBs, per plan-SEGMENT. One set-based UPDATE each. Guarded: only rows still in the starting state change.
const { num, keyOf, layoutText, updateBySegment, makePrisma, YEAR } = require('./lib');
const APPLY = process.argv.includes('--apply');

const QUAL = /telehealth|virtual|tier ?2|preferred|select network|first \d|after (?:the )?deductible|mail order|home visit|in lieu|optional supplemental|supplemental/i;
function analyze(text){
  const lines = text.split(/\r?\n/).map(l => l.replace(/\s+/g,' ').trim());
  const ctx = [];
  for (let i = 0; i < lines.length; i++){
    if (/specialist/i.test(lines[i]) && !/specialist (?:referral|drug|pharmac)/i.test(lines[i]))
      ctx.push({ line: lines[i], prev: lines[i-1] || '', next: lines[i+1] || '' });
  }
  let cleanZero = false, qualifiedZero = false, hasCoins = false, coinsPct = null, zEv = '', cEv = '';
  for (const c of ctx){
    const l = c.line;
    if (/out.?of.?network|\boon\b|non.?network|primary care|\bpcp\b|preventive/i.test(l)) continue;
    const isZero = /\$\s?0\b|no charge|\$0 copay/i.test(l);
    const pctM = l.match(/(\d{1,2})\s?%/);
    if (isZero){ if (QUAL.test(l) || QUAL.test(c.prev) || QUAL.test(c.next)) qualifiedZero = true; else { cleanZero = true; if (!zEv) zEv = l; } }
    if (pctM){ hasCoins = true; coinsPct = parseInt(pctM[1],10); if (!cEv) cEv = l; }
  }
  let verdict;
  if (cleanZero && !hasCoins) verdict = 'DB_LIKELY_WRONG';
  else if (cleanZero && hasCoins) verdict = 'MIXED_REVIEW';
  else if (qualifiedZero && !cleanZero) verdict = 'LIKELY_COINS';
  else if (hasCoins) verdict = 'LIKELY_COINS';
  else verdict = 'UNCLEAR';
  return { verdict, cleanZero, qualifiedZero, hasCoins, coinsPct, zeroEvidence: zEv, coinsEvidence: cEv };
}
function analyzeChoice(text){
  const lines = text.split(/\r?\n/).map(l => l.replace(/\s+/g,' ').trim());
  for (let i = 0; i < lines.length; i++){
    if (!/specialist/i.test(lines[i]) || /specialist (?:referral|drug|pharmac)/i.test(lines[i])) continue;
    const blk = [lines[i-1]||'', lines[i], lines[i+1]||''].join(' ');
    if (/out.?of.?network|\boon\b|non.?network|primary care|\bpcp\b|preventive/i.test(lines[i])) continue;
    const pctM = blk.match(/(\d{1,2})\s?%/);
    const hasZero = /\$\s?0\b|no charge|\$0 copay/i.test(blk);
    const choice = /\$\s?0\b[^.]{0,40}\bor\b[^.]{0,40}\d{1,2}\s?%|\d{1,2}\s?%[^.]{0,40}\bor\b[^.]{0,40}\$\s?0\b/i.test(blk);
    if (hasZero && pctM && choice) return { match:true, pct: parseInt(pctM[1],10), evidence: blk.slice(0,200) };
  }
  return { match:false };
}

(async () => {
  const prisma = makePrisma();
  try {
    const segs = num(await prisma.$queryRawUnsafe(
      `SELECT "planId", coalesce("segmentId",'0') AS seg, min("organizationName") AS carrier, min("planCategory") AS cat, min("planName") AS name,
              min(state) AS state, min("specialistCoinsPct") AS pct, count(*) AS rows, bool_or("sbPdfUrl" IS NOT NULL) AS has_sb
       FROM "Plan" WHERE "planYear" = ${YEAR} AND "specialistCopay" IS NULL AND "specialistCoinsPct" IS NOT NULL GROUP BY 1, 2 ORDER BY 1, 2`));
    const zero = [], choice = [], verdicts = {}; let noSb = 0;
    for (const s of segs) {
      const key = keyOf(s.planId, s.seg === '0' ? null : s.seg);
      const txt = s.has_sb ? layoutText(key) : null;
      if (!txt) { noSb++; continue; }
      const a = analyze(txt);
      verdicts[s.carrier + ' | ' + a.verdict] = (verdicts[s.carrier + ' | ' + a.verdict] || 0) + 1;
      // 2027 UHC C-SNP SBs wrap "$0 / copay or 20% coinsurance" across two lines, which analyze() reads as a clean $0.
      // A member-choice match always wins: those plans get the display text only, never a $0 copay.
      const c = /UnitedHealth/i.test(s.carrier) ? analyzeChoice(txt) : { match: false };
      if (c.match) choice.push({ ...s, key, display: `$0 or ${c.pct}%`, evidence: c.evidence });
      else if (a.verdict === 'DB_LIKELY_WRONG' && a.cleanZero && !a.hasCoins) zero.push({ ...s, key, evidence: a.zeroEvidence });
    }
    console.log(`2027 plan-segments with specialist coinsurance and no copay: ${segs.length} (${noSb} have no SB yet)`);
    console.log('SB verdicts:'); for (const [k, v] of Object.entries(verdicts).sort()) console.log(`  ${String(v).padStart(3)}  ${k}`);
    console.log(`\nA) SB shows a clean $0 specialist copay -> set $0: ${zero.length} plan-segments, ${zero.reduce((a, t) => a + t.rows, 0)} rows`);
    for (const t of zero) console.log(`  ${t.key} | ${t.carrier} | ${t.cat} | ${t.state} | ${t.pct}% -> $0 | ${t.evidence.slice(0, 150)}`);
    console.log(`\nB) UHC "$0 or NN%" member choice -> display only: ${choice.length} plan-segments`);
    for (const t of choice) console.log(`  ${t.key} | ${t.cat} | ${t.state} | ${t.pct}% | "${t.display}" | ${t.evidence.slice(0, 150)}`);
    if (!APPLY) { console.log('\n[dry-run] nothing written. Re-run with --apply.'); return; }
    const nB = await updateBySegment(prisma, choice.map((t) => ({ planId: t.planId, seg: t.seg, d: t.display })), { specialistDisplay: ['d', 'text'] },
      `p."specialistCopay" IS NULL AND p."specialistCoinsPct" IS NOT NULL`);
    const nA = await updateBySegment(prisma, zero.map((t) => ({ planId: t.planId, seg: t.seg, z: 0, n: null })), { specialistCopay: ['z', 'float8'], specialistCoinsPct: ['n', 'float8'] },
      `p."specialistCopay" IS NULL AND p."specialistCoinsPct" IS NOT NULL`);
    console.log(`\nAPPLIED: A) ${nA} rows set to $0 copay; B) ${nB} rows given a "$0 or NN%" display`);
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error(e); process.exit(1); });
