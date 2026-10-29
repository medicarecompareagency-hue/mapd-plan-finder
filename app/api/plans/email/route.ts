import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { sendPlanSummaryEmail } from "@/lib/email";
import {
  PLAN_EMAIL_MAX_NOTE,
  PLAN_EMAIL_MAX_PLANS,
  PLAN_EMAIL_MAX_RECIPIENTS,
  type PlanEmailContext,
  type PlanEmailPlan,
  type PlanEmailRequest,
} from "@/lib/plan-email-types";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}
function strOrNull(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim() ? v.slice(0, max) : null;
}
function httpUrlOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

// POST /api/plans/email
// Body: PlanEmailRequest (see lib/plan-email-types.ts). The client builds the
// per-plan rows with the same formatters as the results table, so the email
// shows exactly what the agent saw (QMB $0 override, LIS tier copays, etc.).
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: Partial<PlanEmailRequest>;
  try {
    body = (await req.json()) as Partial<PlanEmailRequest>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const to = Array.isArray(body.to)
    ? body.to.map((e) => String(e).trim().toLowerCase()).filter(Boolean)
    : [];
  if (to.length === 0) {
    return NextResponse.json({ error: "Enter at least one recipient email address." }, { status: 400 });
  }
  if (to.length > PLAN_EMAIL_MAX_RECIPIENTS) {
    return NextResponse.json({ error: `Up to ${PLAN_EMAIL_MAX_RECIPIENTS} recipients per email.` }, { status: 400 });
  }
  const bad = to.find((e) => !EMAIL_RE.test(e));
  if (bad) {
    return NextResponse.json({ error: `"${bad}" is not a valid email address.` }, { status: 400 });
  }

  const rawPlans = Array.isArray(body.plans) ? body.plans : [];
  if (rawPlans.length === 0) {
    return NextResponse.json({ error: "No plans to send." }, { status: 400 });
  }
  if (rawPlans.length > PLAN_EMAIL_MAX_PLANS) {
    return NextResponse.json({ error: `Up to ${PLAN_EMAIL_MAX_PLANS} plans per email.` }, { status: 400 });
  }

  const plans: PlanEmailPlan[] = rawPlans.map((p, i) => {
    const sections = Array.isArray(p?.sections) ? p.sections.slice(0, 10) : [];
    return {
      rank: Number.isFinite(Number(p?.rank)) ? Number(p.rank) : i + 1,
      planName: str(p?.planName, 200) || "Plan",
      planId: str(p?.planId, 40),
      organizationName: str(p?.organizationName, 120),
      planType: str(p?.planType, 40),
      categoryLabel: strOrNull(p?.categoryLabel, 80),
      badges: Array.isArray(p?.badges) ? p.badges.map((b) => str(b, 80)).filter(Boolean).slice(0, 12) : [],
      sbPdfUrl: httpUrlOrNull(p?.sbPdfUrl),
      compareUrl: httpUrlOrNull(p?.compareUrl),
      sections: sections.map((s) => ({
        title: str(s?.title, 80),
        rows: (Array.isArray(s?.rows) ? s.rows : []).slice(0, 40).map((r) => ({
          label: str(r?.label, 80),
          value: str(r?.value, 300),
        })),
      })),
    };
  });

  const c = (body.context ?? {}) as Partial<PlanEmailContext>;
  const context: PlanEmailContext = {
    planYear: Number.isFinite(Number(c.planYear)) && c.planYear != null ? Number(c.planYear) : null,
    state: strOrNull(c.state, 40),
    county: strOrNull(c.county, 80),
    zip: strOrNull(c.zip, 10),
    categoryLabel: strOrNull(c.categoryLabel, 80),
    contractType: strOrNull(c.contractType, 40),
    carrier: strOrNull(c.carrier, 120),
    dualLevel: strOrNull(c.dualLevel, 20),
    lisLevel: strOrNull(c.lisLevel, 40),
  };

  try {
    await sendPlanSummaryEmail({
      to,
      ccSelf: body.ccSelf !== false,
      note: str(body.note, PLAN_EMAIL_MAX_NOTE),
      subject: strOrNull(body.subject, 160) ?? undefined,
      sender: { email: session.email, name: session.name },
      context,
      plans,
    });
  } catch (err) {
    console.error("[plans/email] send failed:", err);
    return NextResponse.json({ error: "Email could not be sent. Check SMTP settings." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, sent: to.length, plans: plans.length });
}
