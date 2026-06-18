// scripts/fill-ambulance-air.js
//
// Fills ambulance cost-share for plans that file ONLY air ambulance (no ground b10a) and therefore
// render N/A today (ambulanceCopay NULL AND ambulanceCoinsPct NULL). Stores the air value into
// ambulanceCopay/ambulanceCoinsPct and sets ambulanceIsAirOnly=true so the UI can append "(air)".
// NULL-ONLY: never touches a plan that already has an ambulance value.
//
// b10 column names are DISCOVERED from the header (b10 has never been parsed here). b10a = ground;
// any OTHER populated b10 sub-block = air. The script prints which block/columns it chose.
//
// USAGE (from repo root):
//   node scripts/fill-ambulance-air.js                          # dry-run (prints chosen cols + per-plan)
//   node scripts/fill-ambulance-air.js --apply                  # write
//   node scripts/fill-ambulance-air.js --pbp <path>             # override b10 staging file path
//   node scripts/fill-ambulance-air.js --aircols col1,col2,...  # force air columns (from Step 0 header)
//
const fs = require("fs");
const path = require("path");
const { makePrisma } = require("./prisma-client");
const prisma = makePrisma();

const APPLY = process.argv.includes("--apply");
const PLAN_YEAR = 2026;
function argVal(flag) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : null; }
const PBP_FILE = argVal("--pbp") || path.join(process.cwd(), ".cms-import-tmp", `pbp-${PLAN_YEAR}`, "pbp_b10_amb_trans.txt");
const AIRCOLS = (argVal("--aircols") || "").split(",").map(s => s.trim()).filter(Boolean);

function num(s) { if (s == null) return null; const t = String(s).trim(); if (t === "") return null; const v = parseFloat(t.replace(/,/g, "")); return Number.isFinite(v) ? v : null; }

function readTsv(file) {
  const raw = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const lines = raw.split("\n");
  const H = lines[0].split("\t").map(h => h.trim());
  const idx = {}; H.forEach((h, i) => { idx[h] = i; });
  return { H, idx, lines };
}

// cost-share for one sub-block: copay (MAX of amounts) wins, else coins (MIN pct)
function blockCostShare(get, b) {
  if ((get(b.copYn) || "").trim() === "1") {
    let mx = null;
    for (const c of b.amt) { const v = num(get(c)); if (v != null) mx = (mx == null ? v : Math.max(mx, v)); }
    return { kind: "copay", value: mx == null ? 0 : mx }; // yn=1 + no amount filed => $0 covered
  }
  if ((get(b.coinYn) || "").trim() === "1") {
    let mn = null;
    for (const c of b.pct) { const v = num(get(c)); if (v != null) mn = (mn == null ? v : Math.min(mn, v)); }
    if (mn != null) return { kind: "coins", value: mn };
  }
  return null;
}

function discoverBlocks(H) {
  const blocks = {};
  for (const h of H) {
    const m = h.match(/^pbp_(b10[a-z0-9]*)_/i);
    if (!m) continue;
    const sb = m[1].toLowerCase();
    blocks[sb] = blocks[sb] || { copYn: null, coinYn: null, amt: [], pct: [] };
    if (/_copay_yn$/i.test(h)) blocks[sb].copYn = h;
    else if (/_coins_yn$/i.test(h)) blocks[sb].coinYn = h;
    else if (/coins.*pct/i.test(h)) blocks[sb].pct.push(h);
    else if (/copay.*(amt|min|max)/i.test(h) && !/_yn$/i.test(h)) blocks[sb].amt.push(h);
  }
  return blocks;
}

function loadPbp() {
  if (!fs.existsSync(PBP_FILE)) {
    console.error(`PBP file not found: ${PBP_FILE}`);
    console.error(`Find it: Get-ChildItem -Recurse -Filter "pbp_b10*.txt" c:\\Users\\dbuir  (then pass --pbp "<path>")`);
    process.exit(1);
  }
  const { H, idx, lines } = readTsv(PBP_FILE);
  const blocks = discoverBlocks(H);
  const blockKeys = Object.keys(blocks).sort();
  console.log(`b10 sub-blocks discovered: ${blockKeys.join(", ") || "(none!)"}`);
  for (const k of blockKeys) {
    const b = blocks[k];
    console.log(`  ${k}: copay_yn=${b.copYn || "-"} coins_yn=${b.coinYn || "-"} amt[${b.amt.length}] pct[${b.pct.length}]`);
  }
  const cHnum = idx["pbp_a_hnumber"], cPlan = idx["pbp_a_plan_identifier"];
  if (cHnum == null || cPlan == null) throw new Error("b10 key columns (pbp_a_hnumber / pbp_a_plan_identifier) missing");

  const groundKey = "b10a";
  const airKeys = blockKeys.filter(k => k !== groundKey);
  if (AIRCOLS.length) console.log(`Forced air columns (--aircols): ${AIRCOLS.join(", ")}`);
  else console.log(`Air candidate blocks (anything but ${groundKey}): ${airKeys.join(", ") || "(none)"}`);

  const byPlan = new Map();
  for (let i = 1; i < lines.length; i++) {
    const r = lines[i].split("\t");
    if (r.length <= cPlan) continue;
    const hnum = (r[cHnum] || "").trim(), pid = (r[cPlan] || "").trim();
    if (!hnum || !pid) continue;
    const planId = `${hnum}-${parseInt(pid, 10)}`;
    const get = (name) => (idx[name] != null ? r[idx[name]] : undefined);

    let ground = blocks[groundKey] ? blockCostShare(get, blocks[groundKey]) : null;
    if (ground && ground.kind === "copay" && ground.value === 0) ground = null; // treat "$0 covered, no amount" as no-ground signal
    let air = null, airBlock = null;
    if (AIRCOLS.length) {
      let mx = null, mn = null;
      for (const c of AIRCOLS) { const v = num(get(c)); if (v != null) { mx = (mx == null ? v : Math.max(mx, v)); mn = (mn == null ? v : Math.min(mn, v)); } }
      const isCoins = /coins/i.test(AIRCOLS.join(""));
      if (mx != null) { air = { kind: isCoins ? "coins" : "copay", value: isCoins ? mn : mx }; airBlock = "forced"; }
    } else {
      for (const k of airKeys) { const cs = blockCostShare(get, blocks[k]); if (cs) { air = cs; airBlock = k; break; } }
    }
    const prev = byPlan.get(planId);
    if (!prev || (!prev.air && air)) byPlan.set(planId, { ground, air, airBlock });
  }
  return byPlan;
}

async function main() {
  console.log(`PBP file: ${PBP_FILE}`);
  const pbp = loadPbp();

  const naPlans = await prisma.plan.findMany({
    where: { planYear: PLAN_YEAR, ambulanceCopay: null, ambulanceCoinsPct: null },
    select: { planId: true, organizationName: true, state: true },
    distinct: ["planId"],
  });
  console.log(`\n${naPlans.length} distinct DB plans render Ambulance N/A (copay & coins both NULL).`);

  let airOnly = 0, groundMissed = 0, stillNa = 0, rows = 0;
  const fills = [], grounds = [];
  for (const p of naPlans) {
    const e = pbp.get(p.planId);
    if (e && e.ground) { groundMissed++; grounds.push(`${p.planId} (${p.organizationName}, ${p.state}): GROUND filed in PBP but DB N/A — separate bug, not air`); continue; }
    if (!e || !e.air) { stillNa++; continue; }
    airOnly++;
    const label = e.air.kind === "coins" ? `${e.air.value}% (air)` : `$${e.air.value} (air)`;
    fills.push(`${p.planId} (${p.organizationName}, ${p.state}): air block ${e.airBlock} -> ${label}`);
    if (APPLY) {
      const data = { ambulanceIsAirOnly: true };
      if (e.air.kind === "coins") data.ambulanceCoinsPct = e.air.value; else data.ambulanceCopay = e.air.value;
      const r = await prisma.plan.updateMany({ where: { planId: p.planId, planYear: PLAN_YEAR, ambulanceCopay: null, ambulanceCoinsPct: null }, data });
      rows += r.count;
    }
  }
  console.log(`\nAir-only fillable: ${airOnly} | ground-missed (separate bug): ${groundMissed} | left N/A (no air either): ${stillNa}`);
  console.log(`\nAir fills:`); for (const s of fills) console.log("  " + s);
  if (grounds.length) { console.log(`\nGround-missed (report to Dale, do NOT air-label):`); for (const s of grounds) console.log("  " + s); }
  if (APPLY) console.log(`\nRows written: ${rows}`); else console.log(`\nDry-run — no writes. Re-run with --apply.`);
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
