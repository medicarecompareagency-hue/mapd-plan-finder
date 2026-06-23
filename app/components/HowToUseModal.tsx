'use client';
import { useEffect, useState } from 'react';

type Section = { title: string; ordered?: boolean; items?: string[]; paras?: string[] };

const SECTIONS: Section[] = [
  { title: 'Finding plans', ordered: true, items: [
    "Sign in with your agent email and password.",
    "Choose a State. Then pick a County, enter a ZIP code, or both — entering a ZIP auto-fills State and County for you.",
    "Set the Plan Year (defaults to the current year).",
    "Click Search Plans.",
  ]},
  { title: 'Narrow the results (all optional)', items: [
    "Contract Type — HMO, PPO, PFFS, HMO-POS, and similar CMS contract types.",
    "Plan Category — MAPD, D-SNP, C-SNP, I-SNP, MA-Only, and others.",
    "Carrier — limit results to one organization.",
    "Part B Giveback — show only plans that pay back part of the client's Part B premium.",
  ]},
  { title: 'Dual-eligible and Extra Help', items: [
    "Beneficiary Medicaid Level — required for D-SNP searches. Choose the client's level (QMB+, QMB, SLMB+, SLMB, QI-1, or FBDE) so plans rank correctly. The red prompt after clicking Search is expected, not an error.",
    "LIS / Extra Help Level — set the client's Extra Help level (Full, 75%, 50%, or 25%) to see adjusted drug copays. Use the LIS Qualifier button to check whether a client qualifies and which level applies.",
  ]},
  { title: 'Reading the results', paras: [
    "Up to 10 plans are returned, ranked best to worst: lowest adjusted premium first, then lowest medical deductible, hospital copay, specialist copay, max out-of-pocket, and finally highest star rating.",
    "Each row shows premium, deductibles, key copays, MOOP, drug tiers, and extra benefits such as OTC allowance, Food Card, dental, hearing, vision, and Part B Giveback. Click a plan name to open the detail view. Follow the SB PDF link for the carrier's official Summary of Benefits, or the medicare.gov link if no PDF is on file.",
  ]},
  { title: 'Tips', items: [
    "No ZIP? Search by State and County alone.",
    "Part B Giveback means the plan pays part of the client's Part B premium directly back to them each month.",
    "OTC and Food Card cells show the cadence (monthly, quarterly, yearly) and whether the benefit is for All Members or Chronic-condition only.",
    "Star ratings are CMS's 1 to 5 quality score — higher is better.",
  ]},
];

function withBoldLabel(s: string) {
  const i = s.indexOf(' — ');
  return i > -1 ? (<><strong>{s.slice(0, i)}</strong>{s.slice(i)}</>) : s;
}

export default function HowToUseModal() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false); }
    if (open) document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog"
        className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-800 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500">
        <span aria-hidden="true" className="flex h-5 w-5 items-center justify-center rounded-full bg-gray-800 text-xs font-bold text-white">?</span>
        How To Use
      </button>

      {open ? (
        <div role="dialog" aria-modal="true" aria-labelledby="howto-title"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:items-center">
          <div onClick={(e) => e.stopPropagation()}
            className="relative my-8 w-full max-w-lg rounded-xl bg-white p-6 shadow-xl">
            <button type="button" onClick={() => setOpen(false)} aria-label="Close"
              className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-700">&#x2715;</button>
            <h2 id="howto-title" className="mb-4 pr-8 text-xl font-bold text-gray-900">How to use MCA Plan Finder</h2>
            <div className="max-h-[70vh] space-y-5 overflow-y-auto pr-1 text-sm leading-relaxed text-gray-700">
              {SECTIONS.map((sec) => (
                <section key={sec.title}>
                  <h3 className="mb-1 font-semibold text-gray-900">{sec.title}</h3>
                  {sec.paras ? sec.paras.map((p, i) => (<p key={i} className={i ? 'mt-2' : ''}>{p}</p>)) : null}
                  {sec.items ? (
                    sec.ordered ? (
                      <ol className="list-decimal space-y-1 pl-5">{sec.items.map((it, i) => (<li key={i}>{withBoldLabel(it)}</li>))}</ol>
                    ) : (
                      <ul className="list-disc space-y-1 pl-5">{sec.items.map((it, i) => (<li key={i}>{withBoldLabel(it)}</li>))}</ul>
                    )
                  ) : null}
                </section>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
