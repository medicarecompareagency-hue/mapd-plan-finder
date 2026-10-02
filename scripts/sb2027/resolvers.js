// scripts/sb2027/resolvers.js — per-carrier 2027 SB candidate-URL resolvers.
// Each resolver(entry, {fetchBuf, UA}) returns an ordered list of candidate URLs. Every candidate still
// has to pass the strict validator in validate.js; a resolver never decides that a document is correct.
const s3 = (seg) => String(seg).padStart(3, '0');

// HealthSpring: deterministic. Unposted plans redirect to coming-soon.pdf (a real PDF) — validator rejects.
async function healthspring(e) {
  const base = 'https://www.healthspring.com/static/docs/medicare/plans/2027/sb-' + e.contract.toLowerCase() + '-' + e.plan3 + '-';
  const out = [base + s3(e.seg) + '.pdf'];
  if (e.seg === '0') out.push(base + '001.pdf');
  return out;
}

// Devoted: per-plan documents page links the SB on assets.devoted.com. Read the link off the page.
async function devoted(e, { fetchBuf }) {
  const slug = e.contract + '-' + e.plan3 + '-' + s3(e.seg) + '-2027';
  const out = [];
  for (const sl of [slug, ...(e.seg === '0' ? [] : [e.contract + '-' + e.plan3 + '-000-2027'])]) {
    const r = await fetchBuf('https://www.devoted.com/plan-documents/benefit-and-coverage-details/' + sl + '/');
    if (r.err) continue;
    const html = r.buf.toString('utf8');
    for (const m of html.matchAll(/href="(https:\/\/assets\.devoted\.com\/[^"]*-SB-[^"]*\.pdf)"/g)) {
      const u = m[1].replace(/&amp;/g, '&');
      if (/-(ENG|EN)\b|ENG\.pdf/i.test(u) && !out.includes(u)) out.push(u);
    }
  }
  return out;
}

// Wellcare: server-rendered plan page links the SB on the DAM (docnum is not guessable — read it off the page).
const STATE_NAMES = { AL: 'alabama', AR: 'arkansas', FL: 'florida', GA: 'georgia', IL: 'illinois', IN: 'indiana', KS: 'kansas', KY: 'kentucky', LA: 'louisiana', MO: 'missouri', MS: 'mississippi', OH: 'ohio', OK: 'oklahoma', SC: 'south-carolina', TN: 'tennessee', TX: 'texas', VA: 'virginia', WV: 'west-virginia' };
const slugify = (name) => name.toLowerCase().replace(/[()]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const WELLCARE_AFFILIATE = { TX: 'wellcare.superiorhealthplan.com', OH: 'wellcare.buckeyehealthplan.com', SC: 'wellcare.absolutetotalcare.com', IN: 'wellcare.mhsindiana.com', KS: 'wellcare.sunflowerhealthplan.com', MO: 'wellcare.homestatehealth.com', AR: 'wellcare.arhealthwellness.com', IL: 'wellcare.ilmeridian.com' };
const affCache = {};
async function wellcare(e, { fetchBuf }) {
  const out = [];
  const slug = slugify(e.planName) + '-' + e.plan3;
  for (const st of e.states) {
    const sn = STATE_NAMES[st]; if (!sn) continue;
    for (const variant of [sn, sn.replace(/-/g, ' ')]) {
      const r = await fetchBuf('https://www.wellcare.com/en/' + encodeURI(variant) + '/members/medicare-plans-2027/' + slug);
      if (r.err || /NotFoundPage/i.test(r.finalUrl || '')) continue;
      const html = r.buf.toString('utf8');
      for (const m of html.matchAll(/["'(]((?:https?:\/\/[a-z0-9.\-]+)?\/[^"'()\s]*\/sb\/[^"'()\s]*?(?:\.ashx|\.pdf))/gi)) {
        let u = m[1]; if (u.startsWith('/')) u = 'https://www.wellcare.com' + u;
        if (/2027/.test(u) && /eng|_en/i.test(u) && !out.includes(u)) out.push(u);
      }
      if (out.length) break;
    }
  }
  // State-affiliate "plan benefit materials" pages (D-SNPs and affiliate-branded states live here, not on wellcare.com).
  for (const st of e.states) {
    const host = WELLCARE_AFFILIATE[st]; if (!host) continue;
    if (!affCache[host]) { const r = await fetchBuf('https://' + host + '/plan-benefit-materials.html'); affCache[host] = r.err ? '' : r.buf.toString('utf8'); }
    const re = new RegExp('href="([^"]*/2027/sb/[^"]*' + e.contract + '_' + e.plan3 + '_[^"]*ENG[^"]*\\.pdf)"', 'gi');
    for (const m of affCache[host].matchAll(re)) { let u = m[1]; if (u.startsWith('/')) u = 'https://' + host + u; if (!out.includes(u)) out.push(u); }
  }
  // prefer links that carry this plan number
  const tag = (e.contract + '_' + e.plan3).toLowerCase();
  out.sort((a, b) => (b.toLowerCase().includes(tag) ? 1 : 0) - (a.toLowerCase().includes(tag) ? 1 : 0));
  return out;
}

// Aetna: the plan page (aetna.com/medicare/plan.H####.###.html) loads its documents from a JSON service.
// Ask the same service and read the English SB location — the filename carries an unguessable network code.
async function aetna(e, { UA }) {
  const body = { webPageRequest: [{ identifier: [{ name: 'idSource', value: '70057' }, { name: 'webPageId', value: 'W00001' }, { name: 'contractId', value: e.contract }, { name: 'pbpId', value: e.plan3 }, { name: 'activeYear', value: '2027' }] }] };
  const r = await fetch('https://www.aetna.com/cms-services/acmiwebattributes', { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/json', 'Referer': 'https://www.aetna.com/medicare/plan.' + e.contract + '.' + e.plan3 + '.html' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('aetna_api_' + r.status);
  const j = await r.json();
  const out = [];
  for (const a of (j.communicationWebpageDetails && j.communicationWebpageDetails.webPageAttributes) || []) {
    if (String(a.contractYear) !== '2027') continue;
    for (const d of a.planDocuments || []) {
      if (d.documentType === 'SB' && d.languageCode === 'eng' && d.contentLocation) { const u = d.contentLocation.startsWith('http') ? d.contentLocation : 'https://www.aetna.com' + d.contentLocation; if (!out.includes(u)) out.push(u); }
    }
  }
  return out;
}

// Humana: deterministic Scene7 asset name — H<contract><plan3><seg3>SB27pdf (the same stem the
// content.medicareadvantage.com mirror uses; the mirror lags, the Humana asset host does not).
async function humana(e) {
  const stem = e.contract + e.plan3;
  const out = ['https://assets.humana.com/is/content/humana/' + stem + s3(e.seg) + 'SB27pdf'];
  return out;
}

// UnitedHealthcare: the plan-details page on uhc.com fills its document links from an open JSON service
// (pdfdoclog). docListMap["3"].en_us is the English Summary of Benefits; "link" is the alphadog document id.
// Brand and state must match the plan; the county segment is not checked. Segment is part of the path.
const UHC_BRANDS = ['AARP', 'UnitedHealthcare', 'UHC Community Plan', 'Preferred Care', 'PreferredCareNetwork', 'Medica'];
async function uhc(e, { UA }) {
  const name = e.planName || '';
  const first = /^AARP/i.test(name) ? 'AARP' : /Preferred/i.test(name) ? 'Preferred Care' : /MedicareMax/i.test(name) ? 'PreferredCareNetwork' : /Dual/i.test(name) ? 'UHC Community Plan' : 'UnitedHealthcare';
  const brands = [first, ...UHC_BRANDS.filter(b => b !== first)];
  const out = [];
  for (const st of e.states) {
    for (const b of brands) {
      const u = 'https://www.uhc.com/pdfdoclog/asyncpdf/uhc/planpdf/' + e.contract + '/' + e.plan3 + '/' + s3(e.seg) + '/GOVT/' + encodeURIComponent(b) + '/2027/' + st + '/County/v2';
      let j;
      try { const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: AbortSignal.timeout(30000) }); if (!r.ok) continue; j = await r.json(); } catch { continue; }
      const sb = j && j.data && j.data.docListMap && j.data.docListMap['3'] && j.data.docListMap['3'].en_us;
      if (sb && sb.link && String(sb.year) === '2027') {
        const id = sb.link.split('/').pop();
        for (const pre of ['https://www.uhc.com/medicare/alphadog/', 'https://www.uhc.com/communityplan/alphadog/']) if (!out.includes(pre + id)) out.push(pre + id);
        return out;
      }
    }
  }
  return out;
}

module.exports = { 'HealthSpring': healthspring, 'Devoted Health': devoted, 'Wellcare': wellcare, 'Aetna Medicare': aetna, 'Humana': humana, 'UnitedHealthcare': uhc };
