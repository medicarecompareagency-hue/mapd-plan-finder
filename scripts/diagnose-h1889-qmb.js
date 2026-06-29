const { makePrisma } = require("./prisma-client");
const prisma = makePrisma();
const PID = "H1889-9";
const distinct = (rows) => [...new Map(rows.map((r) => [r.planId, r])).values()];

async function main() {
  // ---- STEP 0: does the planId exist, and what are its key fields? ----
  const anyRow = await prisma.plan.findFirst({ where: { planId: PID } });
  if (!anyRow) {
    console.log(`STEP 0: planId ${PID} NOT FOUND. Check unpadded format / re-import state. STOP.`);
    return;
  }
  const FIELDS = ["planId","organizationName","planName","planType","planCategory","state","planYear",
    "dsnpTargetGroup","isZeroDollarDsnp","snpSubtype","qmbCostShareProtected","costShareProtectedLevels",
    "lowIncomeSubsidyLevel","medicaidLevel","sbPdfUrl"];
  console.log("STEP 0 — H1889-9 (sample row):");
  for (const f of FIELDS) if (f in anyRow) console.log(`  ${f}: ${JSON.stringify(anyRow[f])}`);

  const rows = await prisma.plan.findMany({
    where: { planId: PID },
    select: { state: true, county: true, planYear: true, planCategory: true, dsnpTargetGroup: true, qmbCostShareProtected: true },
  });
  console.log(`\n  total rows for ${PID}: ${rows.length}`);
  console.log(`  distinct dsnpTargetGroup:       ${JSON.stringify([...new Set(rows.map(r=>r.dsnpTargetGroup))])}`);
  console.log(`  distinct qmbCostShareProtected: ${JSON.stringify([...new Set(rows.map(r=>String(r.qmbCostShareProtected)))])}`);
  console.log(`  distinct planCategory:          ${JSON.stringify([...new Set(rows.map(r=>r.planCategory))])}`);
  const calhoun = rows.filter(r => r.state==="AL" && r.planYear===2026 && /calhoun/i.test(r.county||""));
  console.log(`  AL/Calhoun/2026 rows: ${calhoun.length}` +
    (calhoun.length ? `  (county strings: ${[...new Set(calhoun.map(r=>r.county))].join(" | ")})` : "   <<< NOT in Calhoun service area"));

  // ---- STEP 1: replay the exact repro, adding one gate at a time ----
  console.log("\nSTEP 1 — gate-by-gate (AL / Calhoun / 2026 / DSNP / QMB / LIS=100):");
  const probe = async (where, label) => {
    const r = await prisma.plan.findMany({ where, select: { planId: true } });
    const ids = new Set(r.map(x => x.planId));
    console.log(`  [${ids.has(PID) ? "PRESENT" : "DROPPED "}]  ${label}   (rows ${r.length}, planIds ${ids.size})`);
    return ids.has(PID);
  };
  const base = { state: "AL", county: { in: ["Calhoun County","Calhoun"] }, planYear: 2026, planCategory: "DSNP" };
  await probe(base, "G1+G2  state+county+year+DSNP");
  const g3 = { ...base, dsnpTargetGroup: "FULL_DUAL" };
  const sG3 = await probe(g3, "G3    + dsnpTargetGroup=FULL_DUAL  (the QMB bucket)");
  const g4 = { ...g3, OR: [{ qmbCostShareProtected: true }, { qmbCostShareProtected: null }] }; // lenient gate
  const sG4 = await probe(g4, "G4    + lenient QMB gate (hide confirmed false)  [shipped 2026-06-25]");
  const g5 = { ...base, dsnpTargetGroup: "FULL_DUAL", OR: g4.OR, lowIncomeSubsidyLevel: "100" };
  const sG5 = await probe(g5, "G5    + lowIncomeSubsidyLevel='100'");
  if (!sG5) {
    // LIS value format check — DSNP LIS is usually display, not a hard filter; surface a mismatch
    for (const v of ["FULL","100%","",null]) {
      const w = { ...base, dsnpTargetGroup:"FULL_DUAL", OR:g4.OR };
      if (v !== null) w.lowIncomeSubsidyLevel = v;
      const r = await prisma.plan.findMany({ where: w, select: { planId: true } });
      console.log(`        LIS probe value=${JSON.stringify(v)} -> planIds ${new Set(r.map(x=>x.planId)).size}`);
    }
  }

  // ---- dedup competition: which UHC plans fight for the single UHC slot? ----
  const uhc = distinct(await prisma.plan.findMany({
    where: { ...g4, organizationName: { contains: "UnitedHealth" } },
    select: { planId: true, planName: true, monthlyPremium: true, medicalDeductible: true, specialistCopay: true,
      foodCardAllowance: true, otcAllowance: true, dentalAnnualMax: true },
  }));
  console.log(`\n  UHC FULL_DUAL plans competing for the ONE UHC dedup slot in Calhoun (post-G4): ${uhc.length}`);
  for (const p of uhc) console.log(`    ${p.planId}  ${p.planName}  prem=${p.monthlyPremium} medDed=${p.medicalDeductible} spec=${p.specialistCopay} food=${p.foodCardAllowance} otc=${p.otcAllowance}`);
  console.log("  (dedupeByCarrier keeps only the highest-ranked of these per the FULL_DUAL 5-key. If H1889-9 is here but not #1, that's why — by design.)");

  // ---- VERDICT ----
  console.log("\n=========== VERDICT ===========");
  if (!calhoun.length) {
    console.log("G1 SERVICE AREA: H1889-9 has no AL/Calhoun/2026 row — not offered there in the DB. Check service-area import.");
  } else if (!sG3) {
    console.log("G3 BUCKET: H1889-9 is NOT dsnpTargetGroup=FULL_DUAL, so a QMB search never sees it (it's a CO/coordination-only");
    console.log("           dual, likely PARTIAL_DUAL or NULL). PLAN-WIDE class — run STEP 2, then the G3 fix.");
  } else if (!sG4) {
    console.log("G4 CLASSIFIER: H1889-9 is qmbCostShareProtected=false (SB Rule 2 tagged it QMB+-only). The new gate hides it.");
    console.log("           Dale says it protects QMB => false-positive. PLAN-WIDE class — run STEP 2, then the G4 override fix.");
  } else if (!sG5) {
    console.log("G5 LIS: H1889-9 survives until the LIS filter. lowIncomeSubsidyLevel is being applied as a HARD filter and the");
    console.log("           plan's stored value doesn't match '100'. For DSNP, LIS should not hard-exclude plans — likely a bug.");
  } else {
    console.log("G6 DEDUP: H1889-9 passes every hard filter. dedupeByCarrier is dropping it — a higher-ranked UHC plan takes the");
    console.log("           single UHC slot. By design (top-5 distinct carriers), not a data bug. See UHC list above for who wins.");
  }
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
