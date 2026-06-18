// scripts/fill-snf-residual.js
//
// Finishes the 6 residual SkilledNursing plans left N/A or partial by the v2 SB pass (2026-06-18).
// Improvements: STOP includes transportation/etc; SNF window prefers the occurrence that carries a
// cost-share (skips table-of-contents hits); prints a WIDE raw dump for the judgment-call plans.
// NULL-only writes, except H2406-50 which may be overwritten ONLY to augment its existing partial.
//
// USAGE (from repo root):
//   node scripts/fill-snf-residual.js            # dry-run: per-plan built string + wide SB dump
//   node scripts/fill-snf-residual.js --apply    # write the confident ones (H2406-50 overwrite-guarded)
//
const fs = require("fs"); const os = require("os"); const path = require("path");
const { execSync } = require("child_process");
const { makePrisma } = require("./prisma-client");
const prisma = makePrisma();
const APPLY = process.argv.includes("--apply");
const PLAN_YEAR = 2026;

const TARGET = ["H4514-16", "H4514-23", "H2406-50", "H0439-22", "H0672-15", "H2406-52"];
const PARTIAL_OVERWRITE = { "H2406-50": "$217/day days 21-100" }; // overwrite allowed iff new string CONTAINS this
// H4514-16/23: transportation text ("24 one-way trips") is on the SAME LINE as the SNF label, so the
// improved STOP list still can't block it. The built "$0/stay" is from transport, not SNF. Skip and report.
const NO_AUTOWRITE = new Set(["H4514-16", "H4514-23"]);

const SNF_LABELS = [/skilled nursing facility/i, /\bskilled nursing\b/i, /\bSNF\b/i];
const STOP = /(out[- ]of[- ]network|monthly premium|deductible|maximum out|emergency|urgent care|ambulance|outpatient|inpatient hospital|physical therapy|occupational therapy|home health|hospice|transportation|one[- ]way|round[- ]?trip|\btrips?\b|\brides?\b|\bmeals?\b|dental|vision|hearing|over[- ]the[- ]counter|\bOTC\b|wellness|fitness|telehealth|preventive|diagnostic|x-?ray|lab services|^\s*benefits\s*$)/i;

function extractText(pdf) { return execSync(`"C:\\Program Files\\Git\\mingw64\\bin\\pdftotext.exe" -layout -nopgbrk "${pdf}" -`, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); }
function hasCostShare(s) { return /\$\s*\d/.test(s) || /\d\s*%/.test(s) || /\bno (?:copay|charge|cost)\b/i.test(s); }

// pick the SNF window that actually carries a cost-share (skip TOC/heading-only hits)
function snfWindow(text) {
  const lines = text.split(/\r?\n/);
  let fallback = null;
  for (let i = 0; i < lines.length; i++) {
    if (!SNF_LABELS.some(re => re.test(lines[i]))) continue;
    let win = lines[i];
    for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) { if (STOP.test(lines[j]) || /\bH\d{4}-\d/.test(lines[j])) break; win += " " + lines[j]; }
    const onIdx = win.search(/out[- ]of[- ]network/i); if (onIdx > 0) win = win.slice(0, onIdx);
    if (fallback == null) fallback = win;
    if (hasCostShare(win)) return win;
  }
  return fallback;
}
// Build "$X/day days A-B, ..." (amount-first standard CMS phrasing; day-first colon phrasing as fallback).
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
function wideDump(text) {
  const lines = text.split(/\r?\n/); const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (SNF_LABELS.some(re => re.test(lines[i]))) {
      out.push(`    >> line ${i}: ${lines[i].trim()}`);
      for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) out.push(`       ${lines[j].trim()}`);
      out.push("    --");
    }
  }
  return out.join("\n");
}
async function main() {
  const plans = await prisma.plan.findMany({
    where: { planYear: PLAN_YEAR, planId: { in: TARGET } },
    select: { planId: true, organizationName: true, state: true, sbPdfUrl: true, skilledNursingCopay: true },
    distinct: ["planId"], orderBy: { planId: "asc" },
  });
  const tmp = path.join(os.tmpdir(), "snf-residual"); fs.mkdirSync(tmp, { recursive: true });
  let filled = 0, rows = 0; const todo = [];
  for (const p of plans) {
    console.log(`\n==== ${p.planId} (${p.organizationName}, ${p.state}) current=${JSON.stringify(p.skilledNursingCopay)}`);
    if (!p.sbPdfUrl) { console.log("  NO SB URL"); todo.push(`${p.planId}: no SB`); continue; }
    let text;
    try { const res = await fetch(p.sbPdfUrl); if (!res.ok) throw new Error(`HTTP ${res.status}`); const f = path.join(tmp, `${p.planId}.pdf`); fs.writeFileSync(f, Buffer.from(await res.arrayBuffer())); text = extractText(f); }
    catch (e) { console.log("  fetch/parse fail: " + e.message); todo.push(`${p.planId}: fetch fail`); continue; }
    const win = snfWindow(text); const str = buildSnfString(win);
    console.log("  window: " + ((win || "(none)").replace(/\s+/g, " ").trim().slice(0, 160)));
    console.log("  built : " + JSON.stringify(str));
    console.log("  --- wide SNF dump (read this for the judgment-call plans) ---");
    console.log(wideDump(text) || "    (no skilled-nursing lines found)");
    let willWrite = null;
    if (!NO_AUTOWRITE.has(p.planId) && str && str !== p.skilledNursingCopay) {
      if (p.skilledNursingCopay == null) willWrite = str;                                              // NULL-only fill
      else if (PARTIAL_OVERWRITE[p.planId] && str.includes(PARTIAL_OVERWRITE[p.planId])) willWrite = str; // augment partial
    }
    if (willWrite) {
      console.log(`  => WILL ${p.skilledNursingCopay == null ? "FILL" : "OVERWRITE(augment)"}: ${willWrite}`);
      if (APPLY) {
        const where = p.skilledNursingCopay == null ? { planId: p.planId, planYear: PLAN_YEAR, skilledNursingCopay: null } : { planId: p.planId, planYear: PLAN_YEAR };
        const r = await prisma.plan.updateMany({ where, data: { skilledNursingCopay: willWrite } });
        rows += r.count; filled++;
      }
    } else { console.log("  => NO auto-write (judgment call — read the wide dump above)"); todo.push(`${p.planId}: needs your read`); }
  }
  console.log(`\n${APPLY ? `Applied ${filled} plans / ${rows} rows.` : "Dry-run — no writes."}`);
  if (todo.length) { console.log(`\nStill need your decision (${todo.length}):`); for (const t of todo) console.log("  " + t); }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
