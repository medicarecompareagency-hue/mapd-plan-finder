// Propagate sbPdfUrl from rows that have it to sibling county rows that don't.
// Grouping key: planId + planYear (a single SB PDF covers all counties for a plan).
// Set-based SQL — one UPDATE per batch, not row-by-row.
// Run: node scripts/propagate-sb-urls.js
//      node scripts/propagate-sb-urls.js --dry-run

const { makePrisma } = require('./prisma-client.js');
const { LICENSED_STATES } = require('./licensed-states.js');
const { LICENSED_CARRIERS } = require('./licensed-carriers.js');

const DRY_RUN = process.argv.includes('--dry-run');

(async () => {
  const prisma = makePrisma();

  // ── BEFORE stats ──────────────────────────────────────────────────────────

  // Groups with at least one URL set
  const withUrl = await prisma.plan.findMany({
    where: {
      planYear: 2026,
      state: { in: LICENSED_STATES },
      organizationName: { in: LICENSED_CARRIERS },
      sbPdfUrl: { not: null },
    },
    select: { planId: true, planYear: true, sbPdfUrl: true, sbDiscoveryConfidence: true, sbLastProcessedAt: true },
    distinct: ['planId', 'planYear'],
    orderBy: [{ planId: 'asc' }],
  });

  // Groups with at least one null URL (the ones that need work)
  const withNull = await prisma.plan.findMany({
    where: {
      planYear: 2026,
      state: { in: LICENSED_STATES },
      organizationName: { in: LICENSED_CARRIERS },
      sbPdfUrl: null,
    },
    select: { planId: true, planYear: true },
    distinct: ['planId', 'planYear'],
  });

  const withUrlSet = new Set(withUrl.map(r => `${r.planId}|${r.planYear}`));
  const withNullSet = new Set(withNull.map(r => `${r.planId}|${r.planYear}`));
  const needsPropagation = [...withUrlSet].filter(k => withNullSet.has(k));
  const fullyMissing = [...withNullSet].filter(k => !withUrlSet.has(k));

  console.log('=== BEFORE ===');
  console.log(`Groups with sbPdfUrl set (at least one county row):  ${withUrlSet.size}`);
  console.log(`Groups with sbPdfUrl null (at least one county row): ${withNullSet.size}`);
  console.log(`  → need propagation (have URL on some rows, null on others): ${needsPropagation.length}`);
  console.log(`  → fully missing (no county row has URL): ${fullyMissing.length}`);

  // Check for URL mismatches within groups that need propagation
  const mismatchGroups = [];
  for (const key of needsPropagation) {
    const [planId, planYear] = key.split('|');
    const urls = await prisma.plan.findMany({
      where: { planId, planYear: Number(planYear), sbPdfUrl: { not: null } },
      select: { sbPdfUrl: true },
      distinct: ['sbPdfUrl'],
    });
    if (urls.length > 1) {
      mismatchGroups.push({ planId, planYear, urls: urls.map(u => u.sbPdfUrl) });
    }
  }
  if (mismatchGroups.length) {
    console.log(`\nWARNING: ${mismatchGroups.length} groups have multiple different sbPdfUrls:`);
    for (const g of mismatchGroups) {
      console.log(`  ${g.planId} (${g.planYear}):`);
      for (const u of g.urls) console.log(`    ${u}`);
    }
  }

  if (DRY_RUN) {
    console.log('\n[dry-run] Would propagate to all null county rows. Re-run without --dry-run to apply.');
    await prisma.$disconnect();
    return;
  }

  // ── PROPAGATION — single set-based UPDATE ─────────────────────────────────
  // For each planId+planYear that has at least one sbPdfUrl, copy the URL
  // (highest sbDiscoveryConfidence wins on ties) to all null sibling rows.
  // We do one UPDATE...FROM in raw SQL for efficiency.

  const stateList = LICENSED_STATES.map(s => `'${s}'`).join(',');
  const carrierList = LICENSED_CARRIERS.map(c => `'${c.replace(/'/g, "''")}'`).join(',');

  const result = await prisma.$executeRawUnsafe(`
    UPDATE "Plan" p
    SET
      "sbPdfUrl"               = src."sbPdfUrl",
      "sbDiscoveryConfidence"  = src."sbDiscoveryConfidence",
      "sbLastProcessedAt"      = src."sbLastProcessedAt"
    FROM (
      SELECT DISTINCT ON ("planId", "planYear")
        "planId",
        "planYear",
        "sbPdfUrl",
        "sbDiscoveryConfidence",
        "sbLastProcessedAt"
      FROM "Plan"
      WHERE "sbPdfUrl" IS NOT NULL
        AND "planYear" = 2026
      ORDER BY "planId", "planYear",
               "sbDiscoveryConfidence" DESC NULLS LAST
    ) src
    WHERE p."planId"           = src."planId"
      AND p."planYear"         = src."planYear"
      AND p."sbPdfUrl"         IS NULL
      AND p."state"            = ANY(ARRAY[${stateList}]::text[])
      AND p."organizationName" = ANY(ARRAY[${carrierList}]::text[])
  `);

  console.log(`\nRows updated: ${result}`);

  // ── AFTER stats ───────────────────────────────────────────────────────────
  const afterNull = await prisma.plan.count({
    where: {
      planYear: 2026,
      state: { in: LICENSED_STATES },
      organizationName: { in: LICENSED_CARRIERS },
      sbPdfUrl: null,
    },
  });
  const afterSet = await prisma.plan.count({
    where: {
      planYear: 2026,
      state: { in: LICENSED_STATES },
      organizationName: { in: LICENSED_CARRIERS },
      sbPdfUrl: { not: null },
    },
  });

  // Groups fully propagated = had null before, now all rows have URL
  const stillPartial = await prisma.plan.findMany({
    where: {
      planYear: 2026,
      state: { in: LICENSED_STATES },
      organizationName: { in: LICENSED_CARRIERS },
      sbPdfUrl: null,
    },
    select: { planId: true },
    distinct: ['planId'],
  });
  const stillPartialWithUrl = await prisma.plan.findMany({
    where: {
      planYear: 2026,
      planId: { in: stillPartial.map(r => r.planId) },
      sbPdfUrl: { not: null },
    },
    select: { planId: true },
    distinct: ['planId'],
  });

  console.log('\n=== AFTER ===');
  console.log(`County rows with sbPdfUrl set:  ${afterSet.toLocaleString()}`);
  console.log(`County rows with sbPdfUrl null: ${afterNull.toLocaleString()}`);
  console.log(`Groups fully propagated (no remaining null rows): ${needsPropagation.length - stillPartialWithUrl.length}`);
  console.log(`Groups still partial (should be 0):               ${stillPartialWithUrl.length}`);
  if (stillPartialWithUrl.length) {
    console.log('  Still-partial plan IDs:', stillPartialWithUrl.map(r => r.planId).join(', '));
  }

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
