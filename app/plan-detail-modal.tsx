"use client";

import { useEffect, useRef } from "react";

interface Plan {
  rank: number;
  id: number;
  planId: string;
  planName: string;
  organizationName: string;
  planType: string;
  planCategory?: string | null;
  snpSubtype?: string | null;
  chronicConditions?: string[];
  hasPartD?: boolean | null;
  isZeroDollarDsnp?: boolean | null;
  cmsContractType?: string | null;
  state: string;
  county: string;
  zipCode: string | null;
  monthlyPremium: number;
  partBGivebackAmount: number | null;
  lowIncomeSubsidyLevel: string | null;
  medicaidLevel: string | null;
  medicalDeductible: number | null;
  maxOutOfPocket: number | null;
  pcpCopay: number | null;
  specialistCopay: number | null;
  emergencyRoomCopay: number | null;
  ambulanceCopay: number | null;
  outpatientHospitalCopay: number | null;
  hospitalStayCopay: string | null;
  skilledNursingCopay: string | null;
  mriCopay: number | null;
  catScanCopay: number | null;
  drugDeductible: number | null;
  drugTier1Copay: number | null;
  drugTier2Copay: number | null;
  drugTier3Copay: number | null;
  drugTier4Copay: number | null;
  drugTier5Copay: number | null;
  drugTier6Copay: number | null;
  otcAllowance: number | null;
  foodCardAllowance: number | null;
  dentalBenefits: string | null;
  hearingBenefits: string | null;
  visionBenefits: string | null;
  transportationBenefit: string | null;
}

function $(v: number | null | undefined): string {
  if (v == null) return "—";
  return `$${v.toFixed(v % 1 === 0 ? 0 : 2)}`;
}

// Keep in sync with prisma/schema.prisma enums and plan-search.tsx label tables.
const PLAN_CATEGORY_LABELS: Record<string, string> = {
  MA_ONLY: "MA-only (no drug coverage)",
  MAPD:    "MAPD (Medicare Advantage + Part D)",
  PDP:     "PDP (Prescription Drug Plan)",
  DSNP:    "DSNP (Dual-Eligible SNP)",
  CSNP:    "CSNP (Chronic Condition SNP)",
  ISNP:    "ISNP (Institutional SNP)",
  MSA:     "MSA (Medical Savings Account)",
  PACE:    "PACE",
  COST:    "Cost plan (1876 / HCPP)",
  MMP:     "MMP (Medicare-Medicaid Plan)",
  OTHER:   "Other",
};

const SNP_SUBTYPE_LABELS: Record<string, string> = {
  ISNP_FACILITY:      "FI-SNP (facility-based)",
  ISNP_EQUIVALENT:    "IE-SNP (institutional-equivalent)",
  ISNP_HYBRID:        "HI-SNP (hybrid)",
  DSNP_FBDE:          "FBDE (Full-Benefit Dual Eligible)",
  DSNP_QMB_PLUS:      "QMB+ (QMB with full Medicaid)",
  DSNP_QMB:           "QMB (Qualified Medicare Beneficiary)",
  DSNP_SLMB_PLUS:     "SLMB+ (SLMB with full Medicaid)",
  DSNP_SLMB:          "SLMB (Specified Low-Income MB)",
  DSNP_QI:            "QI (Qualifying Individual)",
  DSNP_MEDICAID_ONLY: "Medicaid-only (no MSP)",
};

const CHRONIC_CONDITION_LABELS: Record<string, string> = {
  ALCOHOL_SUD:              "Chronic alcohol / SUD",
  AUTOIMMUNE:               "Autoimmune disorders",
  CANCER:                   "Cancer",
  CARDIOVASCULAR:           "Cardiovascular disorders",
  CHRONIC_HEART_FAILURE:    "Chronic heart failure",
  DEMENTIA:                 "Dementia",
  DIABETES:                 "Diabetes mellitus",
  GASTROINTESTINAL:         "Chronic gastrointestinal disease",
  CHRONIC_KIDNEY_DISEASE:   "Chronic kidney disease (CKD)",
  HEMATOLOGIC:              "Severe hematologic disorders",
  HIV_AIDS:                 "HIV/AIDS",
  LUNG_DISORDERS:           "Chronic lung disorders",
  MENTAL_HEALTH:            "Chronic/disabling mental health",
  NEUROLOGIC:               "Neurologic disorders",
  STROKE:                   "Stroke",
  CHF_AND_CVD:              "Heart failure + CVD",
  DIABETES_AND_CVD:         "Diabetes + CVD",
  CHF_AND_DIABETES:         "Heart failure + Diabetes",
  DIABETES_CHF_CVD:         "Diabetes + CHF + CVD",
  STROKE_AND_CVD:           "Stroke + CVD",
  METABOLIC_SYNDROME:       "Overweight / metabolic syndrome",
  POST_TRANSPLANT:          "Post-organ transplantation care",
  IMMUNODEFICIENCY:         "Immunodeficiency disorders",
  COGNITIVE_IMPAIRMENT:     "Cognitive impairment conditions",
  FUNCTIONAL_CHALLENGES:    "Functional challenges",
  SENSORY_IMPAIRMENT:       "Vision/hearing/taste/touch/smell",
  THERAPY_MAINTENANCE:      "Therapy for maintenance of function",
  ANXIETY_WITH_COPD:        "Anxiety with COPD",
  CKD_AND_TRANSPLANT:       "CKD + post-renal transplant",
  SUD_AND_MH:               "SUD + chronic mental health",
  OTHER_1:                  "Other condition 1",
  OTHER_2:                  "Other condition 2",
  OTHER_3:                  "Other condition 3",
};

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-1.5 border-b border-gray-100">
      <span className="text-gray-600 text-sm">{label}</span>
      <span className="text-gray-900 text-sm font-medium text-right">{value}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6">
      <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2 border-b-2 border-gray-200 pb-1">
        {title}
      </h3>
      {children}
    </div>
  );
}

export default function PlanDetailModal({
  plan,
  onClose,
}: {
  plan: Plan;
  onClose: () => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-12 overflow-y-auto"
      onClick={(e) => { if (e.target === overlayRef.current) onClose(); }}
    >
      <div className="bg-white rounded-lg shadow-2xl w-full max-w-3xl" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold text-gray-900">{plan.planName}</h2>
            <p className="text-sm text-gray-500">{plan.organizationName} &middot; {plan.planId} &middot; {plan.planType}</p>
            <p className="text-sm text-gray-500">{plan.state}, {plan.county}</p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 p-1"
            aria-label="Close"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-4 grid grid-cols-1 md:grid-cols-2 gap-x-8">
          <div>
            {plan.planCategory && (
              <Section title="Plan Category">
                <Row
                  label="Category"
                  value={PLAN_CATEGORY_LABELS[plan.planCategory] ?? plan.planCategory}
                />
                {plan.cmsContractType && (
                  <Row label="Contract Form" value={plan.cmsContractType} />
                )}
                {plan.hasPartD != null && (
                  <Row label="Part D Coverage" value={plan.hasPartD ? "Yes" : "No"} />
                )}
                {plan.planCategory === "DSNP" && plan.isZeroDollarDsnp != null && (
                  <Row
                    label="$0 Premium DSNP"
                    value={plan.isZeroDollarDsnp ? "Yes" : "No"}
                  />
                )}
                {plan.snpSubtype && (
                  <Row
                    label="SNP Subtype"
                    value={SNP_SUBTYPE_LABELS[plan.snpSubtype] ?? plan.snpSubtype}
                  />
                )}
                {plan.planCategory === "CSNP" && plan.chronicConditions && plan.chronicConditions.length > 0 && (
                  <div className="py-2 border-b border-gray-100">
                    <div className="text-gray-600 text-sm mb-1">Chronic Conditions Covered</div>
                    <div className="flex flex-wrap gap-1">
                      {plan.chronicConditions.map((cond) => (
                        <span
                          key={cond}
                          className="inline-block px-2 py-0.5 text-xs font-medium bg-amber-50 text-amber-800 rounded border border-amber-200"
                        >
                          {CHRONIC_CONDITION_LABELS[cond] ?? cond}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </Section>
            )}

            <Section title="Premiums & Subsidies">
              <Row label="Monthly Premium" value={$(plan.monthlyPremium)} />
              <Row label="Part B Giveback" value={$(plan.partBGivebackAmount)} />
              <Row label="Medical Deductible" value={$(plan.medicalDeductible)} />
              <Row label="Max Out of Pocket" value={$(plan.maxOutOfPocket)} />
              <Row label="LIS Level" value={plan.lowIncomeSubsidyLevel ?? "—"} />
              <Row label="Medicaid Level" value={plan.medicaidLevel ?? "—"} />
            </Section>

            <Section title="Medical Cost Sharing">
              <Row label="PCP Copay" value={$(plan.pcpCopay)} />
              <Row label="Specialist Copay" value={$(plan.specialistCopay)} />
              <Row label="Emergency Room" value={$(plan.emergencyRoomCopay)} />
              <Row label="Ambulance" value={$(plan.ambulanceCopay)} />
              <Row label="Outpatient Hospital" value={$(plan.outpatientHospitalCopay)} />
              <Row label="Hospital Stay" value={plan.hospitalStayCopay ?? "—"} />
              <Row label="Skilled Nursing" value={plan.skilledNursingCopay ?? "—"} />
            </Section>

            <Section title="Imaging">
              <Row label="MRI Copay" value={$(plan.mriCopay)} />
              <Row label="CAT Scan Copay" value={$(plan.catScanCopay)} />
            </Section>
          </div>

          <div>
            <Section title="Prescription Drug Costs">
              <Row label="Drug Deductible" value={$(plan.drugDeductible)} />
              <Row label="Tier 1 (Preferred Generic)" value={$(plan.drugTier1Copay)} />
              <Row label="Tier 2 (Generic)" value={$(plan.drugTier2Copay)} />
              <Row label="Tier 3 (Preferred Brand)" value={$(plan.drugTier3Copay)} />
              <Row label="Tier 4 (Non-Preferred)" value={$(plan.drugTier4Copay)} />
              <Row label="Tier 5 (Specialty)" value={$(plan.drugTier5Copay)} />
              <Row label="Tier 6" value={$(plan.drugTier6Copay)} />
            </Section>

            <Section title="Extra Benefits">
              <Row label="OTC Allowance" value={$(plan.otcAllowance)} />
              <Row label="Food Card" value={$(plan.foodCardAllowance)} />
              <Row label="Dental" value={plan.dentalBenefits ?? "—"} />
              <Row label="Vision" value={plan.visionBenefits ?? "—"} />
              <Row label="Hearing" value={plan.hearingBenefits ?? "—"} />
              <Row label="Transportation" value={plan.transportationBenefit ?? "—"} />
            </Section>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-gray-200 bg-gray-50 rounded-b-lg flex justify-between items-center">
          <span className="text-xs text-gray-400">Rank #{plan.rank}</span>
          <button
            onClick={() => window.print()}
            className="px-4 py-1.5 text-sm text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
          >
            Print
          </button>
        </div>
      </div>
    </div>
  );
}
