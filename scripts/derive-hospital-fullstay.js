// scripts/derive-hospital-fullstay.js
//
// Derives Plan.hospitalFullStayCost — the total member copay for ONE complete
// inpatient benefit-period stay — from the existing hospitalStayCopay display
// string. That string is the source of truth (it already carries SB-derived
// corrections and the 2026-06-08 flat-per-stay gap-fills), so we parse it
// FIRST and never consult raw PBP unless the string is missing.
//
//   Per-day intervals: "$350/day days 1-5, $0/day days 6-90" -> 350*5 + 0*85 = 1750
//   Flat per-stay:     "$1600/stay"                          -> 1600
//   Coinsurance-only / unparseable / missing                 -> NULL (ranker sorts last)
//
// hospitalFullStayCost is RANKING-ONLY (MAPD 6-key hospital-first order,
// 2026-07-08). The UI keeps rendering the hospitalStayCopay string.
//
// Registered in scripts/reapply-sb-truth.js FIXERS — a CMS re-import wipes the
// column, and the re-apply pass re-derives it from the freshly imported strings.
//
// USAGE (repo root):
//   node scripts/derive-hospital-fullstay.js            # dry-run: counts + samples
//   node scripts/derive-hospital-fullstay.js --apply    # write
//
const { makePrisma } = require("./prisma-client");
const prisma = makePrisma();

const APPLY = process.argv.includes("--apply");
const PLAN_YEAR = 2026;

// Full-stay cost from a hospitalStayCopay display string.
// Handles both the importer format ("$350/day days 1-5") and SB-derived
// variants ("$350 per day for days 1 through 5", "$1,600 per stay").
function fullStayFromString(s) {
  if (!s) return null;
  if (/coinsurance|%/i.test(s) && !/\$/.test(s)) return null;
  const perStay = s.match(/\$\s*([\d,]+(?:\.\d+)?)\s*(?:per\s*stay|\/\s*stay|per\s*admission)/i);
  const dayRe = /\$\s*([\d,]+(?:\.\d+)?)\s*(?:per\s*day|\/\s*day)[^$]*?days?\s*(\d+)\s*(?:through|thru|to|[-–])\s*(\d+)/gi;
  let total = 0, matched = false, m;
  while ((m = dayRe.exec(s)) !== null) {
    const rate = parseFloat(m[1].replace(/,/g, ""));
    const bgn = parseInt(m[2], 10);
    const end = parseInt(m[3], 10);
    if (!Number.isFinite(rate) || end < bgn) continue;
    matched = true;
    total += rate * (end - bgn + 1);
  }
  if (matched) return total;
  if (perStay) return parseFloat(perStay[1].replace(/,/g, ""));
  return null;
}

async function main() {
  const rows = await prisma.plan.findMany({
    where: { planYear: PLAN_YEAR },
    select: { id: true, planId: true, organizationName: true, planCategory: true, hospitalStayCopay: true, hospitalFullStayCost: true },
  });
  console.log(`${rows.length} plan rows (planYear ${PLAN_YEAR}).`);

  // Group rows by (planId, string) — every county row of a plan carries the
  // same string, so derive once per distinct value.
  const byCarrier = new Map();
  let derived = 0, nulls = 0, changed = 0;
  const samples = new Map(); // distinct string -> value (for spot-print)
  const updates = new Map(); // value -> row ids

  for (const r of rows) {
    const v = fullStayFromString(r.hospitalStayCopay);
    const carrier = r.organizationName || "?";
    if (!byCarrier.has(carrier)) byCarrier.set(carrier, { filled: 0, nulls: 0 });
    if (v == null) { nulls++; byCarrier.get(carrier).nulls++; }
    else {
      derived++; byCarrier.get(carrier).filled++;
      if (samples.size < 10 && !samples.has(r.hospitalStayCopay)) samples.set(r.hospitalStayCopay, v);
    }
    if (r.hospitalFullStayCost !== v && !(r.hospitalFullStayCost == null && v == null)) {
      changed++;
      const key = v == null ? "NULL" : String(v);
      if (!updates.has(key)) updates.set(key, { value: v, ids: [] });
      updates.get(key).ids.push(r.id);
    }
  }

  console.log(`\nDerived (non-null): ${derived} rows | NULL (coins/missing): ${nulls} rows | rows needing write: ${changed}`);
  console.log(`\nBy carrier (rows filled / rows null):`);
  const sorted = [...byCarrier.entries()].sort((a, b) => b[1].filled - a[1].filled);
  for (const [c, v] of sorted) console.log(`  ${c}: ${v.filled} / ${v.nulls}`);

  console.log(`\nSpot samples (string -> full-stay):`);
  for (const [s, v] of samples) console.log(`  "${s}" -> $${v}`);

  if (!APPLY) { console.log(`\nDry-run — no writes. Re-run with --apply.`); return; }

  let written = 0;
  for (const { value, ids } of updates.values()) {
    for (let i = 0; i < ids.length; i += 5000) {
      const r = await prisma.plan.updateMany({
        where: { id: { in: ids.slice(i, i + 5000) } },
        data: { hospitalFullStayCost: value },
      });
      written += r.count;
    }
  }
  console.log(`\nRows written: ${written}`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
