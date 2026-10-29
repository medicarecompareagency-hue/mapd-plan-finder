import nodemailer from "nodemailer";
import type { PlanEmailContext, PlanEmailPlan } from "./plan-email-types";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: parseInt(process.env.SMTP_PORT || "587"),
  secure: false,
  requireTLS: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  logger: true,
  debug: true,
});

export async function sendPasswordResetEmail(
  to: string,
  resetUrl: string,
  name: string | null
) {
  await transporter.sendMail({
    from: `"MCA Plan Finder" <${process.env.SMTP_USER}>`,
    to,
    subject: "Password Reset - MCA Plan Finder",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <div style="background: #1a3a5c; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: #ffffff; margin: 0; font-size: 20px;">MCA Plan Finder</h1>
          <p style="color: #93c5fd; margin: 4px 0 0; font-size: 13px;">mcaplanfinder.xyz</p>
        </div>
        <div style="background: #ffffff; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
          <p style="color: #374151; font-size: 15px; margin: 0 0 16px;">
            Hi ${name || "there"},
          </p>
          <p style="color: #374151; font-size: 15px; margin: 0 0 16px;">
            We received a request to reset your password. Click the button below to set a new password. This link expires in 1 hour.
          </p>
          <div style="text-align: center; margin: 24px 0;">
            <a href="${resetUrl}" style="display: inline-block; background: #1a3a5c; color: #ffffff; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">
              Reset Password
            </a>
          </div>
          <p style="color: #6b7280; font-size: 13px; margin: 0;">
            If you didn't request this, you can safely ignore this email. Your password will remain unchanged.
          </p>
        </div>
        <p style="text-align: center; color: #9ca3af; font-size: 11px; margin: 16px 0 0;">
          Medicare Compare Agency
        </p>
      </div>
    `,
  });
}

// ---------------------------------------------------------------------------
// "Email these results" — sends every plan in the agent's current search as a
// stacked set of plan summaries (same rows as the plan-detail pop-up).
// Added 2026-10-29.
// ---------------------------------------------------------------------------

// Shown at the bottom of every plan-summary email. Edit the wording here.
export const PLAN_EMAIL_DISCLAIMER =
  "We do not offer every plan available in your area. Any information we provide is limited to those plans we do offer in your area. " +
  "Please contact Medicare.gov or 1-800-MEDICARE (TTY 1-877-486-2048), 24 hours a day/7 days a week, to get information on all of your options. " +
  "Benefits, premiums and cost sharing shown are a summary taken from CMS plan filings and carrier Summaries of Benefits and may change; " +
  "they are not a complete description of benefits. Enrollment depends on contract renewal and plan availability in your county.";

function esc(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function contextLine(c: PlanEmailContext): string {
  const parts: string[] = [];
  if (c.planYear) parts.push(`Plan year ${c.planYear}`);
  const where = [c.county ? `${c.county} County` : null, c.state, c.zip ? `ZIP ${c.zip}` : null].filter(Boolean).join(", ");
  if (where) parts.push(where);
  if (c.categoryLabel) parts.push(c.categoryLabel);
  if (c.contractType) parts.push(c.contractType);
  if (c.carrier) parts.push(c.carrier);
  if (c.dualLevel) parts.push(`Medicaid level: ${c.dualLevel}`);
  if (c.lisLevel) parts.push(`LIS level: ${c.lisLevel}`);
  return parts.join(" · ");
}

function planHtml(p: PlanEmailPlan): string {
  const sections = p.sections
    .map(
      (s) => `
        <tr><td colspan="2" style="padding:12px 0 4px;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#6b7280;border-bottom:2px solid #e5e7eb;">${esc(s.title)}</td></tr>
        ${s.rows
          .map(
            (r) => `
        <tr>
          <td style="padding:5px 0;font-size:13px;color:#4b5563;border-bottom:1px solid #f3f4f6;vertical-align:top;">${esc(r.label)}</td>
          <td style="padding:5px 0;font-size:13px;color:#111827;font-weight:600;text-align:right;border-bottom:1px solid #f3f4f6;vertical-align:top;">${esc(r.value)}</td>
        </tr>`
          )
          .join("")}`
    )
    .join("");

  const links: string[] = [];
  if (p.sbPdfUrl) links.push(`<a href="${esc(p.sbPdfUrl)}" style="color:#1d4ed8;">Summary of Benefits (PDF)</a>`);
  if (p.compareUrl) links.push(`<a href="${esc(p.compareUrl)}" style="color:#1d4ed8;">View on Medicare.gov</a>`);

  const badges = p.badges.length
    ? `<div style="margin-top:6px;">${p.badges
        .map((b) => `<span style="display:inline-block;margin:0 4px 4px 0;padding:2px 8px;font-size:11px;font-weight:600;color:#1e3a5f;background:#e8eef5;border-radius:10px;">${esc(b)}</span>`)
        .join("")}</div>`
    : "";

  return `
    <div style="margin:0 0 20px;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">
      <div style="background:#f3f6fa;padding:12px 16px;border-bottom:1px solid #e5e7eb;">
        <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;">Rank #${p.rank}</div>
        <div style="font-size:16px;font-weight:700;color:#111827;">${esc(p.planName)}</div>
        <div style="font-size:12px;color:#4b5563;">${esc(p.organizationName)} · ${esc(p.planId)} · ${esc(p.planType)}${p.categoryLabel ? ` · ${esc(p.categoryLabel)}` : ""}</div>
        ${badges}
        ${links.length ? `<div style="margin-top:6px;font-size:12px;">${links.join(" &nbsp;|&nbsp; ")}</div>` : ""}
      </div>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="padding:0 16px 12px;border-collapse:collapse;">
        ${sections}
      </table>
    </div>`;
}

function planText(p: PlanEmailPlan): string {
  const lines: string[] = [];
  lines.push(`#${p.rank}  ${p.planName}`);
  lines.push(`    ${p.organizationName} · ${p.planId} · ${p.planType}${p.categoryLabel ? ` · ${p.categoryLabel}` : ""}`);
  if (p.badges.length) lines.push(`    ${p.badges.join(" | ")}`);
  if (p.sbPdfUrl) lines.push(`    Summary of Benefits: ${p.sbPdfUrl}`);
  if (p.compareUrl) lines.push(`    Medicare.gov: ${p.compareUrl}`);
  for (const s of p.sections) {
    lines.push("");
    lines.push(`    ${s.title.toUpperCase()}`);
    for (const r of s.rows) lines.push(`      ${r.label}: ${r.value}`);
  }
  return lines.join("\n");
}

export async function sendPlanSummaryEmail(opts: {
  to: string[];
  ccSelf: boolean;
  note: string;
  subject?: string;
  sender: { email: string; name: string | null };
  context: PlanEmailContext;
  plans: PlanEmailPlan[];
}) {
  const { to, ccSelf, note, sender, context, plans } = opts;
  const agentName = sender.name?.trim() || sender.email;
  const ctx = contextLine(context);
  const subject =
    opts.subject?.trim() ||
    `Medicare Advantage plan summary${context.planYear ? ` — ${context.planYear}` : ""}${context.county ? ` — ${context.county} County, ${context.state ?? ""}` : ""}`.trim();

  const noteHtml = note.trim()
    ? `<div style="margin:0 0 20px;padding:14px 16px;background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;font-size:14px;color:#374151;white-space:pre-wrap;">${esc(note.trim())}</div>`
    : "";

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:680px;margin:0 auto;padding:16px;color:#111827;">
    <div style="background:#1a3a5c;padding:20px 24px;border-radius:12px 12px 0 0;">
      <div style="color:#ffffff;font-size:20px;font-weight:700;margin:0;">Medicare Advantage Plan Summary</div>
      <div style="color:#93c5fd;font-size:13px;margin-top:4px;">${esc(ctx) || "Plan comparison"}</div>
    </div>
    <div style="background:#ffffff;padding:20px 24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;">
      <p style="font-size:14px;color:#374151;margin:0 0 16px;">
        ${esc(agentName)} prepared this comparison of <b>${plans.length}</b> plan${plans.length === 1 ? "" : "s"} for you, ranked best to worst for the criteria above.
      </p>
      ${noteHtml}
      ${plans.map(planHtml).join("")}
      <p style="font-size:13px;color:#374151;margin:16px 0 0;">
        Questions? Reply to this email to reach ${esc(agentName)} (${esc(sender.email)}).
      </p>
      <p style="font-size:11px;color:#6b7280;line-height:1.5;margin:20px 0 0;border-top:1px solid #e5e7eb;padding-top:12px;">
        ${esc(PLAN_EMAIL_DISCLAIMER)}
      </p>
    </div>
    <p style="text-align:center;color:#9ca3af;font-size:11px;margin:16px 0 0;">Medicare Compare Agency · Sent from MCA Plan Finder</p>
  </div>`;

  const text = [
    "MEDICARE ADVANTAGE PLAN SUMMARY",
    ctx,
    "",
    `${agentName} prepared this comparison of ${plans.length} plan(s) for you, ranked best to worst.`,
    note.trim() ? `\n${note.trim()}\n` : "",
    ...plans.map((p) => `\n${planText(p)}\n${"-".repeat(60)}`),
    "",
    `Questions? Reply to this email to reach ${agentName} (${sender.email}).`,
    "",
    PLAN_EMAIL_DISCLAIMER,
    "",
    "Medicare Compare Agency · Sent from MCA Plan Finder",
  ].join("\n");

  await transporter.sendMail({
    from: `"${agentName.replace(/"/g, "")} via MCA Plan Finder" <${process.env.SMTP_USER}>`,
    to: to.join(", "),
    replyTo: sender.email,
    bcc: ccSelf ? sender.email : undefined,
    subject,
    text,
    html,
  });
}
