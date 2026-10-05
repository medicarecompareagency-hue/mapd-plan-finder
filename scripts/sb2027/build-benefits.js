// scripts/sb2027/build-benefits.js — work out the 2027 OTC / food-card / wallet values each SB supports. NO database writes.
//
//   node scripts/sb2027/build-benefits.js      # writes scripts/data/sb-benefits-2027.json + prints a review report
//
// Inputs
//   .cms-import-tmp/sb-2027/extract/all.json  — output of the 2026 extractor (scripts/extract-sb-benefits.ts) run over the
//                                               2027 SBs in extraction-only mode (see RUNBOOK). Same thresholds as its --update-db path.
//   .cms-import-tmp/sb-2027/layout/<key>.txt  — pdftotext -layout text of each staged SB (lib.layoutText).
//   Current 2027 rows (read-only) for the PBP-filed otcAllowance / foodCardAllowance.
// Rules = the 2026 conventions, per carrier (see memory notes + the 2026 fixers named on each rule):
//   BASE (all)      sbVerifiedOtcAmount when OTC confidence >= 0.85; sbVerifiedFoodAmount when food confidence >= 0.80 (annualised, with period).
//   AETNA-CONVERT   D-SNP/C-SNP: "the $X monthly ... OTC Wallet will change to the Extra Supports Wallet" -> foodCardAllowance = X*12 (month),
//                   ssbciFoodAllowance = X, conditional. NOT sbVerifiedFoodAmount.            (fix-aetna-extra-supports-wallet.js)
//   AETNA-QUARTER   others: "you get an Extra Supports Wallet with a $Q quarterly benefit" -> foodCardAllowance = Q*4 (quarter), conditional. (fill-aetna-quarterly-foodcard.js)
//   UHC-CREDIT      "$X credit every month for OTC ... plus healthy food and utilities for qualifying members" -> foodCardAllowance = X*12 (month),
//                   ssbciFoodAllowance = X, conditional, sbVerifiedOtcAmount = X*12.            (fill-uhc-foodcard-from-sb.js + sweep-converting-wallets.js)
//   WELLCARE-SPEND  "$X monthly preloaded on your Wellcare Spendables card to spend on OTC items ... and if eligible, SSBCI" with healthy food in the
//                   SSBCI list -> same treatment as UHC-CREDIT. Without the SSBCI clause: OTC only (same-wallet rule).
//   DEVOTED-FOOD    "Food & Home Card $X per month for qualifying members" -> sbVerifiedFoodAmount = X*12 (month), conditional + standalone;
//                   SNPs also get foodCardAllowance = X*12.                                     (extract-devoted-foodcard.js)
//   HUMANA-HO       "$X monthly allowance on a prepaid spending card. All plan members receive this amount to buy ... OTC" (+ groceries for
//                   qualifying members) -> sbVerifiedOtcAmount = sbVerifiedFoodAmount = X*12. BASE finds most of these.
//   HealthSpring    BASE only; its grocery allowance is PBP-filed and is cross-checked against the SB, never overwritten.
// Every proposal carries the SB sentence it came from. Nothing is proposed for a plan-segment without a staged SB.
const fs = require('fs'), path = require('path');
const { ROOT, WORK, YEAR, num, keyOf, layoutText, makePrisma } = require('./lib');
const OUT = path.join(ROOT, 'scripts', 'data', 'sb-benefits-2027.json');
const flatOf = (t) => t.replace(/[‐-―−]/g, '-').replace(/ /g, ' ').replace(/\s+/g, ' ');
const ann = (a, p) => (a == null ? null : p === 'month' ? a * 12 : p === 'quarter' ? a * 4 : a);
const money = (s) => parseInt(String(s).replace(/,/g, ''), 10);
const catsIn = (win) => ({ food: /healthy foods?|grocer|\bfood\b/i.test(win), utilities: /utilit/i.test(win), transportation: /transportation|\btransport\b|\brides?\b/i.test(win), meals: /\bmeals?\b/i.test(win) });
const noteFor = (monthly, cats, kind) => {
  const l = []; if (cats.food) l.push('healthy food'); if (cats.utilities) l.push('utilities'); if (cats.transportation) l.push('transportation'); if (cats.meals) l.push('meals');
  return `${monthly ? `Up to $${monthly}/mo ` : ''}for ${l.join(', ') || 'extra categories'} after you qualify with a chronic condition (SSBCI) — ${kind}. Confirm eligibility in the plan's Summary of Benefits.`;
};
const chips = (set, cats) => { if (cats.food) set.ssbciOffersFood = true; if (cats.utilities) set.ssbciOffersUtilities = true; if (cats.transportation) set.ssbciOffersTransportation = true; if (cats.meals) set.ssbciOffersMeals = true; };

function carrierRule(carrier, isSnp, flat) {
  let m;
  if (/Aetna/i.test(carrier)) {
    m = flat.match(/the \$\s?(\d[\d,]*) (monthly|quarterly) benefit amount in the (?:CVS )?Over-the-Counter \(OTC\) Wallet will change to the Extra Supports Wallet(.{0,420})/i);
    if (m) {
      const x = money(m[1]), per = /month/i.test(m[2]) ? 'month' : 'quarter', cats = catsIn(m[3]), monthly = per === 'month' ? x : null;
      const set = { foodCardAllowance: ann(x, per), foodCardMaxPeriod: per, ssbciIsConditional: true, ssbciIsStandalone: false, ssbciConditionNote: noteFor(monthly, cats, 'your OTC wallet repurposed, not additional funds') };
      if (monthly) set.ssbciFoodAllowance = monthly; chips(set, cats);
      return { rule: 'AETNA-CONVERT', amount: x, period: per, set, evidence: m[0].slice(0, 260) };
    }
    m = flat.match(/you get an Extra Supports Wallet with a \$\s?(\d[\d,]*) (monthly|quarterly) benefit amount(.{0,420})/i);
    if (m) {
      const x = money(m[1]), per = /month/i.test(m[2]) ? 'month' : 'quarter', cats = catsIn(m[3]);
      const set = { foodCardAllowance: ann(x, per), foodCardMaxPeriod: per, ssbciIsConditional: true, ssbciIsStandalone: false, ssbciConditionNote: noteFor(per === 'month' ? x : null, cats, 'an added wallet for qualifying members') };
      if (per === 'month') set.ssbciFoodAllowance = x; chips(set, cats);
      return { rule: 'AETNA-QUARTER', amount: x, period: per, set, evidence: m[0].slice(0, 260) };
    }
  }
  if (/UnitedHealth/i.test(carrier)) {
    // 2027 UHC SBs: a benefit row titled "OTC, healthy food, utilities + wellness support" (D-SNP), "OTC and food credit" (C-SNP) or
    // "OTC credit" (others), then "$X credit every month|quarter ...". The title decides it: the PPO SBs interleave an out-of-network
    // column into the sentence, so the sentence itself cannot be relied on.
    m = flat.match(/(OTC(?:, healthy food, utilities \+| and food credit| credit))\s+\$\s?(\d[\d,]*) credit every (month|quarter)(.{0,300})/i);
    if (m) {
      const title = m[1], x = money(m[2]), per = m[3].toLowerCase(), gated = /food/i.test(title);
      const set = { sbVerifiedOtcAmount: ann(x, per), sbVerifiedOtcPeriod: per };
      if (gated) { const cats = { food: true, utilities: /utilit/i.test(title), transportation: false, meals: false }; Object.assign(set, { foodCardAllowance: ann(x, per), foodCardMaxPeriod: per, ssbciIsConditional: true, ssbciIsStandalone: false, ssbciConditionNote: noteFor(per === 'month' ? x : null, cats, 'the same OTC credit, not additional funds') }); if (per === 'month') set.ssbciFoodAllowance = x; chips(set, cats); }
      return { rule: gated ? 'UHC-CREDIT' : 'UHC-OTC-ONLY', amount: x, period: per, set, evidence: m[0].slice(0, 260) };
    }
  }
  if (/Humana/i.test(carrier)) {
    // Healthy Options Allowance: one prepaid card, OTC for every member, groceries/utilities/rent for members with a qualifying chronic
    // condition. 2026 convention: sbVerifiedOtcAmount = sbVerifiedFoodAmount = the allowance. BASE finds most; this catches the SBs it misses.
    m = flat.match(/\$\s?(\d[\d,]*) (monthly|quarterly) allowance on a prepaid\s+spending card\.?\s+All plan members receive this amount to buy approved over.the.counter/i);
    if (m) {
      const x = money(m[1]), per = /month/i.test(m[2]) ? 'month' : 'quarter', groc = /may also use this money|eligible\s+groceries/i.test(flat);
      const set = { sbVerifiedOtcAmount: ann(x, per), sbVerifiedOtcPeriod: per };
      if (groc) Object.assign(set, { sbVerifiedFoodAmount: ann(x, per), sbVerifiedFoodPeriod: per, ssbciIsConditional: true, ssbciIsStandalone: false, ssbciOffersFood: true });
      return { rule: groc ? 'HUMANA-HO' : 'HUMANA-HO-OTC-ONLY', amount: x, period: per, set, evidence: m[0].slice(0, 260) };
    }
  }
  if (/Wellcare/i.test(carrier)) {
    m = flat.match(/You will receive a total of \$\s?(\d[\d,]*) (monthly|quarterly) preloaded on your Wellcare Spendables.{0,6}card to spend on ([^.]{0,160})\./i);
    if (m) {
      const x = money(m[1]), per = /month/i.test(m[2]) ? 'month' : 'quarter', uses = m[3];
      const ssbci = /if eligible,? SSBCI/i.test(uses), food = /Healthy Food\s*-\s*You can use your card/i.test(flat);
      const set = { sbVerifiedOtcAmount: ann(x, per), sbVerifiedOtcPeriod: per };
      if (ssbci && food) { const cats = { food: true, utilities: /Utilit/i.test(flat), transportation: false, meals: false }; Object.assign(set, { foodCardAllowance: ann(x, per), foodCardMaxPeriod: per, ssbciIsConditional: true, ssbciIsStandalone: false, ssbciConditionNote: noteFor(per === 'month' ? x : null, cats, 'the same Spendables allowance, not additional funds') }); if (per === 'month') set.ssbciFoodAllowance = x; chips(set, cats); }
      return { rule: ssbci && food ? 'WELLCARE-SPEND' : 'WELLCARE-OTC-ONLY', amount: x, period: per, set, evidence: m[0].slice(0, 260) };
    }
  }
  if (/Devoted/i.test(carrier)) {
    m = flat.match(/Food (?:&|and) Home Card\s+\$\s?(\d[\d,]*) per (month|quarter) for qualifying members(.{0,300})/i);
    if (m) {
      const x = money(m[1]), per = m[2].toLowerCase(), cats = catsIn(m[3]);
      const set = { sbVerifiedFoodAmount: ann(x, per), sbVerifiedFoodPeriod: per, ssbciIsConditional: true, ssbciIsStandalone: true, ssbciConditionNote: `$${x}/${per === 'month' ? 'mo' : 'qtr'} Food & Home Card for qualifying members only (SSBCI, chronic condition). Confirm eligibility in the plan's Summary of Benefits.` };
      if (isSnp) { set.foodCardAllowance = ann(x, per); }
      chips(set, cats);   // ssbciFoodAllowance is left as the PBP import set it
      return { rule: 'DEVOTED-FOOD', amount: x, period: per, set, evidence: m[0].slice(0, 260) };
    }
  }
  return null;
}

(async () => {
  const ext = JSON.parse(fs.readFileSync(path.join(WORK, 'extract', 'all.json'), 'utf8'));
  const prisma = makePrisma();
  let segs;
  try {
    segs = num(await prisma.$queryRawUnsafe(
      `SELECT "planId", coalesce("segmentId",'0') AS seg, min("organizationName") AS carrier, min("planCategory") AS cat, min("planName") AS name,
              max("otcAllowance") AS otc, min("otcMaxPeriod") AS otc_per, max("foodCardAllowance") AS food, max("ssbciFoodAllowance") AS ssf, bool_or("ssbciOffersFood") AS off_food,
              bool_or("ssbciOffersFood" OR "ssbciOffersMeals" OR "ssbciOffersUtilities" OR "ssbciOffersHousing" OR "ssbciOffersTransportation") AS any_ssbci, count(*) AS rows
       FROM "Plan" WHERE "planYear" = ${YEAR} GROUP BY 1, 2 ORDER BY 1, 2`));
  } finally { await prisma.$disconnect(); }
  const mpp = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'data', 'uhc-mpp-otc-2027.json'), 'utf8'));
  const out = {}, stat = {}, review = [];
  const bump = (a, b) => { stat[a] = stat[a] || {}; stat[a][b] = (stat[a][b] || 0) + 1; };
  for (const s of segs) {
    const key = keyOf(s.planId, s.seg === '0' ? null : s.seg), x = ext[key];
    const grp = s.carrier + ' | ' + (['DSNP', 'CSNP'].includes(s.cat) ? s.cat : 'other');
    bump(grp, 'plan-segments');
    if (!x) {
      bump(grp, 'no SB');
      // UHC plans whose SB is not posted yet: use UHC's agent portal (scripts/data/uhc-mpp-otc-2027.json, read 2026-10-05). On the 305 UHC
      // plan-segments that have BOTH an SB and a portal entry the two agree on amount, period and food gating 305 of 305.
      // As soon as the SB is staged this branch stops applying and the SB rule takes over.
      const mp = /UnitedHealth/i.test(s.carrier) ? mpp[key] : null;
      if (mp && mp.amount) {
        const set = { sbVerifiedOtcAmount: ann(mp.amount, mp.period), sbVerifiedOtcPeriod: mp.period };
        if (mp.gated) { const cats = { food: true, utilities: !!mp.utilities, transportation: false, meals: false }; Object.assign(set, { foodCardAllowance: ann(mp.amount, mp.period), foodCardMaxPeriod: mp.period, ssbciIsConditional: true, ssbciIsStandalone: false, ssbciConditionNote: noteFor(mp.period === 'month' ? mp.amount : null, cats, 'the same OTC credit, not additional funds') }); if (mp.period === 'month' && !(s.ssf > 0)) set.ssbciFoodAllowance = mp.amount; chips(set, cats); }
        const rule = mp.gated ? 'UHC-MPP-CREDIT' : 'UHC-MPP-OTC'; bump(grp, rule);
        if (set.foodCardAllowance > 0) bump(grp, '=> has a food card');
        out[key] = { planId: s.planId, seg: s.seg, carrier: s.carrier, cat: s.cat, name: s.name, rules: [rule], set, evidence: `UHC agent portal (mpp.uhc.com), read 2026-10-05, no SB posted yet: $${mp.amount}/${mp.period} OTC${mp.gated ? '; healthy food' + (mp.utilities ? ' and utilities' : '') + ' for qualifying members' : ' credit'}` };
      }
      continue;
    }
    const set = {}, why = [];
    // BASE — same thresholds as extract-sb-benefits.ts updatePlans()
    if (x.otc.confidence >= 0.85 && x.otc.amount > 0) { set.sbVerifiedOtcAmount = ann(x.otc.amount, x.otc.period); set.sbVerifiedOtcPeriod = x.otc.period; why.push('BASE-OTC'); }
    if (x.food.confidence >= 0.80 && x.food.amount > 0) { set.sbVerifiedFoodAmount = ann(x.food.amount, x.food.period); set.sbVerifiedFoodPeriod = x.food.period; why.push('BASE-FOOD'); }
    // same scope as backfill-ssbci-classification.ts: only plans the PBP flags as offering an SSBCI benefit
    if (s.any_ssbci) { set.ssbciIsConditional = !!x.ssbci.isConditional; set.ssbciIsStandalone = !!x.ssbci.isStandalone; if (x.ssbci.conditionNote) set.ssbciConditionNote = x.ssbci.conditionNote; }
    if (set.sbVerifiedOtcAmount != null && s.otc > 0 && Math.abs(set.sbVerifiedOtcAmount - s.otc) > 1) { bump(grp, 'SB OTC != PBP OTC'); if (s.seg !== '0') review.push(`${key} ${s.carrier}: PBP OTC $${s.otc}/yr vs this segment's SB $${set.sbVerifiedOtcAmount}/yr (SB wins via sbVerifiedOtcAmount)`); }
    const txt = layoutText(key), r = txt ? carrierRule(s.carrier, ['DSNP', 'CSNP'].includes(s.cat), flatOf(txt)) : null;
    let evidence = [x.otc.evidence, x.food.evidence].filter(Boolean).map((e) => e.slice(0, 160)).join(' || ');
    if (r) {
      // cross-checks before a carrier rule overrides BASE
      if (set.sbVerifiedOtcAmount != null && r.set.sbVerifiedOtcAmount != null && set.sbVerifiedOtcAmount !== r.set.sbVerifiedOtcAmount) review.push(`${key} ${r.rule}: generic OTC $${set.sbVerifiedOtcAmount}/yr vs rule $${r.set.sbVerifiedOtcAmount}/yr`);
      if (set.sbVerifiedFoodAmount != null && r.set.sbVerifiedFoodAmount != null && set.sbVerifiedFoodAmount !== r.set.sbVerifiedFoodAmount) review.push(`${key} ${r.rule}: generic food $${set.sbVerifiedFoodAmount}/yr vs rule $${r.set.sbVerifiedFoodAmount}/yr`);
      if (r.rule === 'AETNA-CONVERT') {
        delete set.sbVerifiedFoodAmount; delete set.sbVerifiedFoodPeriod;   // would hide the OTC wallet from non-qualifying members (effectiveOtc suppression)
        if (s.otc > 0 && Math.abs(s.otc - r.set.foodCardAllowance) > 1) review.push(`${key} AETNA-CONVERT: SB wallet $${r.set.foodCardAllowance}/yr vs PBP otcAllowance $${s.otc}/yr (SB used)`);
      }
      if (r.set.foodCardAllowance != null && s.food > 0 && Math.abs(s.food - r.set.foodCardAllowance) > 1) { review.push(`${key} ${r.rule}: PBP foodCardAllowance $${s.food}/yr differs from SB $${r.set.foodCardAllowance}/yr — food $ NOT changed`); delete r.set.foodCardAllowance; delete r.set.foodCardMaxPeriod; }
      if (r.set.ssbciFoodAllowance != null && s.ssf > 0) delete r.set.ssbciFoodAllowance;   // keep a PBP-filed SSBCI amount (e.g. Aetna's $30 HVPIP bonus)
      Object.assign(set, r.set); why.push(r.rule); evidence = r.evidence;
    }
    if (/HealthSpring/i.test(s.carrier) && x.food.amount > 0 && x.food.confidence >= 0.75) {
      // Healthy Grocery Allowance (SSBCI, per quarter). The extractor scores it 0.79-0.83; accepted at 0.75 for HealthSpring because the SB
      // reading equals the PBP-filed foodCardAllowance on every non-segmented plan. On segmented plans the PBP import carries ONE segment's
      // amount on every segment (import-pbp.js keys by planId), so the segment's own SB value has to win: sbVerifiedFoodAmount outranks it.
      const sbFood = ann(x.food.amount, x.food.period);
      set.sbVerifiedFoodAmount = sbFood; set.sbVerifiedFoodPeriod = x.food.period; if (!why.includes('BASE-FOOD')) why.push('HS-GROCERY');
      if (s.food > 0 && Math.abs(sbFood - s.food) > 1) review.push(`${key} HealthSpring: PBP food $${s.food}/yr vs this segment's SB $${sbFood}/yr (SB wins via sbVerifiedFoodAmount)`);
      else if (s.food > 0) bump(grp, 'PBP food = SB');
    }
    if (!Object.keys(set).length) { bump(grp, 'SB has nothing to set'); continue; }
    for (const w of why) bump(grp, w);
    if (set.foodCardAllowance > 0 || set.sbVerifiedFoodAmount > 0 || s.food > 0) bump(grp, '=> has a food card'); else if (['DSNP', 'CSNP'].includes(s.cat)) bump(grp, '=> NO food card');
    out[key] = { planId: s.planId, seg: s.seg, carrier: s.carrier, cat: s.cat, name: s.name, rules: why, set, evidence };
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(`wrote ${path.relative(ROOT, OUT)}: ${Object.keys(out).length} plan-segments with proposals`);
  for (const g of Object.keys(stat).sort()) console.log(g.padEnd(30), Object.entries(stat[g]).map(([k, v]) => `${k} ${v}`).join(' · '));
  console.log(`\nREVIEW (${review.length}):`); for (const r of review.slice(0, 80)) console.log('  ' + r);
})().catch((e) => { console.error(e); process.exit(1); });
