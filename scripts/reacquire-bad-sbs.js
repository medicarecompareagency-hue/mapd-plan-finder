// scripts/reacquire-bad-sbs.js
// Phase 2: re-acquire SBs for plans flagged BAD by the strict validity audit.
// Tries sources in priority order; validates with the strict rule before upload.
// USAGE:
//   node scripts/reacquire-bad-sbs.js             # dry-run (no DB writes, no uploads)
//   node scripts/reacquire-bad-sbs.js --apply     # write to blob + DB
//
// Checkpoints to reacquire-progress.json (resumable).
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { makePrisma } = require('./prisma-client');

// Load env for BLOB_READ_WRITE_TOKEN
for (const envFile of ['.env', '.env.local']) {
  try {
    fs.readFileSync(path.join(process.cwd(), envFile), 'utf8').split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"]*)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    });
  } catch {}
}

const APPLY   = process.argv.includes('--apply');
const PROG    = 'reacquire-progress.json';
const CONC    = 4;
const PLAN_YEAR = 2026;

const prisma = makePrisma();
const { put } = require('@vercel/blob');

// ─── Strict validation (same as audit-sb-validity.js) ────────────────────────
function pdftext2pg(buf) {
  const tmp = path.join(os.tmpdir(), 'reacq_' + Math.random().toString(36).slice(2) + '.pdf');
  try {
    fs.writeFileSync(tmp, buf);
    return execFileSync('pdftotext', ['-layout', '-f', '1', '-l', '2', tmp, '-'],
                        { maxBuffer: 20 * 1024 * 1024 }).toString('utf8');
  } catch { return ''; }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}
function idVariants(planId) {
  const m = String(planId).match(/([A-Za-z]\d{4})\D*(\d{1,3})/);
  if (!m) return [String(planId)];
  const c = m[1].toUpperCase(), p = m[2], p3 = p.padStart(3, '0'), p2 = String(parseInt(p, 10));
  return [c + '-' + p3, c + '-' + p2, c + ' ' + p3, c + p3, c + '-' + p];
}
function classify(planId, buf, txt) {
  if (!buf || buf.length < 200) return 'too_short';
  if (buf.slice(0, 5).toString('latin1') !== '%PDF-') return 'not_pdf';
  if (!txt || txt.length < 500) return 'too_short';
  const low = txt.toLowerCase();
  const hay = txt.replace(/[\s\-|]/g, '').toUpperCase();
  const hasId = idVariants(planId).some(v => hay.includes(v.replace(/[\s\-]/g, '').toUpperCase()));
  if (!hasId) return 'planid_missing';
  const head = low.slice(0, 2000);
  const badType = /(commission|partnership plan|producer|enrollment (form|request)|frequently asked|\bfaq\b)/.test(head)
                   && !head.includes('summary of benefits');
  if (badType) return 'wrong_doctype';
  const hasSBTitle = low.includes('summary of benefits') || /summary\s+of\s+benefits/i.test(txt);
  if (!hasSBTitle) return 'no_sb_title';
  if (!txt.includes('2026')) { const yr = (txt.match(/20(2[0-5]|1\d)/) || [])[0]; if (yr) return 'stale_year(' + yr + ')'; }
  return 'GOOD';
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────
async function fetchBuf(url) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.medicare.gov/' },
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch { return null; }
}

// ─── Candidate URL strategies per plan ───────────────────────────────────────
function candidates(planId, dlEntry, carrier) {
  const urls = [];
  const dlUrl = dlEntry?.url;
  const dlFn  = dlUrl ? dlUrl.split('/').pop() : '';

  // 1. If DL source URL looks like a 2026 SB (not EOC, not stale), try it first.
  if (dlUrl && /SB26|SB-2026|SB2026|2026.*SB|summary.*of.*benefit/i.test(dlFn)
            && !/EOC|eoc-/i.test(dlFn)) {
    urls.push(dlUrl);
  }

  // 2. HealthSpring: EOC URL → SB URL (same filename, eoc- → sb-)
  if (/healthspring|cigna/i.test(carrier) && dlUrl && /eoc-h/i.test(dlFn)) {
    urls.push(dlUrl.replace(/eoc-h(\d{4})/i, 'sb-h$1'));
  }

  // 3. Humana: content.medicareadvantage.com with 2026 SB26 pattern
  if (/humana/i.test(carrier)) {
    const m = String(planId).match(/([A-Za-z])(\d{4})-(\d+)/);
    if (m) {
      const [, l, h, p] = m;
      const p3 = String(parseInt(p, 10)).padStart(3, '0');
      // Humana SB26 URL pattern: Humana-H####PPPPPPP000SB26pdf-2026-SF{DATE}.pdf
      // Try the DL url if it has SB26
      if (dlUrl && /SB26/i.test(dlFn)) urls.push(dlUrl);
      // Also try the known mirror pattern
      urls.push(`https://content.medicareadvantage.com/2026/Humana-${l.toUpperCase()}${h}${String(parseInt(p,10)).toString().padStart(6,'0')}000SB26pdf-2026-SF20251001.pdf`);
    }
  }

  // 4. UHC / content.medicareadvantage.com: try 2026 path variant if stale was 2025
  if (/unitedhealthcare|uhc/i.test(carrier) && dlUrl) {
    // Some stale URLs are 2025/... — try swapping to 2026/...
    if (dlUrl.includes('/2025/')) urls.push(dlUrl.replace('/2025/', '/2026/'));
    // Try without any SB-specific pattern fix; content mirror
    const m = String(planId).match(/([A-Za-z]\d{4})-(\d+)/);
    if (m) {
      const [, c, p] = m;
      const p3 = String(parseInt(p, 10)).padStart(3, '0');
      urls.push(`https://content.medicareadvantage.com/2026/${c.toUpperCase()}_${p3}_2026_SB.pdf`);
    }
  }

  // 5. Aetna / Devoted: try 2026 path via content mirror if stale
  if (/aetna|devoted/i.test(carrier) && dlUrl) {
    if (dlUrl.includes('/2025/')) urls.push(dlUrl.replace('/2025/', '/2026/'));
  }

  // 6. Wellcare: for EOC sources, try content mirror with SB filename pattern
  if (/wellcare/i.test(carrier) && dlUrl && /EOC/i.test(dlFn)) {
    // Try removing "-EOC" from filename
    const sbFn = dlFn.replace(/-EOC[^-]*/i, '-SB').replace(/-EOC/i, '-SB');
    const baseUrl = dlUrl.slice(0, dlUrl.lastIndexOf('/') + 1);
    if (sbFn !== dlFn) urls.push(baseUrl + sbFn);
    // Also try 2026 path
    if (dlUrl.includes('/2025/')) {
      const url2026 = dlUrl.replace('/2025/', '/2026/').replace(/-2025-/g, '-2026-').replace(/2025/g, '2026');
      urls.push(url2026);
    }
  }

  return [...new Set(urls)].filter(Boolean);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const csvLines = fs.readFileSync('sb-validation-results.csv', 'utf8').trim().split('\n');
  const hdrs = csvLines[0].split(',');
  function parseRow(l) {
    const parts = []; let cur = '', inQ = false;
    for (const c of l) { if (c === '"') inQ = !inQ; else if (c === ',' && !inQ) { parts.push(cur); cur = ''; } else cur += c; }
    parts.push(cur);
    return Object.fromEntries(hdrs.map((h, i) => [h, parts[i]]));
  }
  const badPlans = csvLines.slice(1).map(parseRow).filter(r => r.verdict !== 'GOOD');
  console.log('Plans to re-acquire:', badPlans.length);

  const dl = JSON.parse(fs.readFileSync('sb-download-list.json', 'utf8'));
  const dlByPlanId = {};
  dl.forEach(e => { if (e.planId) dlByPlanId[e.planId] = e; });

  const prog = fs.existsSync(PROG) ? JSON.parse(fs.readFileSync(PROG, 'utf8')) : {};
  let recovered = 0, failed = 0, skipped = 0;

  const queue = badPlans.filter(p => !prog[p.planId]);
  console.log('Remaining (not yet processed):', queue.length, '\n');

  async function processOne(p) {
    if (prog[p.planId]) { skipped++; return; }
    const { planId, organizationName: carrier } = p;
    const dlEntry = dlByPlanId[planId];
    const urls = candidates(planId, dlEntry, carrier);
    if (!urls.length) { prog[planId] = 'no_candidates'; failed++; console.log('  ' + planId + ': no candidate URLs'); return; }

    for (const url of urls.slice(0, 6)) {
      const buf = await fetchBuf(url);
      if (!buf) continue;
      const txt = pdftext2pg(buf);
      const verdict = classify(planId, buf, txt);
      if (verdict === 'GOOD') {
        const fn = `sb-2026-${planId.replace('-','_')}-reacquired.pdf`;
        console.log('  ✓', planId, carrier, '| GOOD from', url.slice(0, 80));
        if (APPLY) {
          const blob = new Blob([new Uint8Array(buf)], { type: 'application/pdf' });
          const result = await put(`2026/sb-pdfs/${fn}`, blob, { access: 'public', addRandomSuffix: false });
          await prisma.plan.updateMany({ where: { planId, planYear: PLAN_YEAR }, data: { sbPdfUrl: result.url } });
        }
        prog[planId] = 'RECOVERED'; recovered++;
        return;
      }
    }
    console.log('  ✗', planId, carrier, '| not recovered (all URLs failed validation)');
    prog[planId] = 'not_recovered'; failed++;
  }

  let i = 0;
  const q2 = queue.slice();
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (q2.length) {
      await processOne(q2.shift());
      if ((++i) % 20 === 0) { fs.writeFileSync(PROG, JSON.stringify(prog)); console.log('  progress checkpoint:', i); }
    }
  }));
  fs.writeFileSync(PROG, JSON.stringify(prog));

  const all = Object.values(prog);
  const byResult = {};
  all.forEach(v => { byResult[v] = (byResult[v] || 0) + 1; });
  console.log('\n=== Phase 2 result ===');
  console.log(JSON.stringify(byResult, null, 2));
  console.log('Recovered:', recovered, '| Not recovered:', failed, '| Skipped (prev):', skipped);
  if (!APPLY) console.log('Dry-run — no uploads/writes. Re-run with --apply to persist.');
  await prisma.$disconnect();
}
main().catch(async e => { console.error(e); try { await prisma.$disconnect(); } catch {} process.exit(1); });
