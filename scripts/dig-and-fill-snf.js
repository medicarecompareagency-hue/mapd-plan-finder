// scripts/dig-and-fill-snf.js
//
// (1) READ-ONLY DIG (--dump): for every plan that renders SkilledNursing N/A (skilledNursingCopay IS NULL),
//     prints every NON-EMPTY PBP b2 column, to settle bug-vs-genuine.
// (2) CONDITIONAL FILL: builds a skilledNursingCopay STRING from whatever b2 columns ARE populated
//     (interval -> "$X/day days A-B, ..."; flat -> "$X/stay"; coins -> "X% per day"). If b2 has copay_yn=1
//     but truly no amount anywhere, it LEAVES the plan NULL and REPORTS it (never fabricates $0).
//     SNF is NOT a ranking key -> display-only. NULL-only writes.
//
// b2 column names are DISCOVERED from the header (b2 has never been parsed here).
//
// USAGE (from repo root):
//   node scripts/dig-and-fill-snf.js --pbp <path> --dump   # read-only structure dump (do this first)
//   node scripts/dig-and-fill-snf.js --pbp <path>          # dry-run fill preview
//   node scripts/dig-and-fill-snf.js --pbp <path> --apply  # write the fillable ones
//
const fs = require("fs");
const path = require("path");
const { makePrisma } = require("./prisma-client");
const prisma = makePrisma();

const APPLY = process.argv.includes("--apply");
const DUMP = process.argv.includes("--dump");
const PLAN_YEAR = 2026;
function argVal(flag) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : null; }
const PBP_FILE = argVal("--pbp") || path.join(process.cwd(), ".cms-import-tmp", `pbp-${PLAN_YEAR}`, "pbp_b2_snf.txt");

function num(s) { if (s == null) return null; const t = String(s).trim(); if (t === "") return null; const v = parseFloat(t.replace(/,/g, "")); return Number.isFinite(v) ? v : null; }

function readTsv(file) {
  const raw = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const lines = raw.split("\n");
  const H = lines[0].split("\t").map(h => h.trim());
  const idx = {}; H.forEach((h, i) => { idx[h] = i; });
  return { H, idx, lines };
}

function discoverB2(H) {
  const c = { all: [], copYn: null, coinYn: null, flat: [], pct: [], intervals: [] };
  const intMap = {};
  for (const h of H) {
    if (!/^pbp_b2[a-z0-9]*_/i.test(h)) continue;
    c.all.push(h);
    if (/_copay_yn$/i.test(h)) c.copYn = h;
    else if (/_coins_yn$/i.test(h)) c.coinYn = h;
    else if (/coins.*pct/i.test(h)) c.pct.push(h);
    else {
      const mi = h.match(/int(\d+)/i);
      if (mi && /(bgnd|bgn|begin)/i.test(h)) (intMap[mi[1]] = intMap[mi[1]] || {}).bgn = h;
      else if (mi && /(endd|end)/i.test(h)) (intMap[mi[1]] = intMap[mi[1]] || {}).end = h;
      else if (mi && /amt/i.test(h)) (intMap[mi[1]] = intMap[mi[1]] || {}).amt = h;
      else if (/copay.*amt/i.test(h)) c.flat.push(h);
    }
  }
  c.intervals = Object.keys(intMap).sort((a, b) => +a - +b).map(n => intMap[n]);
  return c;
}

function buildSnf(get, c) {
  const parts = [];
  for (const iv of c.intervals) {
    if (!iv.amt) continue;
    const amt = num(get(iv.amt)); const bgn = (get(iv.bgn) || "").trim(); const end = (get(iv.end) || "").trim();
    if (amt != null && bgn && end) parts.push(`$${amt}/day days ${bgn}-${end}`);
  }
  if (parts.length) return parts.join(", ");
  let flatMax = null; for (const f of c.flat) { const v = num(get(f)); if (v != null && v > 0) flatMax = (flatMax == null ? v : Math.max(flatMax, v)); }
  if (flatMax != null) return `$${flatMax}/stay`;
  let mn = null; for (const p of c.pct) { const v = num(get(p)); if (v != null) mn = (mn == null ? v : Math.min(mn, v)); }
  if (mn != null) return `${mn}% per day`;
  return null;
}

function loadPbp() {
  if (!fs.existsSync(PBP_FILE)) {
    console.error(`PBP file not found: ${PBP_FILE}`);
    console.error(`Find it: Get-ChildItem -Recurse -Filter "pbp_b2*.txt" c:\\Users\\dbuir  (then pass --pbp "<path>")`);
    process.exit(1);
  }
  const { H, idx, lines } = readTsv(PBP_FILE);
  const c = discoverB2(H);
  console.log(`b2 columns discovered: ${c.all.length} (copay_yn=${c.copYn || "-"}, coins_yn=${c.coinYn || "-"}, intervals=${c.intervals.length}, flat=${c.flat.length}, pct=${c.pct.length})`);
  const cHnum = idx["pbp_a_hnumber"], cPlan = idx["pbp_a_plan_identifier"];
  if (cHnum == null || cPlan == null) throw new Error("b2 key columns missing");

  const byPlan = new Map(); // planId -> { str, covered, nonEmpty: {col:val} }
  for (let i = 1; i < lines.length; i++) {
    const r = lines[i].split("\t");
    if (r.length <= cPlan) continue;
    const hnum = (r[cHnum] || "").trim(), pid = (r[cPlan] || "").trim();
    if (!hnum || !pid) continue;
    const planId = `${hnum}-${parseInt(pid, 10)}`;
    const get = (name) => (idx[name] != null ? r[idx[name]] : undefined);
    const str = buildSnf(get, c);
    const covered = (get(c.copYn) || "").trim() === "1" || (get(c.coinYn) || "").trim() === "1";
    const nonEmpty = {};
    for (const col of c.all) { const v = (get(col) || "").trim(); if (v !== "" && v !== "0") nonEmpty[col] = v; }
    const prev = byPlan.get(planId);
    if (!prev || (!prev.str && str)) byPlan.set(planId, { str, covered, nonEmpty });
  }
  return byPlan;
}

async function main() {
  console.log(`PBP file: ${PBP_FILE}`);
  const pbp = loadPbp();

  const naPlans = await prisma.plan.findMany({
    where: { planYear: PLAN_YEAR, skilledNursingCopay: null },
    select: { planId: true, organizationName: true, state: true },
    distinct: ["planId"],
  });
  console.log(`\n${naPlans.length} distinct DB plans render SkilledNursing N/A (skilledNursingCopay NULL).`);

  let fillable = 0, genuineBlank = 0, noRow = 0, rows = 0;
  const fills = [], blanks = [];
  for (const p of naPlans) {
    const e = pbp.get(p.planId);
    if (DUMP) {
      if (!e) { console.log(`\n${p.planId} (${p.organizationName}, ${p.state}): NO b2 row`); continue; }
      console.log(`\n${p.planId} (${p.organizationName}, ${p.state}) covered=${e.covered} built=${e.str || "(none)"}`);
      const keys = Object.keys(e.nonEmpty);
      if (!keys.length) console.log("    (all b2 columns empty/zero)");
      for (const k of keys) console.log(`    ${k} = ${e.nonEmpty[k]}`);
      continue;
    }
    if (!e) { noRow++; continue; }
    if (e.str) { fillable++; fills.push(`${p.planId} (${p.organizationName}, ${p.state}): ${e.str}`); }
    else if (e.covered) { genuineBlank++; blanks.push(`${p.planId} (${p.organizationName}, ${p.state}): b2 covered (yn=1) but NO amount in any column -> left NULL`); continue; }
    else { noRow++; continue; }
    if (APPLY && e.str) {
      const r = await prisma.plan.updateMany({ where: { planId: p.planId, planYear: PLAN_YEAR, skilledNursingCopay: null }, data: { skilledNursingCopay: e.str } });
      rows += r.count;
    }
  }
  if (DUMP) { await prisma.$disconnect(); return; }
  console.log(`\nFillable from b2: ${fillable} | genuine-blank (covered, no amount): ${genuineBlank} | no b2 row: ${noRow}`);
  console.log(`\nFills:`); for (const s of fills) console.log("  " + s);
  if (blanks.length) { console.log(`\nGenuine-blank (REPORT to Dale — not fabricating $0):`); for (const s of blanks) console.log("  " + s); }
  if (APPLY) console.log(`\nRows written: ${rows}`); else console.log(`\nDry-run — no writes. Re-run with --apply.`);
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
