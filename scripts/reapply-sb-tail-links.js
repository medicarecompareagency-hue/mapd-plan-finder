// scripts/reapply-sb-tail-links.js
// Re-applies the 2026-08-27 SB-link tail (69 plans / 74 links incl. 5 segmented
// plans' per-segment SBs) from scripts/data/sb-tail-links-2026-08.json after a
// CMS re-import wipes sbPdfUrl. NULL-only: never overwrites an existing link.
// These 69 were the last licensed-state 2026 plans without an SB PDF; sources
// were content.medicareadvantage.com direct patterns, uhc.com alphadog, and
// Wellcare state-affiliate materials pages — all strict-validated at ingest
// (2026 + "Summary of Benefits" + plan/segment ID in PDF text) and re-validated
// post-link (69/69 GOOD). Blob URLs are permanent Vercel Blob copies.
//
//   node scripts/reapply-sb-tail-links.js          # dry-run
//   node scripts/reapply-sb-tail-links.js --apply
//
const fs = require("fs");
const path = require("path");
const { makePrisma } = require("./prisma-client");

const APPLY = process.argv.includes("--apply");
const ARTIFACT = path.join(__dirname, "data", "sb-tail-links-2026-08.json");

(async () => {
  if (!fs.existsSync(ARTIFACT)) {
    console.log("  sb-tail-links-2026-08.json missing — skip");
    return;
  }
  const data = JSON.parse(fs.readFileSync(ARTIFACT, "utf8"));
  const entries = Object.values(data);
  if (!APPLY) {
    console.log(`  [dry-run] would reapply ${entries.length} SB links (NULL-only) across ${new Set(entries.map((e) => e.planId)).size} planIds`);
    return;
  }
  const prisma = makePrisma();
  let rows = 0;
  try {
    for (const e of entries) {
      const where = { planId: e.planId, planYear: 2026, sbPdfUrl: null };
      if (e.segmentId) where.segmentId = e.segmentId;
      const dataFields = {
        sbPdfUrl: e.sbPdfUrl,
        sbPdfSourceFilename: e.sourceUrl || undefined,
        sbLastProcessedAt: new Date(),
        sbDiscoveryConfidence: 0.98,
      };
      if (e.segmentId) dataFields.sbSegmentId = e.segmentId;
      const r = await prisma.plan.updateMany({ where, data: dataFields });
      rows += r.count;
    }
    console.log(`  reapply-sb-tail-links: re-applied ${entries.length} links to ${rows} previously-NULL rows`);
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => { console.error(e); process.exit(1); });
