// Update DSNP plan drug-tier copays from SB-PDF extraction results.
//
// Reads sb-dsnp-tier-extraction.json (from extract-drug-tiers.py) and
// sb-dsnp-download-list.json (filename -> authoritative planId), and writes
// drugTier1..6Copay + drugTierCoinsuranceMask onto matching 2026 DSNP plans.
//
// Convention: drugTierNCopay = retail-standard 30-day value (dollars for
// copays, bare percent number for coinsurance). drugTierCoinsuranceMask is the
// concatenation of tier digits that are coinsurance (e.g. "345").
//
// Safety: only fills plans whose drugTier1Copay is currently NULL — never
// overwrites carrier-filed tier data. The NULL guard also makes --apply
// idempotent and resumable: re-running skips plans already filled.
//
// Usage:  node scripts/update-dsnp-drug-tiers.js            (dry run)
//         node scripts/update-dsnp-drug-tiers.js --apply    (writes DB)

const fs = require("fs");
const { makePrisma } = require("./prisma-client");

const APPLY = process.argv.includes("--apply");
const prisma = makePrisma();

(async () => {
  const ext = JSON.parse(fs.readFileSync("sb-dsnp-tier-extraction.json", "utf8"));
  const dl = {};
  for (const x of JSON.parse(fs.readFileSync("sb-dsnp-download-list.json", "utf8"))) dl[x.filename] = x;

  const recs = ext.filter((x) => x.status === "ok")
    .map((rec) => {
      const meta = dl[rec.file];
      if (!meta) return null;
      const data = { drugTierCoinsuranceMask: rec.coinsuranceMask || null };
      for (let i = 1; i <= 6; i++) data[`drugTier${i}Copay`] = rec.tiers[`drugTier${i}Copay`] ?? null;
      return { planId: meta.planId, data };
    })
    .filter(Boolean);

  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${recs.length} extracted-tier records`);

  if (!APPLY) {
    const ids = recs.map((r) => r.planId);
    const matches = await prisma.plan.findMany({
      where: { planId: { in: ids }, planYear: 2026, planCategory: "DSNP", drugTier1Copay: null },
      select: { planId: true },
    });
    const matchedIds = new Set(matches.map((m) => m.planId));
    const noMatch = ids.filter((id) => !matchedIds.has(id));
    console.log(`plans that would be updated: ${matchedIds.size}`);
    console.log(`county-rows affected:        ${matches.length}`);
    console.log(`records with no NULL-tier DSNP match: ${noMatch.length}`);
    if (noMatch.length) console.log(`  ${noMatch.slice(0, 30).join(", ")}${noMatch.length > 30 ? " ..." : ""}`);
    await prisma.$disconnect();
    return;
  }

  // Resume fast: one query for planIds still NULL, then update only those.
  const remaining = await prisma.plan.findMany({
    where: { planId: { in: recs.map((r) => r.planId) }, planYear: 2026, planCategory: "DSNP", drugTier1Copay: null },
    select: { planId: true },
    distinct: ["planId"],
  });
  const todo = new Set(remaining.map((m) => m.planId));
  console.log(`${todo.size} plans still need filling this run`);

  let plansUpdated = 0;
  let rowsUpdated = 0;
  for (const r of recs) {
    if (!todo.has(r.planId)) continue;
    const res = await prisma.plan.updateMany({
      where: { planId: r.planId, planYear: 2026, planCategory: "DSNP", drugTier1Copay: null },
      data: r.data,
    });
    if (res.count > 0) { plansUpdated++; rowsUpdated += res.count; }
  }
  console.log(`plans updated this run: ${plansUpdated}`);
  console.log(`county-rows updated:    ${rowsUpdated}`);
  console.log("(re-run to continue if interrupted; NULL guard skips done plans)");
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
