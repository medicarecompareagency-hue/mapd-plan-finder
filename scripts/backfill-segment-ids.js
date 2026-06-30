// backfill-segment-ids.js
// Populates Plan.segmentId (this county-row's CMS service-area segment) and
// Plan.sbSegmentId (which segment the currently-stored SB PDF represents) for
// the MULTI-SEGMENT plans of a given plan year, from PlanArea.txt (the
// CMS-direct county->plan->segment authority used by import-cms-data.ts).
//
// CMS publishes a separate Summary of Benefits per (contract, plan, segment);
// segments can have different service areas + benefits. The DB collapses
// planId to "<contract>-<plan>" and stored ONE SB per planId, so multi-segment
// plans showed one segment's SB to every county. Tagging each row's segment
// lets /api/plans suppress the wrong-segment SB and fall back to a
// segment-correct medicare.gov link until each segment's own SB is acquired
// (the full fix sets sbSegmentId = segmentId).
//
// Single-segment plans (segment_id "0", ~96%) are left NULL -> API/UI treat as
// non-gated + medicare.gov segment "000" (unchanged). Idempotent.
// Usage: node scripts/backfill-segment-ids.js [planYear]   (default 2026)

const fs = require("fs");
const path = require("path");
const { makePrisma } = require("./prisma-client");
const prisma = makePrisma();

const PLAN_YEAR = parseInt(process.argv[2] || "2026", 10);
const PLAN_AREA = path.join(__dirname, "..", ".cms-import-tmp", "pbp-" + PLAN_YEAR, "PlanArea.txt");

function detectSbSegment() {
  for (const raw of arguments) {
    if (!raw) continue;
    const s = String(raw);
    let m = s.match(/[A-Z]?\d{3,5}[-_](\d{3})[-_](\d{3})(?!\d)/i);
    if (m) return String(parseInt(m[2], 10));
    m = s.match(/seg(?:ment)?[-_ ]?(\d{1,3})\b/i);
    if (m) return String(parseInt(m[1], 10));
  }
  return null;
}

function buildPlanArea() {
  const lines = fs.readFileSync(PLAN_AREA, "utf-8").split(/\r?\n/).filter(Boolean);
  const h = lines[0].split("\t").map((x) => x.trim());
  const iHn = h.indexOf("pbp_a_hnumber"), iPl = h.indexOf("pbp_a_plan_identifier"),
        iSeg = h.indexOf("segment_id"), iSt = h.indexOf("stcd"), iCo = h.indexOf("county"),
        iPend = h.indexOf("pending_flag"), iEghp = h.indexOf("eghp_flag");
  const plan = new Map();
  const segs = new Map();
  for (const line of lines.slice(1)) {
    const c = line.split("\t");
    if (c[iPend] && c[iPend].trim() === "1") continue;
    if (c[iEghp] && c[iEghp].trim() === "1") continue;
    const ct = (c[iHn] || "").trim().toUpperCase();
    const rawPl = (c[iPl] || "").trim();
    const seg = String(parseInt((c[iSeg] || "0").trim() || "0", 10));
    const st = (c[iSt] || "").trim();
    const co = (c[iCo] || "").trim();
    if (!ct || !rawPl || !st || !co) continue;
    const planId = ct + "-" + parseInt(rawPl, 10);
    if (!plan.has(planId)) plan.set(planId, new Map());
    const segMap = plan.get(planId);
    if (!segMap.has(seg)) segMap.set(seg, new Map());
    const stMap = segMap.get(seg);
    if (!stMap.has(st)) stMap.set(st, []);
    stMap.get(st).push(co);
    if (!segs.has(planId)) segs.set(planId, new Set());
    segs.get(planId).add(seg);
  }
  return { plan, segs };
}

(async () => {
  const { plan, segs } = buildPlanArea();
  const multiSeg = [...segs.entries()].filter((e) => e[1].size > 1).map((e) => e[0]);
  console.log("PlanArea " + PLAN_YEAR + ": " + plan.size + " plans; " + multiSeg.length + " multi-segment");

  const sample = await prisma.plan.findMany({
    where: { planYear: PLAN_YEAR, planId: { in: multiSeg } },
    select: { planId: true, sbPdfSourceFilename: true, sbPdfUrl: true },
    distinct: ["planId"],
  });
  const primaryOf = (id) => String([...segs.get(id)].map(Number).sort((a, b) => a - b)[0]);
  const sbSegByPlan = new Map();
  for (const r of sample) {
    sbSegByPlan.set(r.planId, detectSbSegment(r.sbPdfSourceFilename, r.sbPdfUrl) || primaryOf(r.planId));
  }

  const dbPresent = new Set(sample.map((r) => r.planId));
  const loopPlans = multiSeg.filter((id) => dbPresent.has(id));
  console.log("Multi-segment plans present in DB: " + loopPlans.length);

  const tasks = [];
  for (const planId of loopPlans) {
    const sbSeg = sbSegByPlan.get(planId);
    for (const [seg, stMap] of plan.get(planId)) {
      for (const [state, counties] of stMap) {
        tasks.push({ planId, seg, sbSeg, state, counties });
      }
    }
  }

  let totalRows = 0, gatedRows = 0;
  const CONC = 8;
  const queue = tasks.slice();
  async function worker() {
    while (queue.length) {
      const t = queue.pop();
      const res = await prisma.plan.updateMany({
        where: { planYear: PLAN_YEAR, planId: t.planId, state: t.state, county: { in: t.counties } },
        data: { segmentId: t.seg, sbSegmentId: t.sbSeg },
      });
      totalRows += res.count;
      if (t.seg !== t.sbSeg) gatedRows += res.count;
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  console.log("updateMany calls: " + tasks.length + "; rows tagged: " + totalRows + "; rows gated: " + gatedRows);

  const v = await prisma.plan.findMany({
    where: { planId: "H4407-30", planYear: PLAN_YEAR },
    select: { county: true, segmentId: true, sbSegmentId: true }, orderBy: { county: "asc" },
  });
  const bySeg = {};
  for (const s of v) { (bySeg[s.segmentId] = bySeg[s.segmentId] || []).push(s.county); }
  console.log("H4407-30 sbSegmentId=" + (v[0] && v[0].sbSegmentId) + " segByCounty=" + JSON.stringify(bySeg));
  await prisma.$disconnect();
})().catch((e) => { console.error("ERR", e); process.exit(1); });
