// scripts/audit-copays.js  (read-only copay audit vs SB PDFs)
//
// Compares filed DB copays (pcpCopay, specialistCopay, hospitalStayCopay day-1)
// against the plan's Summary of Benefits PDF. Report-only — writes a CSV, never
// touches the DB. HealthSpring + Devoted first.
//
// USAGE (from repo root):
//   node scripts/audit-copays.js --calibrate            # 6 plans/carrier, prints a table
//   node scripts/audit-copays.js                        # full run -> copay-audit.csv
//   node scripts/audit-copays.js --carriers Devoted     # one carrier
//   node scripts/audit-copays.js --limit 50             # cap rows (per carrier)
//
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");
const { makePrisma } = require("./prisma-client");
const prisma = makePrisma();

const ARGS = process.argv.slice(2);
const CALIBRATE = ARGS.includes("--calibrate");
const limIdx = ARGS.indexOf("--limit");
const LIMIT = limIdx >= 0 ? parseInt(ARGS[limIdx + 1], 10) : (CALIBRATE ? 6 : Infinity);
const carIdx = ARGS.indexOf("--carriers");
const CARRIER_ARG = carIdx >= 0 ? ARGS[carIdx + 1] : "HealthSpring,Devoted";

// organizationName values per requested carrier (exact CMS strings).
const CARRIER_ORGS = {
  HealthSpring: ["Cigna Healthcare", "HealthSpring"],
  Devoted: ["Devoted Health"],
};
const targetOrgs = CARRIER_ARG.split(",").flatMap((c) => CARRIER_ORGS[c.trim()] || []);

// ── label sets (carrier-agnostic; extend if calibration shows a miss) ──
const LABELS = {
  pcp: [/primary care (?:office )?visits?/i, /primary care provider/i, /primary care physician/i, /\bprimary care\b/i, /primary doctor/i, /\bpcp\b/i],
  specialist: [/specialist (?:office )?visits?/i, /\bspecialists?\b/i, /specialty care/i],
  hospital: [/inpatient hospital/i, /hospital\s*[-–]\s*inpatient/i, /acute (?:care )?hospital/i, /hospital coverage/i],
};
const STOP = /(out[- ]of[- ]network|your summary of benefits|^\s*benefits\s*$|monthly premium|deductible|maximum out|specialist|primary care|emergency|urgent|ambulance|skilled nursing|outpatient|diagnostic|x-?ray|lab services)/i;

function dollars(s) {
  if (!s) return null;
  const m = String(s).match(/\$\s*([\d,]+(?:\.\d+)?)/);
  return m ? parseFloat(m[1].replace(/,/g, "")) : null;
}
function zeroish(s) { return /\$\s*0\b/.test(s) || /\bno (?:copay|charge|cost)\b/i.test(s); }
function firstDayDollars(s) {
  if (!s) return null;
  const str = String(s);
  // Standard CMS format: "$NNN copay per day for days 1-..."
  const m1 = str.match(/\$\s*([\d,]+(?:\.\d+)?)\s*copay\s*per\s*day\s*for\s*days?\s*1\b/i);
  if (m1) return parseFloat(m1[1].replace(/,/g, ""));
  // DB format: "$NNN/day days 1-N"
  const m2 = str.match(/\$\s*([\d,]+(?:\.\d+)?)\s*\/day\s*days?\s*1\b/i);
  if (m2) return parseFloat(m2[1].replace(/,/g, ""));
  // Devoted PDF format: "Days 1 - N Coverage $NNN copay per day"
  const m3 = str.match(/days?\s*1\s*[-–]\s*\d+[^$]{0,20}\$\s*([\d,]+(?:\.\d+)?)\s*copay\s*per\s*day/i);
  if (m3) return parseFloat(m3[1].replace(/,/g, ""));
  return null;
}
function pctIn(s) { return /(\d{1,3}(?:\.\d+)?)\s*%/.test(s || ""); }

function extractText(pdfPath) {
  return execSync(`pdftotext -layout -nopgbrk "${pdfPath}" -`, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}
function distinctPlanTokens(text) {
  const set = new Set();
  for (const m of text.matchAll(/\bH\d{4}-\d{1,3}\b/g)) set.add(m[0]);
  return set;
}

// Pull the in-network text window that follows the first matching label.
function windowForLabel(text, labelRes) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (labelRes.some((re) => re.test(lines[i]))) {
      let win = lines[i];
      for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
        if (STOP.test(lines[j]) || /\bH\d{4}-\d/.test(lines[j])) break;
        win += " " + lines[j];
      }
      // keep only the in-network side if an out-of-network split exists on the line
      const onIdx = win.search(/out[- ]of[- ]network/i);
      return onIdx > 0 ? win.slice(0, onIdx) : win;
    }
  }
  return null;
}

function parsePdfCopays(text) {
  const out = { pcp: null, specialist: null, hospitalDay1: null, snip: {} };
  for (const key of ["pcp", "specialist"]) {
    const win = windowForLabel(text, LABELS[key]);
    if (win == null) continue;
    out.snip[key] = win.replace(/\s+/g, " ").trim().slice(0, 120);
    const d = dollars(win);
    if (d != null) out[key] = d;
    else if (zeroish(win)) out[key] = 0;
    else if (pctIn(win)) out[key] = "PCT"; // coinsurance filing
  }
  const hwin = windowForLabel(text, LABELS.hospital);
  if (hwin != null) {
    out.snip.hospital = hwin.replace(/\s+/g, " ").trim().slice(0, 140);
    out.hospitalDay1 = firstDayDollars(hwin) ?? dollars(hwin) ?? (zeroish(hwin) ? 0 : null);
  }
  return out;
}

function compare(field, dbCopay, dbCoins, pdfVal) {
  if (pdfVal === "PCT") {
    return (dbCopay == null && dbCoins != null) ? "COINS_OK" : (dbCopay == null ? "DB_NULL_PDF_PCT" : "MISMATCH_PCT_VS_COPAY");
  }
  if (pdfVal == null) return "PDF_UNPARSED";
  if (dbCopay == null) return dbCoins != null ? "DB_COINS_PDF_COPAY" : "DB_NULL_PDF_HAS";
  return Math.abs(dbCopay - pdfVal) < 0.5 ? "MATCH" : "MISMATCH";
}

async function main() {
  if (!targetOrgs.length) { console.error(`No orgs for --carriers "${CARRIER_ARG}"`); process.exit(1); }
  const plans = await prisma.plan.findMany({
    where: { sbPdfUrl: { not: null }, organizationName: { in: targetOrgs } },
    select: {
      planId: true, planYear: true, planName: true, organizationName: true, state: true, sbPdfUrl: true,
      pcpCopay: true, specialistCopay: true, hospitalStayCopay: true, pcpCoinsPct: true, specialistCoinsPct: true,
    },
    orderBy: { planId: "asc" },
  });
  // one row per distinct planId (copays are per-plan; many county rows repeat them)
  const seen = new Set(); const uniq = [];
  for (const p of plans) { if (seen.has(p.planId)) continue; seen.add(p.planId); uniq.push(p); }
  const work = uniq.slice(0, LIMIT === Infinity ? uniq.length : LIMIT * targetOrgs.length);
  console.log(`${uniq.length} distinct plans (${plans.length} rows); auditing ${work.length}. ${CALIBRATE ? "CALIBRATE" : "FULL"}.`);

  const textCache = new Map();
  const tmp = path.join(os.tmpdir(), "copay-audit");
  fs.mkdirSync(tmp, { recursive: true });
  const rows = []; const tally = {};
  const bump = (s) => (tally[s] = (tally[s] || 0) + 1);

  for (let n = 0; n < work.length; n++) {
    const p = work[n];
    let text = textCache.get(p.sbPdfUrl);
    if (text === undefined) {
      try {
        const res = await fetch(p.sbPdfUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const file = path.join(tmp, `${p.planId}.pdf`);
        fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
        text = extractText(file);
      } catch (e) { text = null; console.warn(`  fetch/parse fail ${p.planId}: ${e.message}`); }
      textCache.set(p.sbPdfUrl, text);
    }
    const multi = text ? distinctPlanTokens(text).size > 1 : false;
    let parsed = { pcp: null, specialist: null, hospitalDay1: null, snip: {} };
    if (text && !multi) parsed = parsePdfCopays(text);

    const dbHospDay1 = firstDayDollars(p.hospitalStayCopay);
    const fields = [
      ["pcp", p.pcpCopay, p.pcpCoinsPct, parsed.pcp],
      ["specialist", p.specialistCopay, p.specialistCoinsPct, parsed.specialist],
      ["hospitalDay1", dbHospDay1, null, parsed.hospitalDay1],
    ];
    for (const [field, dbCopay, dbCoins, pdfVal] of fields) {
      const status = !text ? "FETCH_FAIL" : multi ? "MULTIPLAN_SKIP" : compare(field, dbCopay, dbCoins, pdfVal);
      bump(status);
      rows.push({
        planId: p.planId, org: p.organizationName, state: p.state, planName: p.planName,
        field, dbValue: dbCopay ?? "", dbCoinsPct: dbCoins ?? "", pdfValue: pdfVal ?? "",
        status, evidence: (parsed.snip[field === "hospitalDay1" ? "hospital" : field] || "").replace(/"/g, "'"),
        sbPdfUrl: p.sbPdfUrl,
      });
    }
    if ((n + 1) % 25 === 0 || n === work.length - 1) console.log(`  …${n + 1}/${work.length}`);
  }

  console.log("\nStatus tally:"); for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);

  if (CALIBRATE) {
    console.log("\n— calibration sample (field | db | pdf | status | evidence) —");
    for (const r of rows) console.log(`${r.planId} ${r.field} | db=${r.dbValue} coins=${r.dbCoinsPct} | pdf=${r.pdfValue} | ${r.status} | ${r.evidence}`);
    console.log("\nEyeball: do db vs pdf agree where status=MATCH, and are MISMATCH rows real? If a whole carrier shows PDF_UNPARSED for a field, its label is missing from LABELS — add it and re-run --calibrate.");
  } else {
    const hdr = ["planId","org","state","planName","field","dbValue","dbCoinsPct","pdfValue","status","evidence","sbPdfUrl"];
    const csv = [hdr.join(",")].concat(rows.map((r) => hdr.map((h) => `"${String(r[h] ?? "")}"`).join(","))).join("\n");
    const outPath = path.join(process.cwd(), "copay-audit.csv");
    fs.writeFileSync(outPath, csv);
    const mism = rows.filter((r) => r.status === "MISMATCH" || r.status === "MISMATCH_PCT_VS_COPAY").length;
    console.log(`\nWrote ${outPath} (${rows.length} field-rows, ${mism} mismatches).`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
