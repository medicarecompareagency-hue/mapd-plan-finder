"use client";

// components/DrugTierCell.tsx
//
// Renders a single drug tier cost with the correct unit ($ or %) and a
// small info icon next to coinsurance tiers. Clicking the icon opens an
// explanation modal.
//
// Why this exists:
//   The Plan table stores tier copays as Float, which can't distinguish
//   "$50 copay" from "50% coinsurance". The drugTierCoinsuranceMask
//   column is a String like "45" meaning tiers 4 and 5 use coinsurance.
//   This component reads that mask and renders the right unit.
//
// Usage:
//   <DrugTierCell tier={1} value={plan.drugTier1Copay} mask={plan.drugTierCoinsuranceMask} />
//
// Tailwind-only, no external deps.

import { useState, useEffect } from "react";

interface DrugTierCellProps {
  tier: 1 | 2 | 3 | 4 | 5 | 6;
  value: number | null | undefined;
  mask: string | null | undefined;
}

export default function DrugTierCell({ tier, value, mask }: DrugTierCellProps) {
  const [open, setOpen] = useState(false);

  // Lock body scroll while modal is open
  useEffect(() => {
    if (open) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = prev; };
    }
  }, [open]);

  if (value === null || value === undefined) {
    return <span className="text-gray-400">N/A</span>;
  }

  const isCoinsurance = !!(mask && mask.includes(String(tier)));

  if (!isCoinsurance) {
    return <span>${value}</span>;
  }

  return (
    <>
      <span className="inline-flex items-center gap-1">
        <span>{value}%</span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-blue-100 text-[10px] font-bold text-blue-700 hover:bg-blue-200 focus:outline-none focus:ring-2 focus:ring-blue-400"
          aria-label="About coinsurance"
          title="About coinsurance"
        >
          i
        </button>
      </span>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="coinsurance-modal-title"
        >
          <div
            className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <h3
                id="coinsurance-modal-title"
                className="text-lg font-semibold text-gray-900"
              >
                How coinsurance works
              </h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded text-gray-400 hover:text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-400"
                aria-label="Close"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="mt-4 space-y-3 text-sm text-gray-700">
              <p>
                A <strong>copay</strong> is a fixed dollar amount you pay per
                prescription (e.g. &ldquo;$10 for a generic&rdquo;).
              </p>
              <p>
                <strong>Coinsurance</strong> is a percentage of the drug&rsquo;s
                total cost. You pay that percentage after any deductible is met.
              </p>
              <div className="rounded bg-blue-50 p-3">
                <p className="font-medium text-blue-900">Example</p>
                <p className="mt-1 text-blue-900">
                  If this tier shows <strong>{value}%</strong> and a 30-day
                  supply of the drug costs <strong>$500</strong>, you pay{" "}
                  <strong>${Math.round((value / 100) * 500)}</strong> per fill.
                  If it costs <strong>$2,000</strong>, you pay{" "}
                  <strong>${Math.round((value / 100) * 2000)}</strong>.
                </p>
              </div>
              <p>
                Tiers that use coinsurance are typically Non-Preferred Brand and
                Specialty &mdash; high-cost drugs where the plan asks you to
                share more of the risk.
              </p>
            </div>

            <div className="mt-6 flex justify-end">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-400"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
