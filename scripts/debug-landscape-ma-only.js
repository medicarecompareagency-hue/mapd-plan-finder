// scripts/debug-landscape-ma-only.js
// Inspect what's actually in the 23,200 "MA-Only candidate" landscape rows.

const fs = require('fs');
const path = require('path');

const LANDSCAPE_PATH = path.join(process.cwd(), '.cms-import-tmp', 'ma2026.csv');

const STATE_ABBREVS = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA',
  Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE', 'District of Columbia': 'DC',
  Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL',
  Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA',
  Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN',
  Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV',
  'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY',
  'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK',
  Oregon: 'OR', Pennsylvania: 'PA', 'Puerto Rico': 'PR', 'Rhode Island': 'RI',
  'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX',
  Utah: 'UT', Vermont: 'VT', Virginia: 'VA', Washington: 'WA',
  'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY',
};
const LICENSED = new Set(['AL','AR','FL','GA','IL','IN','KS','KY','LA','MO','MS','OH','OK','SC','TN','TX','VA','WV']);

const text = fs.readFileSync(LANDSCAPE_PATH, 'utf-8');
const lines = text.split(/\r?\n/);
const hdr = lines[0].split(',');
console.log('=== ma2026.csv header ===');
console.log(hdr.join(' | '));

let totalRows = 0;
let emptyDrugBenefit = 0;
let emptyDrugInLicensed = 0;
const byOrgAndType = {}; // org|type -> count
const byPlanType = {};
const samplesAL = [];
const samplesMS = [];
const samplesFL = [];
let h4461_075 = null;
let h5216_236 = null;
let r0110_017 = null;

for (let i = 1; i < lines.length; i++) {
  const line = lines[i];
  if (!line) continue;
  totalRows++;
  const c = line.split(',');
  const row = {};
  for (let j = 0; j < hdr.length; j++) row[hdr[j]] = (c[j] || '').trim();

  const drug = (row.drugbenefittype || '').trim();
  const stateAbbrev = STATE_ABBREVS[row.state] || row.state;
  const cid = (row.contractid || '').trim();
  const pid = (row.planid || '').trim();
  const ptype = (row.typeofmedicarehealthplan || '').trim();
  const org = (row.organizationname || '').trim();

  // Specific lookups
  if (cid === 'H4461' && pid === '75' && !h4461_075) h4461_075 = { ...row };
  if (cid === 'H5216' && pid === '236' && !h5216_236) h5216_236 = { ...row };
  if (cid === 'R0110' && pid === '17' && !r0110_017) r0110_017 = { ...row };

  if (!drug) {
    emptyDrugBenefit++;
    const k = org + ' || ' + ptype;
    byOrgAndType[k] = (byOrgAndType[k] || 0) + 1;
    byPlanType[ptype] = (byPlanType[ptype] || 0) + 1;
    if (LICENSED.has(stateAbbrev)) {
      emptyDrugInLicensed++;
      if (stateAbbrev === 'AL' && samplesAL.length < 8) samplesAL.push(`${cid}-${pid} ${org} | ${row.planname} | ${row.county}`);
      if (stateAbbrev === 'MS' && samplesMS.length < 8) samplesMS.push(`${cid}-${pid} ${org} | ${row.planname} | ${row.county}`);
      if (stateAbbrev === 'FL' && samplesFL.length < 8) samplesFL.push(`${cid}-${pid} ${org} | ${row.planname} | ${row.county}`);
    }
  }
}

console.log(`\nTotal landscape rows: ${totalRows}`);
console.log(`Rows with EMPTY drugbenefittype: ${emptyDrugBenefit}`);
console.log(`  ...of which in licensed states: ${emptyDrugInLicensed}`);

console.log(`\n=== plan-type breakdown of empty-drug rows ===`);
for (const [k, v] of Object.entries(byPlanType).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  ${String(v).padStart(6)}  ${k}`);
}

console.log(`\n=== top 15 organizations with empty-drug rows ===`);
for (const [k, v] of Object.entries(byOrgAndType).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  ${String(v).padStart(5)}  ${k}`);
}

console.log(`\n=== Sample empty-drug rows in AL/MS/FL ===`);
console.log('AL:'); samplesAL.forEach(s => console.log('  ', s));
console.log('MS:'); samplesMS.forEach(s => console.log('  ', s));
console.log('FL:'); samplesFL.forEach(s => console.log('  ', s));

console.log(`\n=== Looking up the 3 named Humana plans ===`);
console.log('H4461-75:', h4461_075 ? `FOUND state=${h4461_075.state} county=${h4461_075.county} type=${h4461_075.typeofmedicarehealthplan} drug=[${h4461_075.drugbenefittype}]` : 'NOT IN LANDSCAPE');
console.log('H5216-236:', h5216_236 ? `FOUND state=${h5216_236.state} county=${h5216_236.county} type=${h5216_236.typeofmedicarehealthplan} drug=[${h5216_236.drugbenefittype}]` : 'NOT IN LANDSCAPE');
console.log('R0110-17:', r0110_017 ? `FOUND state=${r0110_017.state} county=${r0110_017.county} type=${r0110_017.typeofmedicarehealthplan} drug=[${r0110_017.drugbenefittype}]` : 'NOT IN LANDSCAPE');
