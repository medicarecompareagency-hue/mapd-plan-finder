// scripts/audit-healthspring-specialist.js — re-verify HealthSpring Specialist vs SB.
//   node scripts/audit-healthspring-specialist.js           # dry-run + CSV, NO DB writes
//   node scripts/audit-healthspring-specialist.js --apply   # writes ONLY clearly-confirmed mismatches
const { execFileSync } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const { makePrisma } = require('./prisma-client');
const prisma = makePrisma();
const APPLY = process.argv.includes('--apply');

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
// Pull the in-network specialist copay from SB text. Returns {amount, evidence} or null.
function sbSpecialist(text) {
  const lines = text.split(/\r?\n/);
  const cands = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (!/specialist/i.test(l)) continue;
    if (/primary care|\bpcp\b|preventive/i.test(l)) continue;          // not the PCP line
    if (/out.?of.?network|oon/i.test(l)) continue;                     // in-network only
    let m = l.match(/\$\s?(\d[\d,]*)\s*(?:copay|copayment|per visit)?/i);
    if (m) { cands.push({ amount: parseInt(m[1].replace(/,/g,''),10), evidence: l }); continue; }
    if (/\$0\b|no charge|\$0 copay/i.test(l)) cands.push({ amount: 0, evidence: l });
  }
  if (!cands.length) return null;
  // prefer a non-zero in-network specialist copay if present (the $0 bug grabbed zero/PCP lines)
  const nonZero = cands.find(c => c.amount > 0);
  return nonZero || cands[0];
}

(async () => {
  const plans = await prisma.plan.findMany({
    where: { planYear: 2026, OR: [
      { organizationName: { contains: 'HealthSpring', mode: 'insensitive' } },
      { organizationName: { contains: 'Cigna', mode: 'insensitive' } },
      { planName: { contains: 'HealthSpring', mode: 'insensitive' } },
      { planName: { contains: 'Cigna', mode: 'insensitive' } },
    ]},
    select: { planId:true, organizationName:true, state:true, specialistCopay:true, specialistCoinsPct:true, sbPdfUrl:true, planName:true },
    distinct: ['planId'], orderBy: { planId: 'asc' },
  });
  console.log(`HealthSpring/Cigna 2026 plans: ${plans.length}. ${APPLY ? 'APPLY (clear mismatches only)' : 'DRY-RUN'}.`);

  const rows = []; let mismatch = 0, confirmed = 0, noSb = 0, fail = 0, written = 0;
  let n = 0;
  for (const p of plans) {
    n++;
    let sb = null, err = '';
    if (!p.sbPdfUrl) { noSb++; }
    else { try { sb = sbSpecialist(await sbText(p.sbPdfUrl)); } catch (e) { fail++; err = e.message; } }
    const dbVal = p.specialistCopay;
    const sbVal = sb ? sb.amount : null;
    let verdict = 'NO_SB_OR_PARSE';
    if (sb) { if (dbVal === sbVal) { verdict = 'OK'; confirmed++; } else { verdict = 'MISMATCH'; mismatch++; } }
    rows.push({ planId:p.planId, state:p.state, org:p.organizationName, db_specialist:dbVal, sb_specialist:sbVal, verdict, evidence: sb ? sb.evidence : err, name:p.planName });
    if (APPLY && verdict === 'MISMATCH' && sbVal !== null && p.planId !== 'H4513-46' && p.planId !== 'H4513-046') {
      const r = await prisma.plan.updateMany({ where: { planId: p.planId, planYear: 2026 }, data: { specialistCopay: sbVal, specialistCoinsPct: null } });
      written += r.count;
    }
    if (n % 20 === 0) console.log(`  ...${n}/${plans.length} plans`);
  }
  const headers = ['planId','state','org','db_specialist','sb_specialist','verdict','evidence','name'];
  const esc = v => { const s = v==null?'':String(v); return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; };
  fs.writeFileSync('audit-healthspring-specialist.csv', [headers.join(',')].concat(rows.map(r => headers.map(h => esc(r[h])).join(','))).join('\n'));
  console.log(`OK ${confirmed} | MISMATCH ${mismatch} | no-SB ${noSb} | parse-fail ${fail} | wrote audit-healthspring-specialist.csv`);
  console.log('-- mismatches --');
  for (const r of rows.filter(r => r.verdict === 'MISMATCH')) console.log(`  ${r.planId} ${r.state}: DB $${r.db_specialist} -> SB $${r.sb_specialist}   | ${r.evidence}`);
  if (APPLY) console.log('Rows written:', written, '(H4513-46 excluded — set in Step 1)');
  else console.log('DRY-RUN — no writes. Review the mismatches + CSV, then --apply.');
  await prisma.$disconnect();
})().catch(async e => { console.error(e); try{await prisma.$disconnect()}catch{}; process.exit(1); });
