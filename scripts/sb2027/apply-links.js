// scripts/sb2027/apply-links.js — attach the validated 2027 Summary-of-Benefits links to planYear=2027 rows.
//
//   node scripts/sb2027/apply-links.js                  # dry-run: what would change
//   node scripts/sb2027/apply-links.js --verify-blobs   # dry-run + HEAD every blob URL (200 + byte size)
//   node scripts/sb2027/apply-links.js --apply          # write
//
// Source: scripts/data/sb-links-2027.json (built by acquire.js / upload.js; key = <contract>-<plan3>-<seg>).
// Each row gets the SB of ITS OWN segment: a manifest entry with seg "0" goes to the plan's non-segmented rows
// (segmentId NULL); seg "N" goes only to rows with segmentId = "N". sbSegmentId is set to segmentId, which opens
// the segment gate in /api/plans (isSbSegmentMismatch). Rows whose segment has no SB yet are left untouched.
//
// planYear is hard-coded to 2027. 2026 rows are never read or written.
// One set-based UPDATE (not a per-plan loop), so it finishes in seconds. Idempotent: rows already holding the
// manifest URL are skipped. Entries with blobUrl:null (staged but not uploaded) are skipped and reported —
// run upload.js first.
// RE-RUN this after `backfill-segment-ids.js 2027`: that script resets sbSegmentId to one value per plan.
const fs = require('fs'), path = require('path');
const { makePrisma } = require('../prisma-client');
const YEAR = 2027;
const APPLY = process.argv.includes('--apply'), VERIFY = process.argv.includes('--verify-blobs');
const MANIFEST = path.join(__dirname, '..', 'data', 'sb-links-2027.json');
const num = (r) => JSON.parse(JSON.stringify(r, (k, v) => (typeof v === 'bigint' ? Number(v) : v)));

async function verifyBlobs(entries) {
  let i = 0; const bad = [];
  async function head(e) {
    let last = '';
    for (let t = 0; t < 4; t++) {   // connect timeouts are common through a proxy: retry before calling a blob bad
      try {
        const r = await fetch(e.url, { method: 'HEAD', signal: AbortSignal.timeout(20000) });
        const len = parseInt(r.headers.get('content-length') || '-1', 10);
        if (!r.ok) return e.key + ' http_' + r.status;
        return len === e.bytes ? null : e.key + ' size ' + len + ' != ' + e.bytes;
      } catch (er) { last = e.key + ' fetch_' + (er.cause?.code || er.name || er.message); await new Promise((r) => setTimeout(r, 500 * (t + 1))); }
    }
    return last;
  }
  async function worker() { while (i < entries.length) { const b = await head(entries[i++]); if (b) bad.push(b); } }
  await Promise.all(Array.from({ length: 8 }, worker));
  return bad;
}

(async () => {
  const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const all = Object.entries(m);
  const notUploaded = all.filter(([, v]) => !v.blobUrl).map(([k]) => k);
  const entries = all.filter(([, v]) => v.blobUrl).map(([k, v]) => ({ key: k, planId: v.planId, seg: String(v.seg), url: v.blobUrl, sha: v.sha256, src: v.sourceUrl, bytes: v.bytes, carrier: v.carrier }));
  console.log(`manifest: ${all.length} plan-segments; ${entries.length} with a blob URL; ${notUploaded.length} staged but NOT uploaded (skipped)`);
  if (notUploaded.length) console.log('  not uploaded (first 10):', notUploaded.slice(0, 10).join(', '));

  if (VERIFY) {
    const bad = await verifyBlobs(entries);
    console.log(`blob check: ${entries.length - bad.length} ok, ${bad.length} bad`);
    if (bad.length) { console.log(bad.slice(0, 40).join('\n')); if (APPLY) { console.log('refusing to apply with bad blobs'); process.exit(1); } }
  }

  const prisma = makePrisma();
  const payload = JSON.stringify(entries.map(({ planId, seg, url, sha, src }) => ({ planId, seg, url, sha, src })));
  const V = `jsonb_to_recordset($1::jsonb) AS v("planId" text, seg text, url text, sha text, src text)`;
  const JOIN = `p."planYear" = ${YEAR} AND p."planId" = v."planId" AND coalesce(p."segmentId", '0') = v.seg`;
  try {
    const before = num(await prisma.$queryRawUnsafe(`SELECT count(*) AS rows, count("sbPdfUrl") AS linked FROM "Plan" WHERE "planYear" = ${YEAR}`))[0];
    const match = num(await prisma.$queryRawUnsafe(
      `SELECT count(*) AS rows, count(DISTINCT (p."planId", coalesce(p."segmentId", '0'))) AS segs,
              count(*) FILTER (WHERE p."sbPdfUrl" IS DISTINCT FROM v.url OR p."sbSegmentId" IS DISTINCT FROM p."segmentId") AS to_change,
              count(*) FILTER (WHERE p."sbPdfUrl" IS NOT NULL AND p."sbPdfUrl" <> v.url) AS overwrite
       FROM "Plan" p JOIN ${V} ON ${JOIN}`, payload))[0];
    const orphans = num(await prisma.$queryRawUnsafe(
      `SELECT v."planId", v.seg FROM ${V} WHERE NOT EXISTS (SELECT 1 FROM "Plan" p WHERE ${JOIN})`, payload));
    console.log(`2027 rows: ${before.rows} (${before.linked} already linked)`);
    console.log(`manifest matches ${match.rows} rows in ${match.segs} plan-segments; ${match.to_change} rows would change; ${match.overwrite} would replace a different existing link`);
    console.log(`manifest entries with no 2027 row: ${orphans.length}` + (orphans.length ? ' -> ' + orphans.slice(0, 20).map((o) => o.planId + '/s' + o.seg).join(', ') : ''));

    if (APPLY) {
      const n = await prisma.$executeRawUnsafe(
        `UPDATE "Plan" p SET "sbPdfUrl" = v.url, "sbPdfChecksum" = v.sha, "sbPdfSourceFilename" = v.src,
                "sbSegmentId" = p."segmentId", "sbDiscoveryConfidence" = 0.98, "sbLastProcessedAt" = now(), "updatedAt" = now()
         FROM ${V}
         WHERE ${JOIN} AND (p."sbPdfUrl" IS DISTINCT FROM v.url OR p."sbSegmentId" IS DISTINCT FROM p."segmentId")`, payload);
      console.log(`APPLIED: ${n} rows updated`);
    } else console.log('[dry-run] nothing written. Re-run with --apply.');

    const after = num(await prisma.$queryRawUnsafe(
      `SELECT "organizationName" AS carrier,
              count(DISTINCT ("planId", coalesce("segmentId", '0'))) AS segs,
              count(DISTINCT ("planId", coalesce("segmentId", '0'))) FILTER (WHERE "sbPdfUrl" IS NOT NULL) AS segs_linked,
              count(*) AS rows, count("sbPdfUrl") AS rows_linked,
              count(*) FILTER (WHERE "segmentId" IS NOT NULL AND "sbSegmentId" IS DISTINCT FROM "segmentId") AS gated_rows
       FROM "Plan" WHERE "planYear" = ${YEAR} GROUP BY 1 ORDER BY 1`));
    console.log('2027 coverage now (plan-segments linked / total, rows linked / total, rows still segment-gated):');
    for (const r of after) console.log(`  ${r.carrier.padEnd(18)} ${r.segs_linked}/${r.segs}  rows ${r.rows_linked}/${r.rows}  gated ${r.gated_rows}`);
    const t = after.reduce((a, r) => ({ s: a.s + r.segs, sl: a.sl + r.segs_linked, r: a.r + r.rows, rl: a.rl + r.rows_linked }), { s: 0, sl: 0, r: 0, rl: 0 });
    console.log(`  TOTAL              ${t.sl}/${t.s}  rows ${t.rl}/${t.r}`);
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error(e); process.exit(1); });
