// scripts/sb2027/lib.js — shared helpers for the 2027 SB-fix scripts.
// Everything here is planYear=2027 only and reads the SBs staged locally by acquire.js (no re-download).
const fs = require('fs'), path = require('path');
const { execFileSync } = require('child_process');
const { makePrisma } = require('../prisma-client');
const ROOT = path.join(__dirname, '..', '..');
const WORK = path.join(ROOT, '.cms-import-tmp', 'sb-2027');
const YEAR = 2027;
const num = (r) => JSON.parse(JSON.stringify(r, (k, v) => (typeof v === 'bigint' ? Number(v) : v)));
// plan-segment key used by the SB manifest: <contract>-<plan3>-<seg>   (DB: planId "H1234-5", segmentId null|"2")
function keyOf(planId, segmentId) { const [c, p] = planId.split('-'); return c + '-' + String(parseInt(p, 10)).padStart(3, '0') + '-' + (segmentId || '0'); }
// `pdftotext -layout` text of a staged SB, cached in sb-2027/layout/<key>.txt. Returns null when the SB is not staged.
function layoutText(key) {
  const dir = path.join(WORK, 'layout'); fs.mkdirSync(dir, { recursive: true });
  const c = path.join(dir, key + '.txt');
  if (fs.existsSync(c)) return fs.readFileSync(c, 'utf8');
  const pdf = path.join(WORK, 'pdf', key + '.pdf');
  if (!fs.existsSync(pdf)) return null;
  const t = execFileSync('pdftotext', ['-layout', pdf, '-'], { maxBuffer: 96 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
  fs.writeFileSync(c, t); return t;
}
// One set-based UPDATE of 2027 rows, joined on planId + segment. `cols` maps Plan column -> [recordset field, pg type].
// `guard` is extra SQL on p.* so a re-run or a changed row is never overwritten blindly.
async function updateBySegment(prisma, rows, cols, guard = 'TRUE') {
  if (!rows.length) return 0;
  const defs = ['"planId" text', 'seg text', ...Object.values(cols).map(([f, t]) => `"${f}" ${t}`)].join(', ');
  const sets = Object.entries(cols).map(([col, [f]]) => `"${col}" = v."${f}"`).join(', ');
  return prisma.$executeRawUnsafe(
    `UPDATE "Plan" p SET ${sets}, "updatedAt" = now() FROM jsonb_to_recordset($1::jsonb) AS v(${defs})
     WHERE p."planYear" = ${YEAR} AND p."planId" = v."planId" AND coalesce(p."segmentId", '0') = v.seg AND (${guard})`, JSON.stringify(rows));
}
module.exports = { ROOT, WORK, YEAR, num, keyOf, layoutText, updateBySegment, makePrisma };
