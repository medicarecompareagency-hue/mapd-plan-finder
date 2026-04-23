// scripts/discover-sob-urls-v2.js
//
// v2: medicare.gov's plan-details hash URL can't be deep-linked cold.
// The SPA shows "Unable to view Plan Details" unless ZIP/session is set.
// This version walks the Plan Compare wizard once per state to
// establish session, THEN navigates to plan-details for each plan.
//
// RECON MODE (default): targets just Indiana Ascension plans (2 of them)
// with HEADLESS=false so you can watch. If it works we generalize.
//
// Usage:
//   node scripts/discover-sob-urls-v2.js
//   $env:HEADLESS='true'; node scripts/discover-sob-urls-v2.js
//   $env:DEBUG='true'; node scripts/discover-sob-urls-v2.js  # pause after each step
//
// Output: scripts/data/sob-urls-v2-recon.json

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const HEADLESS = process.env.HEADLESS === 'true'; // default VISIBLE
const DEBUG = process.env.DEBUG === 'true';
const OUT = path.join(__dirname, 'data', 'sob-urls-v2-recon.json');

// Major-city ZIPs for Dale's 18 licensed states.
const STATE_ZIPS = {
  AL: '35203', AR: '72201', FL: '32301', GA: '30303', IL: '60601',
  IN: '46204', KS: '66603', KY: '40202', LA: '70112', MO: '63101',
  MS: '39201', OH: '43215', OK: '73102', SC: '29201', TN: '37203',
  TX: '78701', VA: '23219', WV: '25301',
};

// Recon set: two Indiana Ascension plans.
const RECON_PLANS = [
  { planId: 'H1774-1', planYear: 2026, state: 'IN', organizationName: 'Ascension Complete' },
  { planId: 'H1774-2', planYear: 2026, state: 'IN', organizationName: 'Ascension Complete' },
];

function log(msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] ${msg}`);
}

async function pause(page, label) {
  if (!DEBUG) return;
  log(`PAUSED at: ${label} — press Enter in this terminal to continue`);
  await new Promise((resolve) => process.stdin.once('data', resolve));
}

// Try to click the first visible element matching any of the selectors.
// Returns the selector that worked, or null.
async function tryClick(page, selectors, label, timeout = 3000) {
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    try {
      const visible = await el.isVisible({ timeout: 500 }).catch(() => false);
      if (!visible) continue;
      await el.click({ timeout });
      log(`  clicked [${label}]: ${sel}`);
      return sel;
    } catch {
      // keep trying
    }
  }
  return null;
}

// Try to fill the first visible input matching any selector.
async function tryFill(page, selectors, value, label) {
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    try {
      const visible = await el.isVisible({ timeout: 500 }).catch(() => false);
      if (!visible) continue;
      await el.fill(value);
      log(`  filled [${label}]=${value}: ${sel}`);
      return sel;
    } catch {}
  }
  return null;
}

async function initSession(page, state) {
  const zip = STATE_ZIPS[state];
  if (!zip) throw new Error(`No ZIP mapped for state ${state}`);
  log(`Initializing session for ${state} (ZIP ${zip})`);

  // 1. Homepage
  log('  GET plan-compare homepage');
  await page.goto('https://www.medicare.gov/plan-compare/#/?lang=en&year=2026', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await pause(page, 'homepage loaded');

  // 2. "Continue without logging in" (if prompted)
  await tryClick(
    page,
    [
      'a:has-text("Continue without logging in")',
      'button:has-text("Continue without logging in")',
      ':is(a,button):has-text("without logging in")',
      ':is(a,button):has-text("Continue as guest")',
    ],
    'guest login',
  );
  await page.waitForTimeout(1500);

  // 3. ZIP entry
  const zipFilled = await tryFill(
    page,
    [
      'input[name="zipCode"]',
      'input#zip',
      'input[name="zip"]',
      'input[placeholder*="ZIP" i]',
      'input[aria-label*="ZIP" i]',
      'input[type="text"]',
      'input[type="tel"]',
    ],
    zip,
    'zip',
  );
  if (!zipFilled) {
    log('  WARN: could not find ZIP input. DOM may have changed.');
    await pause(page, 'ZIP input not found');
  }
  await page.waitForTimeout(500);

  // 4. Submit ZIP
  await tryClick(
    page,
    [
      'button:has-text("Continue")',
      'button:has-text("Start")',
      'button:has-text("Find plans")',
      'button:has-text("Search")',
      'button[type="submit"]',
    ],
    'submit zip',
  );
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);
  await pause(page, 'post-ZIP');

  // 5. Best-effort wizard walk: keep clicking safe defaults for up to 6 steps.
  //    - "I have Original Medicare" or "I'm not sure" or "Continue"
  //    - "No" to getting help paying costs
  //    - "Medicare Advantage Plan" for plan type
  //    - "Continue" to advance
  const wizardClicks = [
    // Medicare status: pick "I'm new to Medicare" or "Continue" / skip
    [':is(button,a):has-text("I\'m new to Medicare")', ':is(button,a):has-text("I have Original Medicare")'],
    // Any "No" for subsidy questions
    [':is(button,a):has-text("No"):not(:has-text("None"))'],
    // Plan type: Medicare Advantage
    [':is(button,a,label):has-text("Medicare Advantage")', 'input[value*="MA" i]'],
    // Generic advance
    ['button:has-text("Continue")', 'button:has-text("Next")', 'button:has-text("Apply")'],
  ];
  for (let step = 0; step < 6; step++) {
    let advanced = false;
    for (const sels of wizardClicks) {
      const matched = await tryClick(page, sels, `wizard step ${step}`);
      if (matched) {
        advanced = true;
        await page.waitForTimeout(1500);
        break;
      }
    }
    if (!advanced) break;
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  }
  await pause(page, 'wizard done');

  // 6. Dump localStorage so we can see what keys the SPA set.
  try {
    const storage = await page.evaluate(() => {
      const out = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        const v = localStorage.getItem(k);
        out[k] = v && v.length > 200 ? v.slice(0, 200) + '...[truncated]' : v;
      }
      return out;
    });
    log(`  localStorage keys: ${Object.keys(storage).length}`);
    for (const [k, v] of Object.entries(storage)) {
      log(`    ${k} = ${v}`);
    }
  } catch (e) {
    log(`  (localStorage dump failed: ${e.message})`);
  }
}

function buildPlanDetailUrl({ planId, planYear }) {
  const [contract, rawPlan] = planId.split('-');
  const planPadded = String(rawPlan).padStart(3, '0');
  return `https://www.medicare.gov/plan-compare/#/plan-details/${planYear}-${contract}-${planPadded}-0?year=${planYear}&lang=en`;
}

async function extractSob(page, plan) {
  const url = buildPlanDetailUrl(plan);
  log(`Plan ${plan.planId}: GET ${url}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // Sanity check: did we hit the error page again?
    const errCount = await page.locator(':has-text("Unable to view Plan Details")').count().catch(() => 0);
    if (errCount > 0) {
      return { sobUrl: null, error: 'Unable to view Plan Details (session not honored)' };
    }

    await pause(page, `plan-details for ${plan.planId}`);

    // Try clicking tabs/accordions that might hide the SOB link
    await tryClick(
      page,
      [
        ':is(button,a):has-text("Plan benefits")',
        ':is(button,a):has-text("Plan details")',
        ':is(button,a):has-text("Documents")',
      ],
      'expand panel',
    );
    await page.waitForTimeout(1000);

    // Look for the SOB link
    const selectors = [
      'a:has-text("Summary of Benefits")',
      'a:has-text("Plan benefit details")',
      'a[href*="SummaryOfBenefits" i]',
      'a[href*="Summary-of-Benefits" i]',
      'a[href*="summary"][href*=".pdf"]',
      'a[href*="/sb/" i]',
      'a[href$=".pdf"]',
    ];
    for (const sel of selectors) {
      const els = await page.locator(sel).all();
      for (const el of els) {
        const href = await el.getAttribute('href').catch(() => null);
        if (href && href.toLowerCase().includes('.pdf')) {
          return { sobUrl: href, matchedSelector: sel };
        }
      }
    }

    // Fallback: dump all PDF hrefs we can see
    const allPdfs = await page.$$eval('a[href*=".pdf" i]', (as) => as.map((a) => a.href));
    log(`  (no SOB-labeled link; PDFs visible: ${allPdfs.length})`);
    for (const p of allPdfs.slice(0, 5)) log(`    ${p}`);

    return { sobUrl: null, error: 'no SOB link found on rendered page' };
  } catch (e) {
    return { sobUrl: null, error: e.message };
  }
}

async function main() {
  log(`HEADLESS=${HEADLESS}  DEBUG=${DEBUG}`);
  log(`Recon plans: ${RECON_PLANS.length}`);

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  });
  const page = await context.newPage();

  // Initialize session once for the state (all recon plans are IN).
  await initSession(page, 'IN');

  const results = [];
  for (const plan of RECON_PLANS) {
    const res = await extractSob(page, plan);
    results.push({ ...plan, ...res });
    if (res.sobUrl) {
      log(`  OK  ${res.sobUrl}`);
    } else {
      log(`  MISS  ${res.error}`);
    }
    await page.waitForTimeout(1500);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  log(`Wrote ${OUT}`);

  log('Leaving browser open for 30s so you can inspect. Ctrl+C to quit sooner.');
  await page.waitForTimeout(30000);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
