"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import Combobox from "./combobox";
import PlanDetailModal from "./plan-detail-modal";
import PasswordInput from "./password-input";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface Plan {
  rank: number;
  id: number;
  planId: string;
  planName: string;
  organizationName: string;
  planType: string;
  planCategory: string | null;
  snpSubtype: string | null;
  chronicConditions: string[];
  hasPartD: boolean | null;
  isZeroDollarDsnp: boolean | null;
  cmsContractType: string | null;
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

interface FilterOptions {
  states: string[];
  counties: string[];
  zipCodes: string[];
  planTypes: string[];
    planYears: number[];
    organizationNames: string[];
  planCategories: string[];
  snpSubtypes: string[];
  chronicConditions: string[];
  hasZeroDollarDsnp: boolean;
  monthlyPremiums: number[];
  lowIncomeSubsidyLevels: string[];
  medicaidLevels: string[];
  pcpCopays: number[];
  specialistCopays: number[];
  hospitalStayCopays: string[];
  skilledNursingCopays: string[];
  maxOutOfPockets: number[];
  medicalDeductibles: number[];
  emergencyRoomCopays: number[];
  ambulanceCopays: number[];
  outpatientHospitalCopays: number[];
  drugTier1Copays: number[];
  drugTier2Copays: number[];
  drugTier3Copays: number[];
  drugTier4Copays: number[];
  drugTier5Copays: number[];
  drugTier6Copays: number[];
  drugDeductibles: number[];
  otcAllowances: number[];
  foodCardAllowances: number[];
  mriCopays: number[];
  catScanCopays: number[];
  partBGivebackAmounts: number[];
  dentalBenefits: string[];
  hearingBenefits: string[];
  visionBenefits: string[];
  transportationBenefits: string[];
}

type Filters = Record<string, string>;

// ---------------------------------------------------------------------------
// Enum display labels
// Keep keys in sync with prisma/schema.prisma enums (PlanCategory, SnpSubtype,
// ChronicCondition) and the decoder tables in scripts/import-cms-data.ts.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function dollars(v: number | null | undefined): string {
  if (v == null) return "—";
  return `$${v.toFixed(v % 1 === 0 ? 0 : 2)}`;
}

function FilterSelect({
  label,
  name,
  value,
  onChange,
  options,
  formatOption,
    disabledOptions,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (name: string, value: string) => void;
  options: (string | number)[];
  formatOption?: (v: string | number) => string;
 disabledOptions?: (string | number)[];
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={name} className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
        {label}
      </label>
      <select
        suppressHydrationWarning
        id={name}
        value={value}
        onChange={(e) => onChange(name, e.target.value)}
        className="h-9 rounded-md border border-gray-300 bg-white px-2 text-sm text-gray-800 shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
      >
        <option value="">Any</option>
        {options.map((opt) => {
             const disabled = disabledOptions?.some((d) => String(d) === String(opt)) ?? false;
             return (
               <option key={String(opt)} value={String(opt)} disabled={disabled}>
                 {formatOption ? formatOption(opt) : String(opt)}
               </option>
             );
           })}
      </select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function PlanSearch() {
  const router = useRouter();
  const [filters, setFilters] = useState<Filters>({});
  const [options, setOptions] = useState<FilterOptions | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<Plan | null>(null);

  // User / auth state
  const [user, setUser] = useState<{ id: number; email: string; name: string | null; role: string } | null>(null);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [passwordSuccess, setPasswordSuccess] = useState("");
  const userMenuRef = useRef<HTMLDivElement>(null);

  // Fetch current user on mount
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((data) => { if (data.user) setUser(data.user); });
  }, []);

  // Close user menu on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setShowUserMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  async function handleChangePassword() {
    setPasswordError("");
    setPasswordSuccess("");
    if (newPassword !== confirmPassword) {
      setPasswordError("New passwords do not match");
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError("Password must be at least 8 characters");
      return;
    }
    const res = await fetch("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const data = await res.json();
    if (!res.ok) {
      setPasswordError(data.error || "Failed to change password");
      return;
    }
    setPasswordSuccess("Password changed successfully");
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setTimeout(() => { setShowChangePassword(false); setPasswordSuccess(""); }, 1500);
  }

  // Geography data for type-ahead location fields
  const [geoStates, setGeoStates] = useState<{ value: string; label: string }[]>([]);
  const [geoCounties, setGeoCounties] = useState<{ value: string; label: string }[]>([]);
  const [geoZipCodes, setGeoZipCodes] = useState<{ value: string; label: string }[]>([]);

  // Fetch all US states on mount
  useEffect(() => {
    fetch("/api/geography")
      .then((r) => r.json())
      .then((data: { states: { code: string; name: string }[] }) => {
        setGeoStates(
          data.states.map((s) => ({ value: s.code, label: `${s.name} (${s.code})` })),
        );
      });
  }, []);

  // Fetch counties when state changes
  useEffect(() => {
    if (!filters.state) {
      setGeoCounties([]);
      setGeoZipCodes([]);
      return;
    }
    fetch(`/api/geography?state=${encodeURIComponent(filters.state)}`)
      .then((r) => r.json())
      .then((data: { counties: string[] }) => {
        setGeoCounties(data.counties.map((c) => ({ value: c, label: c })));
      });
  }, [filters.state]);

  // Fetch zip codes when state or county changes
  useEffect(() => {
    if (!filters.state) {
      setGeoZipCodes([]);
      return;
    }
    if (filters.county) {
      // Zip codes for a specific county
      fetch(
        `/api/geography?state=${encodeURIComponent(filters.state)}&county=${encodeURIComponent(filters.county)}`,
      )
        .then((r) => r.json())
        .then((data: { zipCodes: string[] }) => {
          setGeoZipCodes(data.zipCodes.map((z) => ({ value: z, label: z })));
        });
    } else {
      // All zip codes across all counties in the state
      fetch(`/api/geography?state=${encodeURIComponent(filters.state)}`)
        .then((r) => r.json())
        .then((data: { counties: string[] }) => {
          // Fetch zips for every county in parallel, then merge
          Promise.all(
            data.counties.map((c) =>
              fetch(
                `/api/geography?state=${encodeURIComponent(filters.state)}&county=${encodeURIComponent(c)}`,
              )
                .then((r) => r.json())
                .then((d: { zipCodes: string[] }) => d.zipCodes),
            ),
          ).then((arrays) => {
            const allZips = [...new Set(arrays.flat())].sort();
            setGeoZipCodes(allZips.map((z) => ({ value: z, label: z })));
          });
        });
    }
  }, [filters.state, filters.county]);

  // Fetch filter options (scoped by state/county). Only runs once a state is
  // chosen — without a state the query would scan ~186k rows and time out on
  // Vercel, so we skip it entirely and let the FilterSelect dropdowns render
  // with "Any" until the user narrows by location.
  const fetchOptions = useCallback(async (state?: string, county?: string) => {
    if (!state) {
      setOptions(null);
      return;
    }
    try {
      const res = await fetch("/api/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state, county: county || undefined }),
      });
      if (!res.ok) {
        console.error("fetchOptions failed:", res.status, await res.text().catch(() => ""));
        return;
      }
      const data: FilterOptions = await res.json();
      setOptions(data);
    } catch (err) {
      console.error("fetchOptions error:", err);
    }
  }, []);

  // Reverse geo-lookup: when a 5-digit zip is typed or selected, auto-fill state + county
  const reverseZipLookup = useCallback(
    (zip: string) => {
      if (!/^\d{5}$/.test(zip)) return;
      fetch(`/api/geography?zip=${encodeURIComponent(zip)}`)
        .then((r) => r.json())
        .then((data: { state: string | null; county: string | null }) => {
          if (data.state && data.county) {
            setFilters((prev) => ({ ...prev, state: data.state!, county: data.county!, zipCode: zip }));
            fetchOptions(data.state, data.county);
          }
        });
    },
    [fetchOptions],
  );

  function handleFilterChange(name: string, value: string) {
    const next = { ...filters, [name]: value };
    if (!value) delete next[name];

    // Cascade: when state changes, clear county/zip; when county changes, clear zip
    if (name === "state") {
      delete next.county;
      delete next.zipCode;
      fetchOptions(value || undefined);
      setFilters(next);
    } else if (name === "county") {
      delete next.zipCode;
      fetchOptions(next.state, value || undefined);
      setFilters(next);
    } else if (name === "zipCode" && value) {
      // Set zip immediately, then do reverse lookup to fill state/county
      setFilters(next);
      reverseZipLookup(value);
    } else {
      setFilters(next);
    }
  }

  const [searchError, setSearchError] = useState<string | null>(null);
  const [tableWidth, setTableWidth] = useState(0);
  const topScrollRef = useRef<HTMLDivElement>(null);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const scrollSyncRef = useRef(false);

  // Measure the table scroll width after results render
  useEffect(() => {
    if (tableScrollRef.current) {
      setTableWidth(tableScrollRef.current.scrollWidth);
    }
  }, [plans]);

  function handleTopScroll() {
    if (scrollSyncRef.current) return;
    scrollSyncRef.current = true;
    if (tableScrollRef.current && topScrollRef.current) {
      tableScrollRef.current.scrollLeft = topScrollRef.current.scrollLeft;
    }
    scrollSyncRef.current = false;
  }

  function handleTableScroll() {
    if (scrollSyncRef.current) return;
    scrollSyncRef.current = true;
    if (topScrollRef.current && tableScrollRef.current) {
      topScrollRef.current.scrollLeft = tableScrollRef.current.scrollLeft;
    }
    scrollSyncRef.current = false;
  }

  async function handleSearch() {
    setLoading(true);
    setSearched(true);
    setSearchError(null);
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
      // zipCode is for location selection only — state+county is what filters plans
      if (v && k !== "zipCode") params.set(k, v);
    }
    const url = `/api/plans?${params.toString()}`;
    console.log("[PlanSearch] fetching:", url, "filters:", filters);
    try {
      const res = await fetch(url);
      console.log("[PlanSearch] response status:", res.status);
      if (!res.ok) {
        const text = await res.text();
        console.error("[PlanSearch] API error:", res.status, text);
        throw new Error(`API returned ${res.status}: ${text}`);
      }
      const data: Plan[] = await res.json();
      console.log("[PlanSearch] received", data.length, "plans");
      setPlans(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[PlanSearch] search failed:", msg);
      setSearchError(msg);
      setPlans([]);
    } finally {
      setLoading(false);
    }
  }

  function handleReset() {
    setFilters({});
    setPlans([]);
    setSearched(false);
    fetchOptions();
  }

  const fmt = (v: string | number) => (typeof v === "number" ? dollars(v) : v);

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6 max-w-[1600px] mx-auto w-full">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-200 pb-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Medicare Advantage Plan Finder</h1>
          <p className="text-sm text-gray-300 mt-1">
            Filter and compare plans — results ranked best to worst based on your criteria
          </p>
        </div>
        {user && (
          <div className="relative" ref={userMenuRef}>
            <button
              onClick={() => setShowUserMenu(!showUserMenu)}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-white text-sm transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.121 17.804A13.937 13.937 0 0112 16c2.5 0 4.847.655 6.879 1.804M15 10a3 3 0 11-6 0 3 3 0 016 0zm6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="hidden sm:inline">{user.name || user.email}</span>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {showUserMenu && (
              <div className="absolute right-0 mt-2 w-56 bg-white rounded-lg shadow-xl border border-gray-200 z-50 py-1">
                <div className="px-4 py-2 border-b border-gray-100">
                  <p className="text-sm font-medium text-gray-800 truncate">{user.name || "Agent"}</p>
                  <p className="text-xs text-gray-500 truncate">{user.email}</p>
                </div>
                <button
                  onClick={() => { setShowChangePassword(true); setShowUserMenu(false); }}
                  className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                  </svg>
                  Change Password
                </button>
                {user.role === "admin" && (
                  <a
                    href="/admin"
                    className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                    Admin Panel
                  </a>
                )}
                <div className="border-t border-gray-100 mt-1 pt-1">
                  <button
                    onClick={handleLogout}
                    className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 flex items-center gap-2"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                    </svg>
                    Sign Out
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Change Password Modal */}
      {showChangePassword && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setShowChangePassword(false)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-800 mb-4">Change Password</h3>
            {passwordError && (
              <div className="mb-3 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">{passwordError}</div>
            )}
            {passwordSuccess && (
              <div className="mb-3 p-3 rounded-lg bg-green-50 border border-green-200 text-green-700 text-sm">{passwordSuccess}</div>
            )}
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Current Password</label>
                <PasswordInput value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)}
                  className="w-full h-10 rounded-lg border border-gray-300 bg-white px-3 pr-10 text-sm text-gray-800 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 focus:outline-none" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">New Password</label>
                <PasswordInput value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full h-10 rounded-lg border border-gray-300 bg-white px-3 pr-10 text-sm text-gray-800 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 focus:outline-none" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Confirm New Password</label>
                <PasswordInput value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full h-10 rounded-lg border border-gray-300 bg-white px-3 pr-10 text-sm text-gray-800 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 focus:outline-none" />
              </div>
            </div>
            <div className="flex gap-3 mt-5">
              <button onClick={() => { setShowChangePassword(false); setPasswordError(""); setPasswordSuccess(""); setCurrentPassword(""); setNewPassword(""); setConfirmPassword(""); }}
                className="flex-1 h-10 bg-white text-gray-700 text-sm font-semibold rounded-lg border border-gray-300 hover:bg-gray-50 transition-colors">
                Cancel
              </button>
              <button onClick={handleChangePassword}
                className="flex-1 h-10 bg-[#1a3a5c] text-white text-sm font-semibold rounded-lg hover:bg-[#0f2744] transition-colors">
                Update Password
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="bg-gray-50 rounded-lg border border-gray-200 p-4">
        <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Location</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3 mb-4">
          <Combobox label="State" name="state" value={filters.state ?? ""} onChange={handleFilterChange} options={geoStates} placeholder="Search states..." />
          <Combobox label="County" name="county" value={filters.county ?? ""} onChange={handleFilterChange} options={geoCounties} placeholder="Search counties..." disabled={!filters.state} />
          <Combobox label="Zip Code" name="zipCode" value={filters.zipCode ?? ""} onChange={handleFilterChange} options={geoZipCodes} placeholder="Enter zip code..." onInputChange={reverseZipLookup} />
          <FilterSelect label="Contract Type" name="planType" value={filters.planType ?? ""} onChange={handleFilterChange} options={options?.planTypes ?? []} />

   <FilterSelect
     label="Carrier"
     name="organizationName"
     value={filters.organizationName ?? ""}
     onChange={handleFilterChange}
     options={options?.organizationNames ?? []}
   />

   <FilterSelect
     label="Plan Year"
     name="planYear"
     value={filters.planYear ?? ""}
     onChange={handleFilterChange}
     options={[...(options?.planYears ?? []), 2027]}
     disabledOptions={[2027]}
     formatOption={(v) => (Number(v) === 2027 ? "2027 (coming soon)" : String(v))}
   />
        </div>

        <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Plan Category</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3 mb-4">
          <FilterSelect
            label="Plan Category"
            name="planCategory"
            value={filters.planCategory ?? ""}
            onChange={handleFilterChange}
            options={options?.planCategories ?? []}
            formatOption={(v) => PLAN_CATEGORY_LABELS[String(v)] ?? String(v)}
          />
          {filters.planCategory === "CSNP" && (
            <FilterSelect
              label="CSNP Condition"
              name="chronicCondition"
              value={filters.chronicCondition ?? ""}
              onChange={handleFilterChange}
              options={options?.chronicConditions ?? []}
              formatOption={(v) => CHRONIC_CONDITION_LABELS[String(v)] ?? String(v)}
            />
          )}
          {filters.planCategory === "ISNP" && (
            <FilterSelect
              label="ISNP Type"
              name="snpSubtype"
              value={filters.snpSubtype ?? ""}
              onChange={handleFilterChange}
              options={(options?.snpSubtypes ?? []).filter((s) => s.startsWith("ISNP_"))}
              formatOption={(v) => SNP_SUBTYPE_LABELS[String(v)] ?? String(v)}
            />
          )}
          {filters.planCategory === "DSNP" && options?.hasZeroDollarDsnp && (
            <div className="flex flex-col gap-1">
              <label htmlFor="isZeroDollarDsnp" className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
                $0 Premium DSNPs Only
              </label>
              <div className="flex items-center h-9">
                <input
                  id="isZeroDollarDsnp"
                  type="checkbox"
                  checked={filters.isZeroDollarDsnp === "true"}
                  onChange={(e) => handleFilterChange("isZeroDollarDsnp", e.target.checked ? "true" : "")}
                  className="w-5 h-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
              </div>
            </div>
          )}
        </div>

        <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Premiums & Subsidies</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3 mb-4">
          <FilterSelect label="Monthly Premium" name="monthlyPremium" value={filters.monthlyPremium ?? ""} onChange={handleFilterChange} options={options?.monthlyPremiums ?? []} formatOption={fmt} />
          <FilterSelect label="Part B Giveback" name="partBGivebackAmount" value={filters.partBGivebackAmount ?? ""} onChange={handleFilterChange} options={options?.partBGivebackAmounts ?? []} formatOption={fmt} />
          <FilterSelect label="LIS Level" name="lowIncomeSubsidyLevel" value={filters.lowIncomeSubsidyLevel ?? ""} onChange={handleFilterChange} options={options?.lowIncomeSubsidyLevels ?? []} />
          <FilterSelect label="Medicaid Level" name="medicaidLevel" value={filters.medicaidLevel ?? ""} onChange={handleFilterChange} options={options?.medicaidLevels ?? []} />
        </div>

        <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Medical Cost Sharing</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3 mb-4">
          <FilterSelect label="PCP Copay" name="pcpCopay" value={filters.pcpCopay ?? ""} onChange={handleFilterChange} options={options?.pcpCopays ?? []} formatOption={fmt} />
          <FilterSelect label="Specialist Copay" name="specialistCopay" value={filters.specialistCopay ?? ""} onChange={handleFilterChange} options={options?.specialistCopays ?? []} formatOption={fmt} />
          <FilterSelect label="ER Copay" name="emergencyRoomCopay" value={filters.emergencyRoomCopay ?? ""} onChange={handleFilterChange} options={options?.emergencyRoomCopays ?? []} formatOption={fmt} />
          <FilterSelect label="Ambulance Copay" name="ambulanceCopay" value={filters.ambulanceCopay ?? ""} onChange={handleFilterChange} options={options?.ambulanceCopays ?? []} formatOption={fmt} />
          <FilterSelect label="Hospital Stay" name="hospitalStayCopay" value={filters.hospitalStayCopay ?? ""} onChange={handleFilterChange} options={options?.hospitalStayCopays ?? []} />
          <FilterSelect label="Skilled Nursing" name="skilledNursingCopay" value={filters.skilledNursingCopay ?? ""} onChange={handleFilterChange} options={options?.skilledNursingCopays ?? []} />
          <FilterSelect label="Max Out of Pocket" name="maxOutOfPocket" value={filters.maxOutOfPocket ?? ""} onChange={handleFilterChange} options={options?.maxOutOfPockets ?? []} formatOption={fmt} />
          <FilterSelect label="Medical Deductible" name="medicalDeductible" value={filters.medicalDeductible ?? ""} onChange={handleFilterChange} options={options?.medicalDeductibles ?? []} formatOption={fmt} />
          <FilterSelect label="Outpatient Hospital" name="outpatientHospitalCopay" value={filters.outpatientHospitalCopay ?? ""} onChange={handleFilterChange} options={options?.outpatientHospitalCopays ?? []} formatOption={fmt} />
        </div>

        <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Imaging</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3 mb-4">
          <FilterSelect label="MRI Copay" name="mriCopay" value={filters.mriCopay ?? ""} onChange={handleFilterChange} options={options?.mriCopays ?? []} formatOption={fmt} />
          <FilterSelect label="CAT Scan Copay" name="catScanCopay" value={filters.catScanCopay ?? ""} onChange={handleFilterChange} options={options?.catScanCopays ?? []} formatOption={fmt} />
        </div>

        <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Prescription Drug Costs</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3 mb-4">
          <FilterSelect label="Drug Deductible" name="drugDeductible" value={filters.drugDeductible ?? ""} onChange={handleFilterChange} options={options?.drugDeductibles ?? []} formatOption={fmt} />
          <FilterSelect label="Tier 1 (Preferred Generic)" name="drugTier1Copay" value={filters.drugTier1Copay ?? ""} onChange={handleFilterChange} options={options?.drugTier1Copays ?? []} formatOption={fmt} />
          <FilterSelect label="Tier 2 (Generic)" name="drugTier2Copay" value={filters.drugTier2Copay ?? ""} onChange={handleFilterChange} options={options?.drugTier2Copays ?? []} formatOption={fmt} />
          <FilterSelect label="Tier 3 (Preferred Brand)" name="drugTier3Copay" value={filters.drugTier3Copay ?? ""} onChange={handleFilterChange} options={options?.drugTier3Copays ?? []} formatOption={fmt} />
          <FilterSelect label="Tier 4 (Non-Preferred)" name="drugTier4Copay" value={filters.drugTier4Copay ?? ""} onChange={handleFilterChange} options={options?.drugTier4Copays ?? []} formatOption={fmt} />
          <FilterSelect label="Tier 5 (Specialty)" name="drugTier5Copay" value={filters.drugTier5Copay ?? ""} onChange={handleFilterChange} options={options?.drugTier5Copays ?? []} formatOption={fmt} />
          <FilterSelect label="Tier 6" name="drugTier6Copay" value={filters.drugTier6Copay ?? ""} onChange={handleFilterChange} options={options?.drugTier6Copays ?? []} formatOption={fmt} />
        </div>

        <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Extra Benefits</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3 mb-4">
          <FilterSelect label="OTC Allowance" name="otcAllowance" value={filters.otcAllowance ?? ""} onChange={handleFilterChange} options={options?.otcAllowances ?? []} formatOption={fmt} />
          <FilterSelect label="Food Card Allowance" name="foodCardAllowance" value={filters.foodCardAllowance ?? ""} onChange={handleFilterChange} options={options?.foodCardAllowances ?? []} formatOption={fmt} />
          <FilterSelect label="Dental Benefits" name="dentalBenefits" value={filters.dentalBenefits ?? ""} onChange={handleFilterChange} options={options?.dentalBenefits ?? []} />
          <FilterSelect label="Hearing Aid Benefits" name="hearingBenefits" value={filters.hearingBenefits ?? ""} onChange={handleFilterChange} options={options?.hearingBenefits ?? []} />
          <FilterSelect label="Vision Benefits" name="visionBenefits" value={filters.visionBenefits ?? ""} onChange={handleFilterChange} options={options?.visionBenefits ?? []} />
          <FilterSelect label="Transportation" name="transportationBenefit" value={filters.transportationBenefit ?? ""} onChange={handleFilterChange} options={options?.transportationBenefits ?? []} />
        </div>

        {/* Action buttons */}
        <div className="flex gap-3 pt-2">
          <button
            onClick={handleSearch}
            disabled={loading}
            className="px-6 py-2 bg-blue-600 text-white text-sm font-semibold rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? "Searching..." : "Search Plans"}
          </button>
          <button
            onClick={handleReset}
            className="px-6 py-2 bg-white text-gray-700 text-sm font-semibold rounded-md border border-gray-300 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gray-400 focus:ring-offset-2 transition-colors"
          >
            Reset
          </button>
        </div>
      </div>

      {/* Results */}
      {searched && (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
            <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide">
              Results ({plans.length} plan{plans.length !== 1 ? "s" : ""})
            </h2>
            <p className="text-xs text-gray-500">
              {loading ? "Loading..." : `Ranked best to worst based on selected criteria`}
            </p>
          </div>

          {searchError ? (
            <div className="p-8 text-center text-red-500">
              Search error: {searchError}
            </div>
          ) : plans.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              No plans match your selected filters. Try broadening your criteria.
            </div>
          ) : (
            <>
            <div ref={topScrollRef} onScroll={handleTopScroll} className="overflow-x-auto" style={{ overflowY: "hidden", height: 20 }}>
              <div style={{ width: tableWidth || "100%", height: 1 }} />
            </div>
            <div ref={tableScrollRef} onScroll={handleTableScroll} className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                    <th className="px-3 py-3 sticky left-0 bg-gray-50 z-10">Rank</th>
                    <th className="px-3 py-3 sticky left-[52px] bg-gray-50 z-10 min-w-[200px]">Plan</th>
                    <th className="px-3 py-3">Type</th>
                    <th className="px-3 py-3 min-w-[180px]">Category</th>
                    <th className="px-3 py-3">State</th>
                    <th className="px-3 py-3">County</th>
                    <th className="px-3 py-3 text-right">Premium</th>
                    <th className="px-3 py-3 text-right">Part B Giveback</th>
                    <th className="px-3 py-3">LIS Level</th>
                    <th className="px-3 py-3">Medicaid</th>
                    <th className="px-3 py-3 text-right">MOOP</th>
                    <th className="px-3 py-3 text-right">Med. Deduct.</th>
                    <th className="px-3 py-3 text-right">PCP</th>
                    <th className="px-3 py-3 text-right">Specialist</th>
                    <th className="px-3 py-3 text-right">ER</th>
                    <th className="px-3 py-3 text-right">Ambulance</th>
                    <th className="px-3 py-3 text-right">Outpatient Hosp.</th>
                    <th className="px-3 py-3">Hospital Stay</th>
                    <th className="px-3 py-3">Skilled Nursing</th>
                    <th className="px-3 py-3 text-right">MRI</th>
                    <th className="px-3 py-3 text-right">CAT Scan</th>
                    <th className="px-3 py-3 text-right">Drug Deduct.</th>
                    <th className="px-3 py-3 text-right">Tier 1</th>
                    <th className="px-3 py-3 text-right">Tier 2</th>
                    <th className="px-3 py-3 text-right">Tier 3</th>
                    <th className="px-3 py-3 text-right">Tier 4</th>
                    <th className="px-3 py-3 text-right">Tier 5</th>
                    <th className="px-3 py-3 text-right">Tier 6</th>
                    <th className="px-3 py-3 text-right">OTC</th>
                    <th className="px-3 py-3 text-right">Food Card</th>
                    <th className="px-3 py-3">Dental</th>
                    <th className="px-3 py-3">Hearing</th>
                    <th className="px-3 py-3">Vision</th>
                    <th className="px-3 py-3">Transportation</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {plans.map((plan) => (
                    <tr key={plan.id} className="hover:bg-blue-50/50 transition-colors">
                      <td className="px-3 py-3 sticky left-0 bg-white z-10 font-bold text-blue-600">{plan.rank}</td>
                      <td className="px-3 py-3 sticky left-[52px] bg-white z-10">
                        <button type="button" onClick={() => setSelectedPlan(plan)} className="text-left hover:underline">
                          <div className="font-medium text-blue-700 leading-tight">{plan.planName}</div>
                          <div className="text-xs text-gray-500">{plan.organizationName} &middot; {plan.planId}</div>
                        </button>
                      </td>
                      <td className="px-3 py-3">
                        <span className="inline-block px-2 py-0.5 text-xs font-semibold bg-blue-100 text-blue-800 rounded">
                          {plan.planType}
                        </span>
                      </td>
                      <td className="px-3 py-3 min-w-[180px]">
                        {plan.planCategory ? (
                          <div className="flex flex-col gap-1">
                            <div className="flex items-center gap-1 flex-wrap">
                              <span
                                className={`inline-block px-2 py-0.5 text-xs font-semibold rounded ${
                                  plan.planCategory === "DSNP"
                                    ? "bg-purple-100 text-purple-800"
                                    : plan.planCategory === "CSNP"
                                    ? "bg-amber-100 text-amber-800"
                                    : plan.planCategory === "ISNP"
                                    ? "bg-rose-100 text-rose-800"
                                    : plan.planCategory === "MAPD"
                                    ? "bg-emerald-100 text-emerald-800"
                                    : plan.planCategory === "MA_ONLY"
                                    ? "bg-sky-100 text-sky-800"
                                    : "bg-gray-100 text-gray-800"
                                }`}
                                title={PLAN_CATEGORY_LABELS[plan.planCategory] ?? plan.planCategory}
                              >
                                {plan.planCategory.replace("_", "-")}
                              </span>
                              {plan.isZeroDollarDsnp === true && (
                                <span
                                  className="inline-block px-1.5 py-0.5 text-xs font-bold bg-green-100 text-green-800 rounded"
                                  title="$0 premium DSNP"
                                >
                                  $0
                                </span>
                              )}
                              {plan.snpSubtype && plan.planCategory === "ISNP" && (
                                <span
                                  className="inline-block px-1.5 py-0.5 text-[10px] font-semibold bg-rose-50 text-rose-700 rounded border border-rose-200"
                                  title={SNP_SUBTYPE_LABELS[plan.snpSubtype] ?? plan.snpSubtype}
                                >
                                  {plan.snpSubtype.replace("ISNP_", "")}
                                </span>
                              )}
                            </div>
                            {plan.planCategory === "CSNP" && plan.chronicConditions.length > 0 && (
                              <div className="flex flex-wrap gap-1">
                                {plan.chronicConditions.slice(0, 3).map((cond) => (
                                  <span
                                    key={cond}
                                    className="inline-block px-1.5 py-0.5 text-[10px] font-medium bg-amber-50 text-amber-700 rounded border border-amber-200"
                                    title={CHRONIC_CONDITION_LABELS[cond] ?? cond}
                                  >
                                    {(CHRONIC_CONDITION_LABELS[cond] ?? cond).split(" ").slice(0, 2).join(" ")}
                                  </span>
                                ))}
                                {plan.chronicConditions.length > 3 && (
                                  <span className="text-[10px] text-gray-500 self-center">
                                    +{plan.chronicConditions.length - 3} more
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-gray-900">{plan.state}</td>
                      <td className="px-3 py-3 text-gray-900">{plan.county}</td>
                      <td className="px-3 py-3 text-right text-gray-900 font-medium">{dollars(plan.monthlyPremium)}</td>
                      <td className="px-3 py-3 text-right text-green-700 font-medium">{dollars(plan.partBGivebackAmount)}</td>
                      <td className="px-3 py-3 text-gray-900">{plan.lowIncomeSubsidyLevel ?? "—"}</td>
                      <td className="px-3 py-3 text-gray-900">{plan.medicaidLevel ?? "—"}</td>
                      <td className="px-3 py-3 text-right text-gray-900">{dollars(plan.maxOutOfPocket)}</td>
                      <td className="px-3 py-3 text-right text-gray-900">{dollars(plan.medicalDeductible)}</td>
                      <td className="px-3 py-3 text-right text-gray-900">{dollars(plan.pcpCopay)}</td>
                      <td className="px-3 py-3 text-right text-gray-900">{dollars(plan.specialistCopay)}</td>
                      <td className="px-3 py-3 text-right text-gray-900">{dollars(plan.emergencyRoomCopay)}</td>
                      <td className="px-3 py-3 text-right text-gray-900">{dollars(plan.ambulanceCopay)}</td>
                      <td className="px-3 py-3 text-right text-gray-900">{dollars(plan.outpatientHospitalCopay)}</td>
                      <td className="px-3 py-3 text-xs text-gray-900">{plan.hospitalStayCopay ?? "—"}</td>
                      <td className="px-3 py-3 text-xs text-gray-900">{plan.skilledNursingCopay ?? "—"}</td>
                      <td className="px-3 py-3 text-right text-gray-900">{dollars(plan.mriCopay)}</td>
                      <td className="px-3 py-3 text-right text-gray-900">{dollars(plan.catScanCopay)}</td>
                      <td className="px-3 py-3 text-right text-gray-900">{dollars(plan.drugDeductible)}</td>
                      <td className="px-3 py-3 text-right text-gray-900">{dollars(plan.drugTier1Copay)}</td>
                      <td className="px-3 py-3 text-right text-gray-900">{dollars(plan.drugTier2Copay)}</td>
                      <td className="px-3 py-3 text-right text-gray-900">{dollars(plan.drugTier3Copay)}</td>
                      <td className="px-3 py-3 text-right text-gray-900">{dollars(plan.drugTier4Copay)}</td>
                      <td className="px-3 py-3 text-right text-gray-900">{dollars(plan.drugTier5Copay)}</td>
                      <td className="px-3 py-3 text-right text-gray-900">{dollars(plan.drugTier6Copay)}</td>
                      <td className="px-3 py-3 text-right text-gray-900">{dollars(plan.otcAllowance)}</td>
                      <td className="px-3 py-3 text-right text-gray-900">{dollars(plan.foodCardAllowance)}</td>
                      <td className="px-3 py-3 text-sm text-gray-900 min-w-[180px]">{plan.dentalBenefits ?? "—"}</td>
                      <td className="px-3 py-3 text-sm text-gray-900 min-w-[180px]">{plan.hearingBenefits ?? "—"}</td>
                      <td className="px-3 py-3 text-sm text-gray-900 min-w-[180px]">{plan.visionBenefits ?? "—"}</td>
                      <td className="px-3 py-3 text-sm text-gray-900 min-w-[180px]">{plan.transportationBenefit ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )}
        </div>
      )}

      {selectedPlan && (
        <PlanDetailModal plan={selectedPlan} onClose={() => setSelectedPlan(null)} />
      )}
    </div>
  );
}
