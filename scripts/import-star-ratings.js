// scripts/import-star-ratings.js
// Populates Plan.starRating from the CMS 2026 Star Ratings CSV.
//
// Usage (from repo root):
//   node scripts/import-star-ratings.js
//
// Source CSV:  scripts/data/star-ratings-2026-summary.csv
// Downloaded from:
//   https://www.cms.gov/files/zip/2026-star-ratings-data-tables.zip
//   file "2026 Star Ratings Data Table - Summary Ratings (Oct 8 2025).csv"
//
// Plan.planId format is "H####-###" (contract-PBP). Contract is the prefix
// before the dash. We match on that to look up the 2026 Overall rating.
// Non-numeric values ("Not Applicable", "Not enough data available") -> null.
//
// Uses raw SQL throughout to avoid the Supabase transaction-pooler
// "prepared statement s0 already exists" collision (42P05) that can hit
// fresh Prisma processes when the pooler reuses tainted backend connections.

const fs = require("fs");
const path = require("path");
const { Prisma } = require("@prisma/client");
const { makePrisma } = require("./prisma-client");

const prisma = makePrisma();

const CSV_PATH = path.join(__dirname, "data", "star-ratings-2026-summary.csv");
const UPDATE_CHUNK = 2000; // max ids per UPDATE ... WHERE id IN (...)

function log(msg, color) {
  const c = { green: "\x1b[32m", cyan: "\x1b[36m", yellow: "\x1b[33m", red: "\x1b[31m", reset: "\x1b[0m" };
  console.log(`${c[color] || ""}${msg}${c.reset}`);
}

// Minimal CSV parser — handles quoted fields with commas.
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function buildRatingMap() {
  const raw = fs.readFileSync(CSV_PATH, "utf8");
  const stripped = raw.replace(/^\uFEFF/, "");
  const lines = stripped.split(/\r?\n/).filter((l) => l.trim().length > 0);

  // Line 0 is the banner, line 1 is the header.
  const header = parseCsvLine(lines[1]).map((c) => c.trim());
  const contractIdx = header.indexOf("Contract Number");
  const overallIdx = header.indexOf("2026 Overall");
  if (contractIdx < 0 || overallIdx < 0) {
    throw new Error(`CSV header missing expected columns. Saw: ${JSON.stringify(header)}`);
  }

  const map = new Map();
  for (let i = 2; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]).map((c) => c.trim());
    const contract = cells[contractIdx];
    const overallStr = cells[overallIdx];
    if (!contract) continue;
    const n = parseFloat(overallStr);
    map.set(contract, Number.isFinite(n) ? n : null);
  }
  return map;
}

// Chunk an array into slices of `size`
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  log("[1/4] Loading Star Ratings CSV", "cyan");
  if (!fs.existsSync(CSV_PATH)) {
    log(`ERROR: CSV not found at ${CSV_PATH}`, "red");
    process.exit(1);
  }
  const ratings = buildRatingMap();
  const withRating = [...ratings.values()].filter((v) => v !== null).length;
  log(`    Loaded ${ratings.size} contracts (${withRating} with numeric rating).`, "green");

  log("[2/4] Reading all plans from DB (raw SQL)", "cyan");
  const plans = await prisma.$queryRaw`
    SELECT id, "planId", "starRating"
    FROM "Plan"
  `;
  log(`    Found ${plans.length.toLocaleString()} plans.`, "green");

  log("[3/4] Computing updates (grouped by target rating)", "cyan");
  // Bucket plan ids by their target rating (including null as "unrated")
  const buckets = new Map(); // key: rating value (Number | "null") -> [ids]
  let matched = 0;
  let noMatch = 0;
  let noContract = 0;
  let unchanged = 0;

  for (const plan of plans) {
    if (!plan.planId) { noContract++; continue; }
    const contract = plan.planId.split("-")[0].trim();
    const has = ratings.has(contract);
    const target = has ? ratings.get(contract) : null;
    if (has) matched++; else noMatch++;

    const current = plan.starRating == null ? null : Number(plan.starRating);
    if (current === target) { unchanged++; continue; }

    const key = target == null ? "null" : target;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(plan.id);
  }

  const totalUpdates = [...buckets.values()].reduce((a, v) => a + v.length, 0);
  log(`    matched=${matched.toLocaleString()}  noMatch=${noMatch.toLocaleString()}  noContract=${noContract}  unchanged=${unchanged.toLocaleString()}  toUpdate=${totalUpdates.toLocaleString()}`, "green");

  if (totalUpdates === 0) {
    log(`\nNothing to update. Done.`, "green");
    return;
  }

  log("[4/4] Applying updates (raw SQL, one UPDATE per rating bucket, chunked)", "cyan");
  let done = 0;
  for (const [ratingKey, ids] of buckets) {
    const label = ratingKey === "null" ? "NULL" : String(ratingKey);
    log(`  rating=${label}: ${ids.length.toLocaleString()} plans`, "cyan");
    for (const ids_chunk of chunk(ids, UPDATE_CHUNK)) {
      const idList = Prisma.join(ids_chunk.map((id) => Prisma.sql`${id}`));
      if (ratingKey === "null") {
        await prisma.$executeRaw`UPDATE "Plan" SET "starRating" = NULL WHERE id IN (${idList})`;
      } else {
        const val = Number(ratingKey);
        await prisma.$executeRaw`UPDATE "Plan" SET "starRating" = ${val} WHERE id IN (${idList})`;
      }
      done += ids_chunk.length;
      log(`    ${done.toLocaleString()}/${totalUpdates.toLocaleString()}`, "yellow");
    }
  }
  log("    Done.", "green");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
