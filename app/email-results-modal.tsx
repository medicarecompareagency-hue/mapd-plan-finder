"use client";

// "Email these results" pop-up (2026-10-29). Sends every plan in the current
// search — same rows as the plan-detail pop-up — to an agent or prospect via
// POST /api/plans/email. Rows are built by the caller (plan-search.tsx) with
// the table's own formatters so the email matches the screen.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  PLAN_EMAIL_MAX_NOTE,
  PLAN_EMAIL_MAX_RECIPIENTS,
  type PlanEmailContext,
  type PlanEmailPlan,
} from "@/lib/plan-email-types";

export default function EmailResultsModal({
  plans,
  context,
  senderEmail,
  onClose,
}: {
  plans: PlanEmailPlan[];
  context: PlanEmailContext;
  senderEmail: string | null;
  onClose: () => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [to, setTo] = useState("");
  const [ccSelf, setCcSelf] = useState(true);
  const [subject, setSubject] = useState("");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string[] | null>(null);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const defaultSubject = `Medicare Advantage plan summary${context.planYear ? ` — ${context.planYear}` : ""}${
    context.county ? ` — ${context.county} County, ${context.state ?? ""}` : ""
  }`.trim();

  const recipients = to
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  async function send() {
    setError(null);
    if (recipients.length === 0) {
      setError("Enter at least one email address.");
      return;
    }
    if (recipients.length > PLAN_EMAIL_MAX_RECIPIENTS) {
      setError(`Up to ${PLAN_EMAIL_MAX_RECIPIENTS} recipients per email.`);
      return;
    }
    setSending(true);
    try {
      const res = await fetch("/api/plans/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: recipients,
          ccSelf,
          note,
          subject: subject.trim() || undefined,
          context,
          plans,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `Send failed (${res.status}).`);
        return;
      }
      setSentTo(recipients);
    } catch {
      setError("Network error — the email was not sent.");
    } finally {
      setSending(false);
    }
  }

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-16 overflow-y-auto"
      onClick={(e) => { if (e.target === overlayRef.current) onClose(); }}
    >
      <div className="bg-white rounded-lg shadow-2xl w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-gray-200 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold text-gray-900">Email these results</h2>
            <p className="text-sm text-gray-500">
              Sends a summary of all {plans.length} plan{plans.length === 1 ? "" : "s"} in this search
              {senderEmail ? <> — replies go to <span className="font-medium">{senderEmail}</span></> : null}.
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1" aria-label="Close">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {sentTo ? (
          <div className="px-6 py-6">
            <div className="rounded-md bg-green-50 border border-green-200 p-4 text-sm text-green-800">
              Sent to <span className="font-semibold">{sentTo.join(", ")}</span>
              {ccSelf && senderEmail ? <> (copy to {senderEmail})</> : null}.
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => { setSentTo(null); setTo(""); }}
                className="px-4 py-2 text-sm text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
              >
                Send to someone else
              </button>
              <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700">
                Done
              </button>
            </div>
          </div>
        ) : (
          <form
            className="px-6 py-4 space-y-4"
            onSubmit={(e) => { e.preventDefault(); if (!sending) void send(); }}
          >
            <div>
              <label htmlFor="email-to" className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1">
                To
              </label>
              <input
                id="email-to"
                type="text"
                autoFocus
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="prospect@example.com, agent@example.com"
                className="w-full h-10 rounded-md border border-gray-300 px-3 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
              />
              <p className="mt-1 text-[11px] text-gray-500">Separate multiple addresses with commas (up to {PLAN_EMAIL_MAX_RECIPIENTS}).</p>
            </div>

            <div>
              <label htmlFor="email-subject" className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1">
                Subject
              </label>
              <input
                id="email-subject"
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder={defaultSubject}
                className="w-full h-10 rounded-md border border-gray-300 px-3 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="email-note" className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1">
                Message (optional)
              </label>
              <textarea
                id="email-note"
                value={note}
                maxLength={PLAN_EMAIL_MAX_NOTE}
                onChange={(e) => setNote(e.target.value)}
                rows={4}
                placeholder="Hi Mary — here are the plans we talked about. Call me with any questions."
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
              />
            </div>

            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={ccSelf} onChange={(e) => setCcSelf(e.target.checked)} className="h-4 w-4" />
              Send me a copy{senderEmail ? ` (${senderEmail})` : ""}
            </label>

            {error && (
              <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700">{error}</div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={sending}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50"
              >
                {sending ? "Sending…" : `Send ${plans.length} plan${plans.length === 1 ? "" : "s"}`}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body
  );
}
