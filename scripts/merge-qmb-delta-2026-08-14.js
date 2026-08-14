// scripts/merge-qmb-delta-2026-08-14.js — merge the 2026-08-14 null-bucket classification
// delta (154 planIds, Cowork session) into the canonical qmb-protection.json artifact.
// Repo entries with a non-null decision win; delta only adds new planIds or fills nulls.
const fs = require("fs");
const cur = JSON.parse(fs.readFileSync("scripts/data/qmb-protection.json", "utf8"));
const delta = JSON.parse(fs.readFileSync("C:/Users/dbuir/OneDrive/Documents/Claude/Projects/MAPD Plan Finder/qmb-protection-delta-2026-08-14.json", "utf8"));
let added = 0, filled = 0, conflicts = [];
for (const [pid, v] of Object.entries(delta)) {
  const prev = cur[pid];
  if (!prev) { cur[pid] = v; added++; }
  else if (prev.protected === null || prev.protected === undefined) { cur[pid] = v; filled++; }
  else if (prev.protected !== v.protected) { conflicts.push(`${pid}: repo=${prev.protected} delta=${v.protected}`); }
  // equal non-null: keep repo entry
}
fs.writeFileSync("scripts/data/qmb-protection.json", JSON.stringify(cur, null, 2));
console.log(`added=${added} filled=${filled} conflicts=${conflicts.length}`);
conflicts.forEach(c => console.log("  CONFLICT (repo kept, review!): " + c));
