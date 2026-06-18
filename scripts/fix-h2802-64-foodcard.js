// scripts/fix-h2802-64-foodcard.js — set Food Card $180/mo (conditional). UPDATE-only.
//   node scripts/fix-h2802-64-foodcard.js           # dry-run (prints SB food/utilities lines)
//   node scripts/fix-h2802-64-foodcard.js --apply
const { execFileSync } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const { makePrisma } = require('./prisma-client');
const prisma = makePrisma();
const APPLY = process.argv.includes('--apply');

// DB stores ANNUALIZED amounts. $180/mo = $2160/yr.
const AMOUNT_MONTHLY = 180;
const AMOUNT_ANNUAL  = 180 * 12; // 2160
const NOTE = 'Up to $180/month for food and utilities; requires a qualifying chronic condition (SSBCI) — not all members qualify. Confirm in the plan\'s Summary of Benefits.';

const PDFTOTEXT = process.platform === 'win32'
  ? 'C:\\Program Files\\Git\\mingw64\\bin\\pdftotext.exe'
  : 'pdftotext';

async function sbText(url) {
  const res = await fetch(url); if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = path.join(os.tmpdir(), 'sb-' + Math.random().toString(36).slice(2) + '.pdf');
  fs.writeFileSync(tmp, buf);
  try { return execFileSync(PDFTOTEXT, ['-layout', tmp, '-'], { maxBuffer: 64*1024*1024 }).toString(); }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}

(async () => {
  const sample = await prisma.plan.findFirst();
  const F = Object.keys(sample);
  const has = f => F.includes(f);

  const plan = await prisma.plan.findFirst({
    where: { OR: [{planId:'H2802-64'},{planId:'H2802-064'}], planYear: 2026 },
    select: Object.fromEntries(['planId','planName','state','sbPdfUrl','foodCardAllowance','foodCardMaxPeriod',
      'ssbciFoodAllowance','ssbciOffersFood','ssbciOffersUtilities','ssbciIsConditional','ssbciConditionNote',
      'sbVerifiedFoodAmount','sbVerifiedFoodPeriod','otcAllowance']
      .filter(has).map(f => [f, true])),
  });
  if (!plan) { console.error('H2802-64 not found — check Step 0 planId'); process.exit(1); }
  console.log('Target:', plan.planId, '|', plan.state, '| current:', JSON.stringify(plan));

  if (plan.sbPdfUrl) {
    try {
      const t = await sbText(plan.sbPdfUrl);
      const lines = t.split(/\r?\n/).filter(l => /food|utilit|ucard|credit|healthy/i.test(l) && /\$\s?\d/.test(l)).map(l => l.trim());
      console.log('\nSB food/utilities lines:'); lines.slice(0,12).forEach(l => console.log('   • ' + l));
      const has180 = lines.some(l => /\$\s?180\b/.test(l));
      const hasMonth = lines.some(l => /month|mo\b/i.test(l));
      console.log(has180 ? 'SB confirms $180 ✓' : '!! $180 not literally found — confirm period/amount from the lines above.');
      if (hasMonth) console.log('SB confirms monthly period ✓');
      else console.log('!! Monthly period not explicitly seen — check lines above.');
      if (!has180 && APPLY) { console.error('STOP: SB did not confirm $180. Not writing.'); process.exit(2); }
    } catch (e) { console.warn('SB read failed (' + e.message + '). Proceeding on Dale\'s stated $180/mo.'); }
  }

  // Write sbVerifiedFoodAmount (highest UI priority) + foodCardMaxPeriod path as backup.
  // sbVerifiedFoodAmount is ANNUALIZED: $180/mo = $2160/yr.
  const data = {};
  if (has('sbVerifiedFoodAmount')) data.sbVerifiedFoodAmount = AMOUNT_ANNUAL;
  if (has('sbVerifiedFoodPeriod')) data.sbVerifiedFoodPeriod = 'month';
  // foodCardAllowance path (second priority): also store annualized
  if (has('foodCardAllowance')) data.foodCardAllowance = AMOUNT_ANNUAL;
  if (has('foodCardMaxPeriod')) data.foodCardMaxPeriod = 'month';
  // ssbci fields: ssbciFoodAllowance stores raw (non-annualized) PBP value
  if (has('ssbciFoodAllowance')) data.ssbciFoodAllowance = AMOUNT_MONTHLY;
  if (has('ssbciOffersFood'))   data.ssbciOffersFood = true;
  if (has('ssbciOffersUtilities')) data.ssbciOffersUtilities = true;
  if (has('ssbciIsConditional')) data.ssbciIsConditional = true;
  if (has('ssbciConditionNote')) data.ssbciConditionNote = NOTE;

  console.log('\nPlanned write (showing key fields):');
  console.log('  sbVerifiedFoodAmount:', data.sbVerifiedFoodAmount, '(annualized; $180/mo × 12)');
  console.log('  sbVerifiedFoodPeriod:', data.sbVerifiedFoodPeriod);
  console.log('  foodCardAllowance:', data.foodCardAllowance, '(annualized backup)');
  console.log('  foodCardMaxPeriod:', data.foodCardMaxPeriod);
  console.log('  ssbciFoodAllowance:', data.ssbciFoodAllowance, '(raw PBP monthly)');
  console.log('  ssbciIsConditional: true, ssbciOffersFood: true, ssbciOffersUtilities: true');
  if (!APPLY) { console.log('\nDRY-RUN. Re-run with --apply.'); await prisma.$disconnect(); return; }

  const r = await prisma.plan.updateMany({ where: { planId: plan.planId, planYear: 2026 }, data });
  console.log('Rows updated:', r.count);
  await prisma.$disconnect();
})().catch(async e => { console.error(e); try{await prisma.$disconnect()}catch{}; process.exit(1); });
