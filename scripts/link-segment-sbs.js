// link-segment-sbs.js — wire validated per-segment SB URLs onto their county-rows.
// Reads a JSON array: [{ planId, seg, url, source? }, ...] (default /tmp/seg-sb-links.json)
// For each entry, sets sbPdfUrl + sbSegmentId(=seg) + sbPdfSourceFilename on every
// 2026 county-row of that plan whose segmentId == seg. This OPENS the segment gate
// (segmentId == sbSegmentId) so the correct hosted SB shows for that segment's counties.
// Idempotent. Usage: node scripts/link-segment-sbs.js [jsonPath]
const fs = require("fs");
const { makePrisma } = require("./prisma-client");
const prisma = makePrisma();
const JSON_PATH = process.argv[2] || "/tmp/seg-sb-links.json";

(async () => {
  const entries = JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
  let total = 0;
  for (const e of entries) {
    const seg = String(e.seg);
    const fname = e.source || decodeURIComponent(e.url.split("/").pop());
    const res = await prisma.plan.updateMany({
      where: { planId: e.planId, planYear: 2026, segmentId: seg },
      data: { sbPdfUrl: e.url, sbSegmentId: seg, sbPdfSourceFilename: fname },
    });
    total += res.count;
    console.log(`${e.planId} seg${seg}: ${res.count} rows -> ${fname}`);
  }
  // Report remaining gated rows
  const rows = await prisma.plan.findMany({
    where: { planYear: 2026, NOT: { segmentId: null } },
    select: { segmentId: true, sbSegmentId: true },
  });
  const gated = rows.filter(r => r.segmentId && r.sbSegmentId && String(r.segmentId)!==String(r.sbSegmentId)).length;
  console.log(`\nTotal rows linked this run: ${total}. Gated rows remaining: ${gated}`);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
