// scripts/fill-ambulance-ground.js
//
// Fills ambulanceCopay/ambulanceCoinsPct ONLY where currently NULL, from PBP b10a (Ground Ambulance).
// These plans render N/A because the importer didn't capture b10a even though it's populated
// (confirmed 2026-06-18: the "air-only" HealthSpring plans are actually a ground import-miss).
// NULL-only: never overwrites an existing value. b10a columns are DISCOVERED from the header.
//
// USAGE (from repo root):
//   node scripts/fill-ambulance-ground.js --pbp <path>            # dry-run (prints discovered cols + fills)
//   node scripts/fill-ambulance-ground.js --pbp <path> --apply    # write
//   node scripts/fill-ambulance-ground.js --pbp <path> --dump     # print non-empty b10a cols per N/A plan
//
const fs = require("fs");
const path = require("path");
const { makePrisma } = require("./prisma-client");
const prisma = makePrisma();

const APPLY = process.argv.includes("--apply");
const DUMP = process.argv.includes("--dump");
const PLAN_YEAR = 2026;
function argVal(f) { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : null; }
const PBP_FILE = argVal("--pbp") || path.join(process.cwd(), ".cms-import-tmp", `pbp-${PLAN_YEAR}`, "pbp_b10_ambulance.txt");

function num(s) { if (s == null) return null; const t = String(s).trim(); if (t === "") return null; const v = parseFloat(t.replace(/,/g, "")); return Number.isFinite(v) ? v : null; }
function readTsv(file) { const raw = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n"); const lines = raw.split("\n"); const H = lines[0].split("\t").map(h => h.trim()); const idx = {}; H.forEach((h, i) => idx[h] = i); return { H, idx, lines }; }

// discover b10a (ground) cost-share columns from the header
function discoverGround(H) {
  const g = { copYn: null, coinYn: null, amt: [], pct: [], all: [] };
  for (const h of H) {
    if (!/^pbp_b10a_/i.test(h)) continue;
    g.all.push(h);
    if (/_copay_yn$/i.test(h)) g.copYn = h;
    else if (/_coins_yn$/i.test(h)) g.coinYn = h;
    else if (/coins.*pct/i.test(h)) g.pct.push(h);
    else if (/copay.*(amt|min|max)/i.test(h) && !/_yn$/i.test(h)) g.amt.push(h);
  }
  return g;
}
function groundCostShare(get, g) {
  if ((get(g.copYn) || "").trim() === "1") {
    let mx = null;
    for (const c of g.amt) { const v = num(get(c)); if (v != null) mx = (mx == null ? v : Math.max(mx, v)); }
    return { kind: "copay", value: mx == null ? 0 : mx };
  }
  if ((get(g.coinYn) || "").trim() === "1") {
    let mn = null;
    for (const c of g.pct) { const v = num(get(c)); if (v != null) mn = (mn == null ? v : Math.min(mn, v)); }
    if (mn != null) return { kind: "coins", value: mn };
  }
  return null;
}
function loadPbp() {
  if (!fs.existsSync(PBP_FILE)) {
    console.error(`PBP file not found: ${PBP_FILE}`);
    console.error(`Find it: Get-ChildItem -Recurse -Filter "pbp_b10*.txt" c:\\Users\\dbuir  (then --pbp "<path>")`);
    process.exit(1);
  }
  const { H, idx, lines } = readTsv(PBP_FILE);
  const g = discoverGround(H);
  console.log(`b10a ground cols: copay_yn=${g.copYn || "-"} coins_yn=${g.coinYn || "-"} amt[${g.amt.length}] pct[${g.pct.length}]`);
  const cHnum = idx["pbp_a_hnumber"], cPlan = idx["pbp_a_plan_identifier"];
  if (cHnum == null || cPlan == null) throw new Error("b10 key columns missing");
  const byPlan = new Map();
  for (let i = 1; i < lines.length; i++) {
    const r = lines[i].split("\t"); if (r.length <= cPlan) continue;
    const hnum = (r[cHnum] || "").trim(), pid = (r[cPlan] || "").trim(); if (!hnum || !pid) continue;
    const planId = `${hnum}-${parseInt(pid, 10)}`;
    const get = n => (idx[n] != null ? r[idx[n]] : undefined);
    const cs = groundCostShare(get, g);
    const nonEmpty = {}; for (const c of g.all) { const v = (get(c) || "").trim(); if (v !== "" && v !== "0") nonEmpty[c] = v; }
    const prev = byPlan.get(planId);
    if (!prev || (!prev.cs && cs)) byPlan.set(planId, { cs, nonEmpty });
  }
  return byPlan;
}
async function main() {
  console.log(`PBP file: ${PBP_FILE}`);
  const pbp = loadPbp();
  const na = await prisma.plan.findMany({
    where: { planYear: PLAN_YEAR, ambulanceCopay: null, ambulanceCoinsPct: null },
    select: { planId: true, organizationName: true, state: true }, distinct: ["planId"],
  });
  console.log(`\n${na.length} distinct DB plans render Ambulance N/A (copay & coins both NULL).`);
  let fill = 0, stillNa = 0, rows = 0; const fills = [];
  for (const p of na) {
    const e = pbp.get(p.planId);
    if (DUMP) {
      console.log(`\n${p.planId} (${p.organizationName}, ${p.state})`);
      if (!e) { console.log("    NO b10 row"); continue; }
      const ks = Object.keys(e.nonEmpty); if (!ks.length) console.log("    (b10a all empty)");
      for (const k of ks) console.log(`    ${k} = ${e.nonEmpty[k]}`);
      continue;
    }
    if (!e || !e.cs) { stillNa++; continue; }
    fill++;
    const label = e.cs.kind === "coins" ? `${e.cs.value}%` : `$${e.cs.value}`;
    fills.push(`${p.planId} (${p.organizationName}, ${p.state}): ground ${label}`);
    if (APPLY) {
      const data = e.cs.kind === "coins" ? { ambulanceCoinsPct: e.cs.value } : { ambulanceCopay: e.cs.value };
      const r = await prisma.plan.updateMany({ where: { planId: p.planId, planYear: PLAN_YEAR, ambulanceCopay: null, ambulanceCoinsPct: null }, data });
      rows += r.count;
    }
  }
  if (DUMP) { await prisma.$disconnect(); return; }
  console.log(`\nGround-fillable from b10a: ${fill} | left N/A (no b10a cost-share): ${stillNa}`);
  console.log(`\nFills:`); for (const s of fills) console.log("  " + s);
  if (APPLY) console.log(`\nRows written: ${rows}`); else console.log(`\nDry-run — no writes. Re-run with --apply.`);
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
