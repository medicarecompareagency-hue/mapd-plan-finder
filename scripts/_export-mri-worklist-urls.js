// scripts/_export-mri-worklist-urls.js
// One-shot helper: attaches sbPdfUrl + organizationName to the MRI audit worklist
// so the Python extractor doesn't need a DB connection. Not registered as a
// reapply fixer (this is a data-prep step, not an SB-truth writer).
const fs = require("fs");
const { makePrisma } = require("./prisma-client");
const prisma = makePrisma();

async function main() {
  const data = JSON.parse(fs.readFileSync("scripts/data/mri-audit-worklist-2026-07.json", "utf8"));
  const planIds = data.worklist.map(w => w.planId);
  const rows = await prisma.plan.findMany({
    where: { planId: { in: planIds }, planYear: 2026 },
    select: { planId: true, sbPdfUrl: true, organizationName: true, state: true },
    distinct: ["planId"],
  });
  const byPlan = new Map(rows.map(r => [r.planId, r]));

  const withUrl = [];
  const noUrl = [];
  for (const w of data.worklist) {
    const r = byPlan.get(w.planId);
    if (r && r.sbPdfUrl) {
      withUrl.push({ planId: w.planId, sbPdfUrl: r.sbPdfUrl, organizationName: r.organizationName, state: r.state, mriCopay: w.mriCopay, buckets: w.buckets });
    } else {
      noUrl.push({ planId: w.planId, organizationName: w.organizationName, buckets: w.buckets, reason: "no sbPdfUrl in DB" });
    }
  }
  console.log(`With sbPdfUrl: ${withUrl.length}. Without: ${noUrl.length}.`);
  fs.writeFileSync("scripts/data/mri-worklist-with-urls-2026-07.json", JSON.stringify({ withUrl, noUrl }, null, 2));
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
