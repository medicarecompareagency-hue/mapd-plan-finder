// Shared shapes for the "Email these results" feature (2026-10-29).
// No runtime imports here so the client bundle can import these types
// without pulling in nodemailer.

export interface PlanEmailRow {
  label: string;
  value: string;
}

export interface PlanEmailSection {
  title: string;
  rows: PlanEmailRow[];
}

export interface PlanEmailPlan {
  rank: number;
  planName: string;
  planId: string;
  organizationName: string;
  planType: string;
  categoryLabel: string | null;
  // Short tags shown under the plan title ("$0 premium DSNP", chronic conditions…).
  badges: string[];
  sbPdfUrl: string | null;
  compareUrl: string | null;
  sections: PlanEmailSection[];
}

export interface PlanEmailContext {
  planYear: number | null;
  state: string | null;
  county: string | null;
  zip: string | null;
  categoryLabel: string | null;
  contractType: string | null;
  carrier: string | null;
  dualLevel: string | null;
  lisLevel: string | null;
}

export interface PlanEmailRequest {
  to: string[];
  ccSelf: boolean;
  note: string;
  subject?: string;
  context: PlanEmailContext;
  plans: PlanEmailPlan[];
}

export const PLAN_EMAIL_MAX_RECIPIENTS = 5;
export const PLAN_EMAIL_MAX_PLANS = 25;
export const PLAN_EMAIL_MAX_NOTE = 2000;
