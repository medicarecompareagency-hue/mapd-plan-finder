// scripts/sb2027/validate.js — STRICT Summary-of-Benefits validator, year-parameterized.
// Same rules as scripts/ingest-sb-url.js (plan ID in text + "Summary of Benefits" + plan year +
// wrong-doctype rejection), but the year is an argument so 2026 logic is never reused for 2027.
// NEVER loosen: the HealthSpring "coming-soon.pdf" placeholder is a real PDF and passes any
// "%PDF + 200" check. Only the plan-ID + title + year gate rejects it.
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');

const PDFTOTEXT = (() => {
  for (const c of ['pdftotext', 'C:\\Program Files\\Git\\mingw64\\bin\\pdftotext.exe']) {
    try { execFileSync(c, ['-h'], { stdio: 'pipe' }); return c; } catch (e) { if (e.stdout || e.stderr) return c; }
  }
  return null;
})();

function pdftext(buf, lastPage = 3) {
  if (!PDFTOTEXT) throw new Error('pdftotext not found');
  const tmp = path.join(os.tmpdir(), 'sb_' + Math.random().toString(36).slice(2) + '.pdf');
  try { fs.writeFileSync(tmp, buf); return execFileSync(PDFTOTEXT, ['-layout', '-f', '1', '-l', String(lastPage), tmp, '-'], { maxBuffer: 60 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8'); }
  catch { return ''; } finally { try { fs.unlinkSync(tmp); } catch {} }
}
const squash = (s) => String(s).replace(/[\s\-|_.,/]/g, '').toUpperCase();
function idVariants(contract, plan3) {
  const p = String(parseInt(plan3, 10));
  // squashed forms: H1234-005, H1234-5 are distinguished below with a boundary check
  return { c: contract.toUpperCase(), p3: plan3, p };
}
// true when the text carries this contract+plan (3-digit padded form, any separator) as a real ID
function hasPlanId(txt, contract, plan3) {
  const c = contract.toUpperCase();
  const re3 = new RegExp(c + '[\\s\\-|_.,/()]{0,4}' + plan3 + '(?!\\d)', 'i');
  if (re3.test(txt)) return true;
  // H1234005000 / H1234-005-000 — contract + plan + 3-digit segment run together (Humana, UHC form)
  const re9 = new RegExp(c + '[\\s\\-|_.,/()]{0,4}' + plan3 + '[\\s\\-|_.,/]{0,4}\\d{3}(?!\\d)', 'i');
  if (re9.test(txt)) return true;
  // H1234-5 (unpadded) — require a separator and a non-digit boundary
  const p = String(parseInt(plan3, 10));
  if (p !== plan3) { const re1 = new RegExp(c + '\\s?[\\-|_]\\s?' + p + '(?!\\d)', 'i'); if (re1.test(txt)) return true; }
  return false;
}
// segment evidence: H1234-005-002 / H1234005002 / "H1234 | 005 | 002"
function hasSegment(txt, contract, plan3, seg) {
  const s3 = String(seg).padStart(3, '0');
  const re = new RegExp(contract.toUpperCase() + '[\\s\\-|_.,/]{0,4}' + plan3 + '[\\s\\-|_.,/]{0,4}' + s3 + '(?!\\d)', 'i');
  return re.test(txt);
}
function classify({ contract, plan3, seg }, buf, year = 2027) {
  if (!buf || buf.length < 800) return { ok: false, reason: 'too_short' };
  if (buf.slice(0, 5).toString('latin1') !== '%PDF-') return { ok: false, reason: 'not_pdf' };
  let txt = pdftext(buf, 3);
  if (!txt || txt.length < 500) { txt = pdftext(buf, 8); if (!txt || txt.length < 500) return { ok: false, reason: 'too_short_text' }; }
  let idTxt = txt;
  if (!hasPlanId(idTxt, contract, plan3)) { idTxt = pdftext(buf, 8); if (!hasPlanId(idTxt, contract, plan3)) return { ok: false, reason: 'planid_missing' }; }
  const low = txt.toLowerCase(), head = low.slice(0, 3000);
  if (/(commission|partnership plan|producer|enrollment (form|request|kit)|frequently asked|\bfaq\b)/.test(head) && !head.includes('summary of benefits')) return { ok: false, reason: 'wrong_doctype' };
  if (/(evidence of coverage|annual notice of change)/.test(head) && !head.includes('summary of benefits')) return { ok: false, reason: 'wrong_doctype' };
  if (!low.includes('summary of benefits')) return { ok: false, reason: 'no_sb_title' };
  const Y = String(year), prev = String(year - 1);
  if (!txt.includes(Y)) { const yr = (txt.match(/20[12]\d/) || [])[0]; return { ok: false, reason: 'stale_year' + (yr ? '(' + yr + ')' : '') }; }
  const rangeRe = (y) => new RegExp('january\\s*1,?\\s*(' + y + ')?\\s*(–|-|—|to|through)\\s*december\\s*31,?\\s*' + y);
  if (rangeRe(prev).test(low) && !rangeRe(Y).test(low)) return { ok: false, reason: 'stale_year(' + prev + ')' };
  // count year tokens: a 2027 SB mentions 2027 at least as often as 2026 in the first pages
  const nY = (txt.match(new RegExp(Y, 'g')) || []).length, nP = (txt.match(new RegExp(prev, 'g')) || []).length;
  if (nP > nY * 3 && !rangeRe(Y).test(low)) return { ok: false, reason: 'stale_year(' + prev + '-dominant)' };
  const segOk = String(seg) === '0' ? null : hasSegment(idTxt, contract, plan3, seg);
  return { ok: true, reason: '', segVerified: segOk, pagesText: txt.length };
}
module.exports = { classify, pdftext, hasPlanId, hasSegment };
