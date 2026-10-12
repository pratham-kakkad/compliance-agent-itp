/**
 * Types and small helpers for e-mailing people about their compliance with templates
 * (backend: app/compliance/messaging.py and mail_api.py).
 */
import { useCompliance } from "./ComplianceContext";

export type TemplateKind = "reminder" | "warning" | "final" | "request" | "thanks" | "custom";

export const KIND_ORDER: TemplateKind[] = ["reminder", "request", "warning", "final", "thanks", "custom"];

export const KIND_LABEL: Record<TemplateKind, string> = {
  reminder: "Reminder",
  warning: "Warning",
  final: "Final notice",
  request: "Request",
  thanks: "Thank you",
  custom: "Custom",
};

export interface EmailTemplate {
  id: string;
  key: string;
  name: string;
  description: string;
  kind: TemplateKind;
  subject: string;
  body: string;
  is_system: boolean;
  active: boolean;
  /** A built-in template that no longer matches its default. */
  modified: boolean;
  variables: string[];
  created_by: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface EmailVariable {
  group: string;
  name: string;
  label: string;
  description: string;
  example: string;
  token: string;
}

export interface VariablesResponse {
  variables: EmailVariable[];
  kinds: { key: TemplateKind; label: string }[];
}

/** Who a send reaches. Exactly one of emails / team_id / department_id / compliance_id / obligation_id. */
export interface RecipientSpec {
  emails?: string[];
  team_id?: string;
  department_id?: string;
  compliance_id?: string;
  /** with compliance_id: all | open | overdue | not_started | rejected */
  status?: string;
  /** with compliance_id: only these assignees */
  only?: string[];
  obligation_id?: string;
  exclude?: string[];
}

export interface SendOptions {
  cc_manager: boolean;
  copy_me: boolean;
  in_app: boolean;
}

export interface PreviewRecipient {
  email: string;
  name: string;
  title: string;
  department: string | null;
  cc: string[];
  item: { compliance: string; status: string; due_at: string | null; overdue: boolean } | null;
  open_count: number;
}

export interface SkippedRecipient {
  email: string;
  name: string;
  reason: string;
  label: string;
}

export interface MessagePreview {
  email: string;
  name: string;
  subject: string;
  text: string;
  html: string;
  cc: string[];
  unresolved: string[];
}

export interface EmailPreview {
  source: { type: string; id?: string; name?: string; status?: string; count?: number; selected?: number };
  kind: TemplateKind;
  template_id: string | null;
  template_name: string;
  will_send: number;
  skipped: number;
  skipped_counts: Record<string, number>;
  skipped_list: SkippedRecipient[];
  recipients: PreviewRecipient[];
  previews: MessagePreview[];
  unresolved: string[];
  notes: string[];
  limits: { max_recipients: number; rate_limit_per_hour: number; sent_last_hour: number; large_batch: number };
  over_cap: boolean;
  over_rate: boolean;
  needs_confirm: boolean;
  smtp_configured: boolean;
  sender_is_demo: boolean;
}

export type SendStatus = "queued" | "sent" | "failed" | "skipped";

export interface BatchRecipient {
  id: string;
  email: string;
  name: string;
  status: SendStatus;
  error: string | null;
  subject: string;
}

export interface BatchStatus {
  batch_id: string;
  status: "sending" | "done";
  total: number;
  counts: Record<SendStatus, number>;
  stopped: boolean;
  template_name: string;
  kind: TemplateKind;
  source: EmailPreview["source"] | null;
  created_at: string;
  recipients: BatchRecipient[];
}

export interface SentEmailRow {
  id: string;
  batch_id: string;
  created_at: string;
  sent_by: { email: string; name: string } | null;
  recipient: { email: string; name: string };
  template_name: string;
  kind: TemplateKind;
  subject: string;
  body: string;
  status: SendStatus;
  error: string | null;
  obligation_id: string | null;
  compliance_id: string | null;
  compliance: string | null;
  cc: string[];
}

/** The permissions that let someone e-mail people about compliance (the server checks each recipient's scope). */
export const SEND_PERMISSIONS: [string, string][] = [
  ["compliance", "assign"],
  ["compliance", "edit"],
  ["submission", "approve"],
  ["submission", "reject"],
];

export function useCanEmail(): boolean {
  const { canAny } = useCompliance();
  return canAny(SEND_PERMISSIONS);
}

/** Whether the person may read the sent-mail history (senders, template managers and auditors). */
export function useCanSeeEmailHistory(): boolean {
  const { canAny } = useCompliance();
  return canAny([...SEND_PERMISSIONS, ["compliance", "configure"], ["audit_log", "view"]]);
}

export const SKIP_REASON_TEXT: Record<string, string> = {
  outside_scope: "outside the people you can e-mail",
  duplicate: "listed more than once",
  inactive: "deactivated",
  demo: "demo accounts (they have no real mailbox)",
  no_email: "without an e-mail address",
  self: "you",
};
