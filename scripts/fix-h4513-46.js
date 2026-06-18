// scripts/fix-h4513-46.js  — rename + Specialist $35, SB-verified. UPDATE-only.
//   node scripts/fix-h4513-46.js            # dry-run: shows SB specialist lines + planned writes
//   node scripts/fix-h4513-46.js --apply    # writes
const { execFileSync } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const { makePrisma } = require('./prisma-client');
const prisma = makePrisma();
const APPLY = process.argv.includes('--apply');

const NEW_NAME = 'HealthSpring Preferred AL (HMO) H4513-046-001';
const NEW_SPECIALIST = 35;

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
function specialistLines(text) {
  return text.split(/\r?\n/).filter(l =>
    /specialist/i.test(l) && !/primary care|\bpcp\b|preventive/i.test(l)
  ).map(l => l.trim());
}

(async () => {
  const plan = await prisma.plan.findFirst({
    where: { planId: { startsWith: 'H4513-' }, planYear: 2026, planName: { contains: 'Preferred', mode: 'insensitive' }, state: 'AL' },
    select: { planId:true, planName:true, specialistCopay:true, sbPdfUrl:true, state:true },
  }) || await prisma.plan.findFirst({
    where: { OR: [{planId:'H4513-46'},{planId:'H4513-046'}], planYear: 2026 },
    select: { planId:true, planName:true, specialistCopay:true, sbPdfUrl:true, state:true },
  });
  if (!plan) { console.error('H4513-46 not found — check Step 0 planId'); process.exit(1); }
  console.log('Target:', plan.planId, '|', plan.state, '| current name:', JSON.stringify(plan.planName), '| current specialist$:', plan.specialistCopay);

  if (plan.sbPdfUrl) {
    try {
      const lines = specialistLines(await sbText(plan.sbPdfUrl));
      console.log('SB specialist lines:'); lines.forEach(l => console.log('   • ' + l));
      const has35 = lines.some(l => /\$\s?35\b/.test(l));
      console.log(has35 ? 'SB confirms $35 specialist ✓' : '!! SB does NOT clearly show $35 — review the lines above before applying.');
      if (!has35 && APPLY) { console.error('STOP: SB did not confirm $35. Re-check the SB; not writing.'); process.exit(2); }
    } catch (e) { console.warn('SB read failed (' + e.message + '). Dale stated $35 explicitly; proceeding on his instruction.'); }
  } else {
    console.warn('No sbPdfUrl on this plan — proceeding on Dale\'s explicit $35.');
  }

  console.log(`\nPlanned: name -> ${JSON.stringify(NEW_NAME)} ; specialistCopay -> $${NEW_SPECIALIST} ; specialistCoinsPct -> null`);
  if (!APPLY) { console.log('DRY-RUN. Re-run with --apply.'); await prisma.$disconnect(); return; }

  const r = await prisma.plan.updateMany({
    where: { planId: plan.planId, planYear: 2026 },
    data: { planName: NEW_NAME, specialistCopay: NEW_SPECIALIST, specialistCoinsPct: null },
  });
  console.log('Rows updated:', r.count);
  await prisma.$disconnect();
})().catch(async e => { console.error(e); try{await prisma.$disconnect()}catch{}; process.exit(1); });
