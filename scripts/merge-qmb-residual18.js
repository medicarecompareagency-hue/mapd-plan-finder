// scripts/merge-qmb-residual18.js — final 18 null-bucket classifications, SB/EOC-verified 2026-08-14
const fs = require("fs");
const DELTA18 = {
  "H0251-2":  { protected: true,  levels: ["QMB"],                          signal: "web:uhc-qmb-only-enroll" },
  "H0908-1":  { protected: true,  levels: ["QMB"],                          signal: "web:wellcare-msp-list" },
  "H1664-5":  { protected: true,  levels: ["FBDE","QMB","QMB+","SLMB+"],    signal: "web:wellcare-msp-list" },
  "H2445-2":  { protected: true,  levels: ["QMB"],                          signal: "web:uhc-elig-list" },
  "H5008-10": { protected: true,  levels: ["FBDE","QMB","QMB+","SLMB+"],    signal: "web:uhc-qmb-zero-list" },
  "H0251-4":  { protected: false, levels: ["FBDE","QMB+","SLMB+"],          signal: "web:uhc-elig-list-ltc" },
  "H0251-8":  { protected: false, levels: ["FBDE","QMB+","SLMB+"],          signal: "web:uhc-elig-list" },
  "H0421-1":  { protected: false, levels: ["FBDE","QMB+","SLMB+"],          signal: "web:uhc-full-medicaid-req" },
  "H0908-7":  { protected: false, levels: ["FBDE","QMB+","SLMB+"],          signal: "web:wellcare-msp-list" },
  "H0908-8":  { protected: false, levels: ["FBDE","QMB+","SLMB+"],          signal: "web:wellcare-msp-list" },
  "H2385-1":  { protected: false, levels: ["FBDE","QMB+","SLMB+"],          signal: "web:uhc-elig-list" },
  "H2385-3":  { protected: false, levels: ["FBDE","QMB+","SLMB+"],          signal: "web:uhc-elig-list" },
  "H2385-4":  { protected: false, levels: ["FBDE","QMB+","SLMB+"],          signal: "web:uhc-elig-list" },
  "H2445-1":  { protected: false, levels: ["FBDE","QMB+","SLMB+"],          signal: "web:uhc-full-medicaid-req" },
  "H2445-3":  { protected: false, levels: ["FBDE","QMB+","SLMB+"],          signal: "web:uhc-elig-list" },
  "H4158-1":  { protected: false, levels: ["FBDE","QMB+","SLMB+"],          signal: "web:eoc-full-medicaid-req" },
  "H4329-1":  { protected: false, levels: ["FBDE","QMB+","SLMB+"],          signal: "web:humana-may-enroll" },
  "H4939-1":  { protected: false, levels: ["FBDE","QMB+","SLMB+"],          signal: "web:humana-may-enroll" },
};
const cur = JSON.parse(fs.readFileSync("scripts/data/qmb-protection.json", "utf8"));
let added = 0, filled = 0, conflicts = [];
for (const [pid, v] of Object.entries(DELTA18)) {
  const prev = cur[pid];
  if (!prev) { cur[pid] = v; added++; }
  else if (prev.protected === null || prev.protected === undefined) { cur[pid] = v; filled++; }
  else if (prev.protected !== v.protected) conflicts.push(`${pid}: repo=${prev.protected} delta=${v.protected}`);
}
fs.writeFileSync("scripts/data/qmb-protection.json", JSON.stringify(cur, null, 2));
console.log(`added=${added} filled=${filled} conflicts=${conflicts.length}`);
conflicts.forEach(c => console.log("  CONFLICT (repo kept, review!): " + c));
