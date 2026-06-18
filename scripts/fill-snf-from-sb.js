// scripts/fill-snf-from-sb.js
//
// Fills skilledNursingCopay (STRING) ONLY where currently NULL, from each plan's Summary of Benefits PDF.
// For the ~14 plans where CMS PBP b2 filed copay_yn=1 but left the dollar amount blank (genuine-blank,
// confirmed 2026-06-18), the SB PDF carries the real SNF cost-share — typically
// "$0 per day for days 1-20; $X per day for days 21-100". Builds the same string format as hospitalStayCopay.
// NULL-only. Bounded set -> dry-run prints ALL of them (string + SB snippet) for eyeball before --apply.
//
// USAGE (from repo root):
//   node scripts/fill-snf-from-sb.js            # dry-run: print every plan's built string + SB snippet
//   node scripts/fill-snf-from-sb.js --apply    # write the ones that parsed (NULL-only)
//
const fs = require("fs"); const os = require("os"); const path = require("path");
const { execSync, execFileSync } = require("child_process");
const { makePrisma } = require("./prisma-client");
const prisma = makePrisma();
const APPLY = process.argv.includes("--apply");
const PLAN_YEAR = 2026;
// H4514-16 and H4514-23: pdftotext window after SNF header grabbed transportation text
// ("$0 copay for 24 one-way trips") instead of SNF cost-share — skip and leave NULL for Dale.
const SKIP = new Set(["H4514-16", "H4514-23"]);

// pdftotext may be in the Git MinGW prefix on Windows (same pattern as extract-sb-benefits.ts)
const PDFTOTEXT_CANDIDATES = process.platform === "win32"
  ? ["pdftotext", "C:\\Program Files\\Git\\mingw64\\bin\\pdftotext.exe"]
  : ["pdftotext"];
function findPdftotext() {
  for (const bin of PDFTOTEXT_CANDIDATES) {
    try { execFileSync(bin, ["-h"], { stdio: "pipe" }); return bin; } catch (e) { if (e.stdout || e.stderr) return bin; }
  }
  return null;
}
const PDFTOTEXT = findPdftotext();
if (!PDFTOTEXT) { console.error("pdftotext not found. Install poppler: choco install poppler"); process.exit(1); }

const SNF_LABELS = [/skilled nursing facility/i, /\bskilled nursing\b/i, /\bSNF\b/i];
const STOP = /(out[- ]of[- ]network|monthly premium|deductible|maximum out|emergency|urgent|ambulance|outpatient|physical therapy|home health|hospice|diagnostic|x-?ray|lab services|preventive|^\s*benefits\s*$)/i;

function extractText(pdf) { return execSync(`"${PDFTOTEXT}" -layout -nopgbrk "${pdf}" -`, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); }
function distinctPlanTokens(t) { const s = new Set(); for (const m of t.matchAll(/\bH\d{4}-\d{1,3}\b/g)) s.add(m[0]); return s; }
function windowForLabel(text, labelRes) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (labelRes.some(re => re.test(lines[i]))) {
      let win = lines[i];
      for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) { if (STOP.test(lines[j]) || /\bH\d{4}-\d/.test(lines[j])) break; win += " " + lines[j]; }
      const onIdx = win.search(/out[- ]of[- ]network/i);
      return onIdx > 0 ? win.slice(0, onIdx) : win;
    }
  }
  return null;
}
// Build "$X/day days A-B, ..." from an SB SNF window. amount-first is the standard CMS phrasing;
// day-first colon phrasing is a fallback only when amount-first finds nothing.
function buildSnfString(win) {
  if (!win) return null;
  const intervals = [];
  const push = (amt, a, b) => { const n = parseFloat(String(amt).replace(/,/g, "")); if (Number.isFinite(n) && a != null && b != null) intervals.push({ start: +a, end: +b, amt: n }); };
  for (const m of win.matchAll(/\$\s*([\d,]+(?:\.\d+)?)\s*(?:copay\s*)?per\s*day\s*for\s*days?\s*(\d+)\s*(?:-|–|—|through|thru|to)\s*(\d+)/ig))
    push(m[1], m[2], m[3]);
  if (intervals.length === 0)
    for (const m of win.matchAll(/days?\s*(\d+)\s*(?:-|–|—|through|thru|to)\s*(\d+)\s*[:,]?\s*\$\s*([\d,]+(?:\.\d+)?)/ig))
      push(m[3], m[1], m[2]);
  const byStart = new Map();
  for (const iv of intervals) if (!byStart.has(iv.start)) byStart.set(iv.start, iv);
  const sorted = [...byStart.values()].sort((a, b) => a.start - b.start);
  if (sorted.length) return sorted.map(iv => `$${iv.amt}/day days ${iv.start}-${iv.end}`).join(", ");
  const perDay = win.match(/\$\s*([\d,]+(?:\.\d+)?)\s*(?:copay\s*)?per\s*day/i);
  if (perDay) return `$${parseFloat(perDay[1].replace(/,/g, ""))}/day`;
  const perStay = win.match(/\$\s*([\d,]+(?:\.\d+)?)\s*(?:copay\s*)?(?:per\s*stay|per\s*admission|each\s*stay)/i);
  if (perStay) return `$${parseFloat(perStay[1].replace(/,/g, ""))}/stay`;
  const pct = win.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
  if (pct) return `${pct[1]}% per day`;
  if (/\$\s*0\b/.test(win) || /\bno (?:copay|charge|cost)\b/i.test(win)) return "$0/stay";
  return null;
}
async function main() {
  console.log(`pdftotext: ${PDFTOTEXT}`);
  const plans = await prisma.plan.findMany({
    where: { planYear: PLAN_YEAR, skilledNursingCopay: null, sbPdfUrl: { not: null } },
    select: { planId: true, organizationName: true, state: true, sbPdfUrl: true },
    distinct: ["planId"], orderBy: { planId: "asc" },
  });
  const noSb = await prisma.plan.count({ where: { planYear: PLAN_YEAR, skilledNursingCopay: null, sbPdfUrl: null } });
  console.log(`${plans.length} distinct SNF-N/A plans WITH an SB PDF; ${noSb} SNF-N/A rows have NO SB URL (can't extract).`);
  const tmp = path.join(os.tmpdir(), "snf-sb"); fs.mkdirSync(tmp, { recursive: true });
  const cache = new Map();
  let parsed = 0, unparsed = 0, multi = 0, fetchFail = 0, rows = 0; const out = [], blanks = [];
  for (const p of plans) {
    let text = cache.get(p.sbPdfUrl);
    if (text === undefined) {
      try { const res = await fetch(p.sbPdfUrl); if (!res.ok) throw new Error(`HTTP ${res.status}`); const f = path.join(tmp, `${p.planId}.pdf`); fs.writeFileSync(f, Buffer.from(await res.arrayBuffer())); text = extractText(f); }
      catch (e) { text = null; console.warn(`  fetch/parse fail ${p.planId}: ${e.message}`); }
      cache.set(p.sbPdfUrl, text);
    }
    if (!text) { fetchFail++; blanks.push(`${p.planId} (${p.organizationName},${p.state}): FETCH_FAIL`); continue; }
    const isMulti = distinctPlanTokens(text).size > 1; if (isMulti) multi++;
    const win = windowForLabel(text, SNF_LABELS);
    const str = buildSnfString(win);
    const snip = (win || "").replace(/\s+/g, " ").trim().slice(0, 140);
    if (SKIP.has(p.planId)) { unparsed++; blanks.push(`${p.planId} (${p.organizationName},${p.state}): SKIP(bad-window)  [SB: ${snip}]`); continue; }
    if (str) {
      parsed++;
      out.push(`${isMulti ? "MULTIPLAN? " : ""}${p.planId} (${p.organizationName},${p.state}): ${str}   [SB: ${snip}]`);
      if (APPLY) { const r = await prisma.plan.updateMany({ where: { planId: p.planId, planYear: PLAN_YEAR, skilledNursingCopay: null }, data: { skilledNursingCopay: str } }); rows += r.count; }
    } else { unparsed++; blanks.push(`${p.planId} (${p.organizationName},${p.state}): UNPARSED  [SB: ${snip || "(no SNF label found)"}]`); }
  }
  console.log(`\nParsed: ${parsed} | unparsed: ${unparsed} | multi-plan PDFs: ${multi} | fetch-fail: ${fetchFail}`);
  console.log(`\nBuilt SNF strings (EYEBALL before --apply; MULTIPLAN? lines need extra scrutiny):`);
  for (const s of out) console.log("  " + s);
  if (blanks.length) { console.log(`\nLeft NULL (report to Dale):`); for (const s of blanks) console.log("  " + s); }
  if (APPLY) console.log(`\nRows written: ${rows}`); else console.log(`\nDry-run — no writes. Eyeball the strings, then --apply.`);
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
