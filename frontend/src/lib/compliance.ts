/**
 * Types and helpers for the compliance engine API (backend: app/compliance/).
 * Every shape here mirrors app/compliance/serializers.py; the API's own docs are
 * at /docs. Dates are ISO strings; show them with fmtDate / fmtDateTime
 * (lib/format.ts), which use the organization time zone.
 */

export type Priority = "low" | "medium" | "high" | "critical";
export type DefinitionStatus = "draft" | "published" | "paused" | "closed" | "archived";
export type ObligationStatus =
  | "not_started"
  | "in_progress"
  | "submitted"
  | "under_review"
  | "rejected"
  | "completed"
  | "waived"
  | "cancelled";
export type Participation = "required" | "optional" | "informational";
export type CompletionPolicy = "all" | "at_least_n" | "percentage" | "any";
export type ReviewMode = "none" | "manager" | "named" | "any_reviewer";
export type EvidenceKind = "text" | "file" | "url" | "attestation" | "choice";
export type SelectorType = "person" | "team" | "department" | "role" | "subtree" | "all";
export type Scope = "self" | "created_by_me" | "direct_reports" | "team" | "subtree" | "department" | "org";

export interface Person {
  email: string;
  name: string;
  title: string;
  department: string | null;
}

export interface EvidenceRequirement {
  key: string;
  kind: EvidenceKind;
  label: string;
  mandatory: boolean;
  /** text: min_length / max_length; file: extensions (e.g. [".png"]); choice: options. */
  constraints?: { min_length?: number; max_length?: number; extensions?: string[]; options?: string[] };
}

export interface EscalationAction {
  type: string;
  emails?: string[];
  levels?: number;
}
export interface EscalationRule {
  id: string;
  name: string;
  trigger: { type: string; days: number };
  actions: EscalationAction[];
}

export interface AudienceRule {
  selector_type: SelectorType;
  selector_ref: string | null;
  effect: "include" | "exclude";
  participation: Participation;
}

export interface Progress {
  required_total: number;
  completed: number;
  percent: number;
  satisfied: boolean;
  by_status: Record<string, number>;
}

export interface ComplianceDef {
  id: string;
  name: string;
  description: string;
  category: string;
  type_key: string;
  action_text: string;
  priority: Priority;
  status: DefinitionStatus;
  start_at: string | null;
  due_at: string | null;
  completion_policy: CompletionPolicy;
  completion_param: number | null;
  review_mode: ReviewMode;
  reviewer: Person | null;
  max_resubmissions: number;
  dynamic_audience: boolean;
  current_version: number;
  created_by: Person | null;
  created_at: string;
  published_at: string | null;
  progress: Progress;
  can?: { edit: boolean; delete: boolean; assign: boolean; configure: boolean };
  // detail only
  evidence_requirements?: EvidenceRequirement[];
  escalation_rules?: EscalationRule[];
  audience?: AudienceRule[];
}

export interface EvidenceFile {
  id: string;
  name: string;
  size: number;
  mime: string;
  scan_status: string;
  same_file_used_by_others: number;
}

export interface EvidenceItem {
  key: string;
  kind: EvidenceKind;
  text: string | null;
  checked: boolean | null;
  file: EvidenceFile | null;
}

export interface ReviewDecision {
  decision: "approved" | "rejected";
  reason: string;
  reviewer: Person | null;
  decided_at: string;
}

export interface Submission {
  id: string;
  version: number;
  status: "submitted" | "under_review" | "approved" | "rejected";
  late: boolean;
  submitted_by: Person | null;
  submitted_at: string;
  items: EvidenceItem[];
  decisions: ReviewDecision[];
}

export interface Obligation {
  id: string;
  compliance: { id: string; name: string; category: string; type_key: string; priority: Priority; action_text: string; status: DefinitionStatus };
  user: Person | null;
  participation: Participation;
  status: ObligationStatus;
  due_at: string | null;
  due_overridden: boolean;
  overdue: boolean;
  non_compliant: boolean;
  non_compliant_at: string | null;
  defaulter_flag: boolean;
  resubmissions: number;
  submitted_at: string | null;
  completed_at: string | null;
  status_reason: string | null;
  version: number;
  can: { start: boolean; submit: boolean; review: boolean; waive: boolean; extend: boolean; reopen: boolean };
  // detail only
  assigned_via?: string[];
  instructions?: {
    description: string;
    action_text: string;
    review_mode: ReviewMode;
    evidence_requirements: EvidenceRequirement[];
    max_resubmissions: number;
  };
  submissions?: Submission[];
}

export interface Page<T> {
  total: number;
  items: T[];
}

export interface Me {
  user: Person | null;
  roles: { key: string; name: string }[];
  is_super: boolean;
  /** resource -> action -> scopes */
  permissions: Record<string, Record<string, string[]>>;
  unread_notifications: number;
}

export interface Meta {
  types: { key: string; name: string; description: string; evidence: EvidenceRequirement[]; review_mode: ReviewMode; escalation: string; verifier_key: string | null }[];
  priorities: Priority[];
  definition_statuses: DefinitionStatus[];
  obligation_statuses: ObligationStatus[];
  participation: Participation[];
  completion_policies: CompletionPolicy[];
  review_modes: ReviewMode[];
  selector_types: SelectorType[];
  evidence_kinds: EvidenceKind[];
  triggers: string[];
  actions: string[];
  scopes: { key: Scope; label: string }[];
  resources: { key: string; label: string; actions: string[]; navigation_only: boolean }[];
  escalation_presets: { key: string; label: string; rules: EscalationRule[] }[];
}

export interface Lookup {
  users: { email: string; name: string; title: string; manager_email: string | null; department_id: string | null; department: string | null }[];
  teams: { id: string; name: string; members: number }[];
  departments: { id: string; name: string }[];
  roles: { key: string; name: string }[];
}

export interface AudiencePreview {
  total: number;
  by_participation: Record<string, number>;
  outside_scope: number;
  people: (Person & { participation: Participation; via: string[]; in_scope: boolean })[];
}

export interface NotificationItem {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  created_at: string;
  read: boolean;
}

export interface Breakdown {
  name: string;
  total: number;
  completed: number;
  overdue: number;
  percent: number;
}

export interface DashboardData {
  kpis: {
    total_compliances: number;
    active_compliances: number;
    obligations: number;
    completed: number;
    pending: number;
    in_review: number;
    overdue: number;
    non_compliant: number;
    non_compliant_users: number;
    compliance_percent: number;
  };
  compliances_by_status: Record<string, number>;
  by_department: Breakdown[];
  by_team: Breakdown[];
  by_category: Breakdown[];
  trend: { date: string; completed: number }[];
  upcoming: { obligation_id: string; compliance: string; user: { email: string; name: string }; due_at: string; status: ObligationStatus }[];
  attention: { email: string; name: string; overdue: number; non_compliant: number }[];
  escalations: { obligation_id: string; compliance: string; user: string; action: string; rule: string; fired_at: string }[];
  review_queue: Page<Obligation>;
}

export interface ScoreboardEntry {
  rank: number;
  email: string;
  name: string;
  department: string | null;
  score: number;
  incidents: number;
  non_compliant: number;
  overdue: number;
  late: number;
  repeat_offender: boolean;
  items: { obligation_id: string; compliance: string; priority: Priority; status: ObligationStatus }[];
}

// ---------------------------------------------------------------- admin

export interface AdminUser {
  email: string;
  name: string;
  title: string;
  manager_email: string | null;
  department_id: string | null;
  department: string | null;
  is_active: boolean;
  is_demo: boolean;
  roles: { key: string; name: string }[];
}
export interface AdminUserDetail extends AdminUser {
  overrides: { resource: string; action: string; effect: "allow" | "deny"; scope: string | null }[];
  teams: { id: string; name: string }[];
  history: { counts: Record<string, number>; items: Obligation[] };
}
export interface AdminRole {
  id: string;
  key: string;
  name: string;
  description: string;
  is_system: boolean;
  is_super: boolean;
  auto_assign: "all" | "managers" | null;
  members: number;
  grants: { resource: string; action: string; scope: string }[];
}
export interface AdminTeam {
  id: string;
  name: string;
  department_id: string | null;
  lead_email: string | null;
  members: string[];
}
export interface AdminDepartment {
  id: string;
  name: string;
  members: number;
}
export interface RecordRule {
  id: string;
  name: string;
  resource: "compliance" | "obligation";
  kind: "allow" | "restrictive";
  role_key: string | null;
  role_name: string;
  condition: Record<string, unknown>;
  active: boolean;
}
export interface AuditEventRow {
  id: number;
  at: string;
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before: unknown;
  after: unknown;
  meta: unknown;
}

// -------------------------------------------------------------- display

export const STATUS_LABEL: Record<ObligationStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  submitted: "Submitted",
  under_review: "Under review",
  rejected: "Changes needed",
  completed: "Completed",
  waived: "Waived",
  cancelled: "Cancelled",
};

export const DEFINITION_STATUS_LABEL: Record<DefinitionStatus, string> = {
  draft: "Draft",
  published: "Active",
  paused: "Paused",
  closed: "Closed",
  archived: "Archived",
};

export const PARTICIPATION_LABEL: Record<Participation, string> = {
  required: "Must act",
  optional: "Optional",
  informational: "For information",
};

export const PRIORITY_LABEL: Record<Priority, string> = { low: "Low", medium: "Medium", high: "High", critical: "Critical" };

export const REVIEW_MODE_LABEL: Record<ReviewMode, string> = {
  none: "No review (completes on submit)",
  manager: "The person's manager",
  named: "A named reviewer",
  any_reviewer: "Anyone allowed to review",
};

export const COMPLETION_LABEL: Record<CompletionPolicy, string> = {
  all: "Everyone who must act",
  at_least_n: "At least N people",
  percentage: "A percentage of people",
  any: "Any one person",
};

export const SELECTOR_LABEL: Record<SelectorType, string> = {
  person: "A person",
  team: "A team",
  department: "A department",
  role: "Everyone with a role",
  subtree: "Everyone reporting to…",
  all: "The whole organization",
};

export const EVIDENCE_KIND_LABEL: Record<EvidenceKind, string> = {
  text: "Written description",
  file: "File attachment",
  url: "Link",
  attestation: "Confirmation tick-box",
  choice: "Pick one option",
};
