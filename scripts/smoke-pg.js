// scripts/smoke-pg.js
//
// Sandbox-friendly smoke test: connects directly via node-pg (no Prisma)
// so it can run from a Linux sandbox without rebuilding Prisma engines.
// Mirrors GET /api/plans ranking logic (app/api/plans/route.ts).
//
// Usage (sandbox or Windows): STATE=FL CATEGORY=MAPD node scripts/smoke-pg.js
// CATEGORY: MAPD | CSNP | DSNP
//
// Reads DATABASE_URL from process.env or repo .env. Uses DIRECT_URL when
// available (avoids pooler overhead for one-off queries).

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

function readUrl() {
  if (process.env.DIRECT_URL) return process.env.DIRECT_URL;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = path.join(__dirname, '..', '.env');
  const raw = fs.readFileSync(envPath, 'utf8');
  const direct = raw.match(/^\s*DIRECT_URL\s*=\s*["']?([^"'\n\r]+)["']?\s*$/m);
  if (direct) return direct[1];
  const db = raw.match(/^\s*DATABASE_URL\s*=\s*["']?([^"'\n\r]+)["']?\s*$/m);
  if (db) return db[1];
  throw new Error('No DIRECT_URL or DATABASE_URL found.');
}

const LICENSED_CARRIERS = [
  'Cigna', 'Cigna Healthcare', 'HealthSpring', 'UnitedHealthcare',
  'Wellcare', 'Aetna Medicare', 'Humana', 'Devoted Health',
];

const STATE = process.env.STATE || 'FL';
const CATEGORY = (process.env.CATEGORY || 'MAPD').toUpperCase();
const YEAR = parseInt(process.env.YEAR || '2026', 10);
const POOL = 25000;

function cmp(a, b, asc) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return asc ? a - b : b - a;
}
function parseHosp(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || /^none$/i.test(s)) return null;
  let m = s.match(/\$?\s*(\d+(?:\.\d+)?)\s*(?:\/|per\s*)day/i);
  if (m) return parseFloat(m[1]);
  m = s.match(/\$?\s*(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}
function hasBR(v) {
  if (v == null) return 1;
  const s = String(v).trim();
  if (!s) return 1;
  if (/^(none|no\b|not\s+covered)/i.test(s)) return 1;
  return 0;
}
function num(v) {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function cmpDesc(a, b) { return num(b) - num(a); }
function dedupeCarrier(arr, n) {
  const seen = new Set(); const out = [];
  for (const p of arr) {
    const k = String(p.organizationName ?? '').toLowerCase().trim();
    if (!k || seen.has(k)) continue;
    seen.add(k); out.push(p);
    if (out.length >= n) break;
  }
  return out;
}

function defaultCmp(a, b) {
  let c = cmp(a.monthlyPremium, b.monthlyPremium, true); if (c) return c;
  c = cmp(a.medicalDeductible, b.medicalDeductible, true); if (c) return c;
  c = cmp(parseHosp(a.hospitalStayCopay), parseHosp(b.hospitalStayCopay), true); if (c) return c;
  c = cmp(a.specialistCopay, b.specialistCopay, true); if (c) return c;
  c = cmp(a.maxOutOfPocket, b.maxOutOfPocket, true); if (c) return c;
  return cmp(a.starRating, b.starRating, false);
}
function csnpCmp(a, b) {
  let c = cmp(a.monthlyPremium, b.monthlyPremium, true); if (c) return c;
  c = cmp(a.foodCardAllowance, b.foodCardAllowance, false); if (c) return c;
  c = cmp(a.otcAllowance, b.otcAllowance, false); if (c) return c;
  c = cmpDesc(a.dentalAnnualMax, b.dentalAnnualMax); if (c) return c;
  c = hasBR(a.dentalBenefits) - hasBR(b.dentalBenefits); if (c) return c;
  c = cmp(parseHosp(a.hospitalStayCopay), parseHosp(b.hospitalStayCopay), true); if (c) return c;
  c = cmpDesc(a.visionAnnualMax, b.visionAnnualMax); if (c) return c;
  return hasBR(a.visionBenefits) - hasBR(b.visionBenefits);
}
function dsnpCmp(a, b) {
  let c = cmp(a.foodCardAllowance, b.foodCardAllowance, false); if (c) return c;
  c = cmp(a.otcAllowance, b.otcAllowance, false); if (c) return c;
  c = cmpDesc(a.dentalAnnualMax, b.dentalAnnualMax); if (c) return c;
  c = hasBR(a.dentalBenefits) - hasBR(b.dentalBenefits); if (c) return c;
  c = cmpDesc(a.visionAnnualMax, b.visionAnnualMax); if (c) return c;
  c = hasBR(a.visionBenefits) - hasBR(b.visionBenefits); if (c) return c;
  c = cmp(parseHosp(a.hospitalStayCopay), parseHosp(b.hospitalStayCopay), true); if (c) return c;
  return cmp(a.monthlyPremium, b.monthlyPremium, true);
}
function picker(cat) {
  if (cat === 'CSNP') return { name: 'C-SNP (premium > food > OTC > dental$ > dentalStr > hosp > vision$ > visionStr)', fn: csnpCmp };
  if (cat === 'DSNP' || cat === 'ISNP') return { name: 'D-SNP (food > OTC > dental$ > dentalStr > vision$ > visionStr > hosp > premium)', fn: dsnpCmp };
  return { name: 'Default 6-key (premium > deductible > hosp > spec > MOOP > star)', fn: defaultCmp };
}
function fmt(v) {
  if (v == null) return 'NULL';
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? '$' + n.toLocaleString() : String(v);
}

async function main() {
  const url = readUrl();
  const client = new Client({ connectionString: url });
  await client.connect();

  const sql = `
    SELECT "planId","planName","organizationName","state","county","planType","planCategory",
           "monthlyPremium","medicalDeductible","hospitalStayCopay","specialistCopay",
           "maxOutOfPocket","starRating","foodCardAllowance","otcAllowance",
           "dentalAnnualMax","dentalBenefits","hearingAnnualMax","visionAnnualMax","visionBenefits"
    FROM "Plan"
    WHERE "planYear" = $1
      AND "state" = $2
      AND "planCategory"::text = $3
      AND "planCategory"::text != 'ISNP'
      AND "organizationName" = ANY($4)
    LIMIT $5;
  `;
  const params = [YEAR, STATE, CATEGORY, LICENSED_CARRIERS, POOL];
  const t0 = Date.now();
  const { rows } = await client.query(sql, params);
  const ms = Date.now() - t0;

  const { name: cmpName, fn: cmpFn } = picker(CATEGORY);
  const sorted = rows.slice().map((r) => ({
    ...r,
    monthlyPremium: r.monthlyPremium != null ? Number(r.monthlyPremium) : null,
    medicalDeductible: r.medicalDeductible != null ? Number(r.medicalDeductible) : null,
    specialistCopay: r.specialistCopay != null ? Number(r.specialistCopay) : null,
    maxOutOfPocket: r.maxOutOfPocket != null ? Number(r.maxOutOfPocket) : null,
    foodCardAllowance: r.foodCardAllowance != null ? Number(r.foodCardAllowance) : null,
    otcAllowance: r.otcAllowance != null ? Number(r.otcAllowance) : null,
    dentalAnnualMax: r.dentalAnnualMax != null ? Number(r.dentalAnnualMax) : null,
    visionAnnualMax: r.visionAnnualMax != null ? Number(r.visionAnnualMax) : null,
    hearingAnnualMax: r.hearingAnnualMax != null ? Number(r.hearingAnnualMax) : null,
    starRating: r.starRating != null ? Number(r.starRating) : null,
  })).sort(cmpFn);

  const top5 = dedupeCarrier(sorted, 5);

  console.log('============================================================');
  console.log(`Smoke test  STATE=${STATE}  CATEGORY=${CATEGORY}  YEAR=${YEAR}`);
  console.log(`Comparator: ${cmpName}`);
  console.log(`Candidate rows pulled: ${rows.length}  (query ${ms}ms)`);
  console.log(`Distinct carriers in pool: ${new Set(rows.map((r) => r.organizationName)).size}`);
  console.log('============================================================');

  const isSnp = ['CSNP', 'DSNP', 'ISNP'].includes(CATEGORY);
  for (let i = 0; i < top5.length; i++) {
    const p = top5[i];
    console.log(`#${i + 1}  ${p.planId}  ${p.organizationName}`);
    console.log(`    ${p.planName}  (${p.state}/${p.county})  [${p.planCategory}/${p.planType}]`);
    if (isSnp) {
      console.log(`    Premium: ${fmt(p.monthlyPremium)}  | Food: ${fmt(p.foodCardAllowance)}  | OTC: ${fmt(p.otcAllowance)}`);
      console.log(`    DentalMax: ${fmt(p.dentalAnnualMax)}  | VisionMax: ${fmt(p.visionAnnualMax)}  | HearingMax: ${fmt(p.hearingAnnualMax)}`);
      console.log(`    Hospital: ${p.hospitalStayCopay ?? 'NULL'}  (day1=${parseHosp(p.hospitalStayCopay) ?? 'NULL'})`);
      console.log(`    Dental(str): ${p.dentalBenefits ?? 'NULL'}  | Vision(str): ${p.visionBenefits ?? 'NULL'}`);
    } else {
      console.log(`    1. Premium:    ${fmt(p.monthlyPremium)}`);
      console.log(`    2. Deductible: ${fmt(p.medicalDeductible)}`);
      console.log(`    3. Hospital:   ${p.hospitalStayCopay ?? 'NULL'}  (day1=${parseHosp(p.hospitalStayCopay) ?? 'NULL'})`);
      console.log(`    4. Specialist: ${fmt(p.specialistCopay)}`);
      console.log(`    5. MOOP:       ${fmt(p.maxOutOfPocket)}`);
      console.log(`    6. Star:       ${p.starRating ?? 'NULL'}`);
    }
    console.log('');
  }

  let monotone = true;
  console.log('=== Invariant: adjacent pair comparator check ===');
  for (let i = 0; i < top5.length - 1; i++) {
    const c = cmpFn(top5[i], top5[i + 1]);
    console.log(`  ${c <= 0 ? 'OK   ' : 'FAIL '} rank ${i + 1} vs rank ${i + 2}: cmp=${c}`);
    if (c > 0) monotone = false;
  }
  console.log(monotone ? '  Monotone -> ranking chain OK.' : '  REGRESSION: ranking chain not monotone.');

  console.log('=== Carriers in top 5 (must be 5 distinct) ===');
  const carriers = top5.map((p) => p.organizationName);
  console.log('  ' + carriers.join(', '));
  console.log(new Set(carriers).size === top5.length ? '  Dedupe OK.' : '  REGRESSION: duplicate carrier.');

  await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
