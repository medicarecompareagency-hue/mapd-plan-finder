// scripts/rename-cigna-to-healthspring.js — rebrand Cigna -> HealthSpring + CMS ID. UPDATE-only.
//   node scripts/rename-cigna-to-healthspring.js           # dry-run: before/after table for Dale
//   node scripts/rename-cigna-to-healthspring.js --apply
const { makePrisma } = require('./prisma-client');
const prisma = makePrisma();
const APPLY = process.argv.includes('--apply');

function cmsId(p) {
  const parts = String(p.planId).split('-');
  const contract = parts[0];
  const num = (parts[1] || '').padStart(3, '0');
  // segmentId not in DB; default to 001
  const seg = String(parts[2] || '001').padStart(3, '0');
  return `${contract}-${num}-${seg}`;
}
function newName(p) {
  let n = p.planName || '';
  const typeM = n.match(/\(([^)]+)\)/);
  // cmsContractType is the actual field name in DB
  const type = (typeM ? typeM[1] : (p.cmsContractType || '')).trim();
  let product = n
    .replace(/\(([^)]+)\)/g, ' ')          // drop the (TYPE) parenthetical
    .replace(/\bcigna\b/ig, ' ')
    .replace(/\bhealthspring\b/ig, ' ')
    .replace(/\bmedicare\b/ig, ' ')
    .replace(/\s+/g, ' ').trim();
  return `HealthSpring ${product}${type ? ` (${type})` : ''} ${cmsId(p)}`.replace(/\s+/g, ' ').trim();
}

(async () => {
  const sample = await prisma.plan.findFirst(); const F = Object.keys(sample); const has = f=>F.includes(f);
  const sel = Object.fromEntries(['planId','planName','organizationName','state','cmsContractType'].filter(has).map(f=>[f,true]));
  const plans = await prisma.plan.findMany({
    where: { planYear: 2026, planName: { contains: 'Cigna', mode: 'insensitive' } },
    select: sel, distinct: ['planId'], orderBy: { planId: 'asc' },
  });
  console.log(`Cigna-named 2026 plans: ${plans.length}. ${APPLY ? 'APPLY' : 'DRY-RUN (approve this table before applying)'}.\n`);
  console.log('planId        | BEFORE                                             -> AFTER');
  const writes = [];
  for (const p of plans) {
    const after = newName(p);
    console.log(`${p.planId.padEnd(13)} | ${String(p.planName).padEnd(50)} -> ${after}`);
    writes.push({ planId: p.planId, after });
  }
  if (!APPLY) { console.log('\nDRY-RUN. If the AFTER column looks right, re-run with --apply.'); await prisma.$disconnect(); return; }
  let written = 0;
  for (const w of writes) { const r = await prisma.plan.updateMany({ where: { planId: w.planId, planYear: 2026 }, data: { planName: w.after } }); written += r.count; }
  console.log(`\nRows updated: ${written} across ${writes.length} planIds.`);
  await prisma.$disconnect();
})().catch(async e => { console.error(e); try{await prisma.$disconnect()}catch{}; process.exit(1); });
