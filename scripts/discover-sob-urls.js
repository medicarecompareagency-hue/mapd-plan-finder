// scripts/discover-sob-urls.js
//
// Drives medicare.gov's Plan Compare via Playwright to harvest the
// Summary of Benefits URL for each no-PBP plan. The URL is an
// unguessable carrier-hosted PDF (per-plan document ID), but CMS
// embeds the correct link on every plan detail page.
//
// Pilot: Ascension Complete (36 plans, now Wellcare Complete brand).
// Expand later: CARRIER=Wellcare node scripts/discover-sob-urls.js
//
// Prereqs (one-time):
//   npm install --save-dev playwright
//   npx playwright install chromium
//
// Usage:
//   node scripts/discover-sob-urls.js                         # default carrier = Ascension Complete
//   $env:CARRIER='Wellcare'; node scripts/discover-sob-urls.js
//   $env:HEADLESS='false'; node scripts/discover-sob-urls.js  # watch it run
//
// Input:  scripts/data/no-pbp-plans.csv  (from list-no-pbp-plans.js)
// Output: scripts/data/sob-urls-<carrier-slug>.json
//         — appended as we go, so a crash doesn't lose progress.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CARRIER = process.env.CARRIER || 'Ascension Complete';
const HEADLESS = process.env.HEADLESS !== 'false';
const INPUT = path.join(__dirname, 'data', 'no-pbp-plans.csv');
const slug = CARRIER.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const OUT = path.join(__dirname, 'data', `sob-urls-${slug}.json`);

// Parse our CSV format: planId,planYear,organizationName,state,planType,planCategory
// organizationName is quoted; other fields aren't.
function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const rows = [];
  for (const line of lines.slice(1)) {
    // Split on commas NOT inside double quotes.
    const parts = line.match(/(?:^|,)("(?:[^"]|"")*"|[^,]*)/g) || [];
    const clean = parts.map((p) => p.replace(/^,/, '').replace(/^"|"$/g, '').replace(/""/g, '"'));
    rows.push({
      planId: clean[0],
      planYear: parseInt(clean[1], 10),
      organizationName: clean[2],
      state: clean[3],
      planType: clean[4],
      planCategory: clean[5],
    });
  }
  return rows;
}

// CSV planId is like "H7556-2" (contract-plan). medicare.gov's URL needs
// {year}-{contract}-{planPadded3}-{segment3}. Segment is almost always 000.
function buildPlanDetailUrl({ planId, planYear }) {
  const [contract, rawPlan] = planId.split('-');
  const planPadded = String(rawPlan).padStart(3, '0');
  return `https://www.medicare.gov/plan-compare/#/plan-details/${planYear}-${contract}-${planPadded}-0?year=${planYear}&lang=en`;
}

async function discoverOne(page, row) {
  const url = buildPlanDetailUrl(row);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // medicare.gov is a heavy SPA. Wait for the plan details panel to render.
    // The SOB link text varies slightly — try a few selectors.
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    // Give the SPA a moment after networkidle.
    await page.waitForTimeout(1500);

    const selectors = [
      'a:has-text("Summary of Benefits")',
      'a:has-text("Plan benefit details")',
      'a[href*="summary"][href*=".pdf"]',
      'a[href*="/SB/"]',
      'a[href$=".pdf"]',
    ];
    for (const sel of selectors) {
      const el = await page.locator(sel).first();
      const count = await el.count().catch(() => 0);
      if (!count) continue;
      const href = await el.getAttribute('href').catch(() => null);
      if (href && href.toLowerCase().includes('.pdf')) return { sobUrl: href, matchedSelector: sel };
    }
    return { sobUrl: null, error: 'no SOB link found' };
  } catch (e) {
    return { sobUrl: null, error: e.message };
  }
}

async function main() {
  if (!fs.existsSync(INPUT)) {
    console.error(`Missing input file: ${INPUT}`);
    console.error('Run: node scripts/list-no-pbp-plans.js first.');
    process.exit(1);
  }
  const all = parseCsv(fs.readFileSync(INPUT, 'utf8'));
  const filtered = all.filter((r) => r.organizationName === CARRIER);
  console.log(`Carrier filter: "${CARRIER}"`);
  console.log(`Matched ${filtered.length} plans from ${all.length} total.`);
  if (!filtered.length) {
    console.error('No plans match that carrier. Check spelling against no-pbp-plans-by-carrier.csv.');
    process.exit(1);
  }

  // Resume if partial output exists.
  let results = [];
  if (fs.existsSync(OUT)) {
    try {
      results = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      console.log(`Resuming: ${results.length} already done.`);
    } catch {
      results = [];
    }
  }
  const doneKeys = new Set(results.map((r) => r.planId));
  const todo = filtered.filter((r) => !doneKeys.has(r.planId));
  console.log(`To process: ${todo.length}\n`);

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  });
  const page = await context.newPage();

  for (let i = 0; i < todo.length; i++) {
    const row = todo[i];
    process.stdout.write(`[${i + 1}/${todo.length}] ${row.planId} ${row.state} ... `);
    const res = await discoverOne(page, row);
    results.push({ ...row, ...res });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
    if (res.sobUrl) {
      console.log(`OK  ${res.sobUrl.slice(0, 90)}${res.sobUrl.length > 90 ? '...' : ''}`);
    } else {
      console.log(`MISS  ${res.error || ''}`);
    }
    // Be polite.
    await page.waitForTimeout(1500);
  }

  await browser.close();

  const hits = results.filter((r) => r.sobUrl).length;
  console.log('');
  console.log(`Done. ${hits}/${results.length} SOB URLs discovered.`);
  console.log(`Output: ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
