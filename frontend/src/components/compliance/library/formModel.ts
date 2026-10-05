/**
 * The editor's form state, how it is built from / sent to the API, and the client-side checks
 * (they mirror app/compliance/engine.py; the server's message is always shown if it still refuses).
 */
import type {
  AudienceRule,
  ComplianceDef,
  CompletionPolicy,
  EscalationRule,
  EvidenceKind,
  EvidenceRequirement,
  Meta,
  Participation,
  Priority,
  ReviewMode,
  SelectorType,
} from "../../../lib/compliance";
import { isoToZonedInput, zonedInputToInstant, zonedInputToIso } from "./datetime";

export type SectionId = "basics" | "deadline" | "audience" | "proof" | "review" | "completion" | "escalation";

export const SECTIONS: { id: SectionId; label: string }[] = [
  { id: "basics", label: "Basics" },
  { id: "deadline", label: "Deadline" },
  { id: "audience", label: "Who it applies to" },
  { id: "proof", label: "What counts as proof" },
  { id: "review", label: "Review" },
  { id: "completion", label: "Completion rule" },
  { id: "escalation", label: "Reminders and escalation" },
];

let counter = 0;
export const uid = () => `u${++counter}`;

export interface EvDraft {
  uid: string;
  key: string;
  /** Once true the key no longer follows the label (existing keys must never change under saved submissions). */
  keyLocked: boolean;
  kind: EvidenceKind;
  label: string;
  mandatory: boolean;
  minLength: string;
  maxLength: string;
  extensions: string[];
  options: string[];
}

export interface ActionDraft {
  uid: string;
  type: string;
  emails: string[];
  levels: number;
}

export interface RuleDraft {
  uid: string;
  id: string;
  idLocked: boolean;
  name: string;
  trigger: string;
  days: string;
  actions: ActionDraft[];
}

export interface AudDraft {
  uid: string;
  selector_type: SelectorType;
  selector_ref: string;
  effect: "include" | "exclude";
  participation: Participation;
}

export interface FormState {
  name: string;
  description: string;
  category: string;
  type_key: string;
  action_text: string;
  priority: Priority;
  /** Wall-clock "YYYY-MM-DDTHH:mm" in the organization time zone, or "". */
  start_at: string;
  due_at: string;
  audience: AudDraft[];
  dynamic_audience: boolean;
  evidence: EvDraft[];
  review_mode: ReviewMode;
  reviewer_email: string;
  max_resubmissions: string;
  completion_policy: CompletionPolicy;
  completion_param: string;
  escalation: RuleDraft[];
}

const SLUG = /^[a-z0-9][a-z0-9_-]{0,40}$/;

/** "Screenshot of the repost" -> "screenshot-of-the-repost", made unique among `taken`. */
export function slugify(text: string, taken: Iterable<string>, fallback = "item"): string {
  const used = new Set(taken);
  let base = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36)
    .replace(/-+$/g, "");
  if (!base) base = fallback;
  let slug = base;
  for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
  return slug;
}

// ------------------------------------------------------------- conversions

export function evFromReq(r: EvidenceRequirement, locked: boolean): EvDraft {
  const c = r.constraints ?? {};
  return {
    uid: uid(),
    key: r.key,
    keyLocked: locked,
    kind: r.kind,
    label: r.label,
    mandatory: r.mandatory !== false,
    minLength: c.min_length != null ? String(c.min_length) : "",
    maxLength: c.max_length != null ? String(c.max_length) : "",
    extensions: [...(c.extensions ?? [])],
    options: [...(c.options ?? [])],
  };
}

export function ruleFromServer(r: EscalationRule, locked: boolean): RuleDraft {
  return {
    uid: uid(),
    id: r.id,
    idLocked: locked,
    name: r.name,
    trigger: r.trigger.type,
    days: String(r.trigger.days ?? 0),
    actions: r.actions.map((a) => ({ uid: uid(), type: a.type, emails: [...(a.emails ?? [])], levels: a.levels ?? 2 })),
  };
}

export function newAction(type = "notify_assignee"): ActionDraft {
  return { uid: uid(), type, emails: [], levels: 2 };
}

export function newAudienceRule(): AudDraft {
  return { uid: uid(), selector_type: "team", selector_ref: "", effect: "include", participation: "required" };
}

export function emptyForm(): FormState {
  return {
    name: "",
    description: "",
    category: "",
    type_key: "general",
    action_text: "",
    priority: "medium",
    start_at: "",
    due_at: "",
    audience: [],
    dynamic_audience: false,
    evidence: [],
    review_mode: "manager",
    reviewer_email: "",
    max_resubmissions: "3",
    completion_policy: "all",
    completion_param: "",
    escalation: [],
  };
}

/** Copies the type's default proof, review mode and reminder preset into the form. */
export function applyTypeDefaults(form: FormState, type: Meta["types"][number], presets: Meta["escalation_presets"]): FormState {
  const preset = presets.find((p) => p.key === type.escalation);
  return {
    ...form,
    type_key: type.key,
    evidence: type.evidence.map((r) => evFromReq(r, false)),
    review_mode: type.review_mode,
    reviewer_email: type.review_mode === "named" ? form.reviewer_email : "",
    escalation: (preset?.rules ?? []).map((r) => ruleFromServer(r, false)),
  };
}

export function formFromDef(def: ComplianceDef, tz: string): FormState {
  return {
    name: def.name,
    description: def.description ?? "",
    category: def.category ?? "",
    type_key: def.type_key,
    action_text: def.action_text ?? "",
    priority: def.priority,
    start_at: isoToZonedInput(def.start_at, tz),
    due_at: isoToZonedInput(def.due_at, tz),
    audience: (def.audience ?? []).map((a) => ({
      uid: uid(),
      selector_type: a.selector_type,
      selector_ref: a.selector_ref ?? "",
      effect: a.effect,
      participation: a.participation,
    })),
    dynamic_audience: def.dynamic_audience,
    evidence: (def.evidence_requirements ?? []).map((r) => evFromReq(r, true)),
    review_mode: def.review_mode,
    reviewer_email: def.reviewer?.email ?? "",
    max_resubmissions: String(def.max_resubmissions),
    completion_policy: def.completion_policy,
    completion_param: def.completion_param != null ? String(def.completion_param) : "",
    escalation: (def.escalation_rules ?? []).map((r) => ruleFromServer(r, true)),
  };
}

export function evidencePayload(items: EvDraft[]): EvidenceRequirement[] {
  return items.map((e) => {
    const constraints: NonNullable<EvidenceRequirement["constraints"]> = {};
    if (e.kind === "text") {
      if (e.minLength.trim() !== "") constraints.min_length = Number(e.minLength);
      if (e.maxLength.trim() !== "") constraints.max_length = Number(e.maxLength);
    } else if (e.kind === "file") {
      if (e.extensions.length) constraints.extensions = e.extensions;
    } else if (e.kind === "choice") {
      constraints.options = e.options.map((o) => o.trim()).filter(Boolean);
    }
    return { key: e.key.trim(), kind: e.kind, label: e.label.trim(), mandatory: e.mandatory, constraints };
  });
}

export function escalationPayload(rules: RuleDraft[]): EscalationRule[] {
  return rules.map((r) => ({
    id: r.id.trim(),
    name: r.name.trim() || r.id.trim(),
    trigger: { type: r.trigger, days: r.trigger === "on_due" ? 0 : Number(r.days || 0) },
    actions: r.actions.map((a) => {
      if (a.type === "notify_users") return { type: a.type, emails: a.emails };
      if (a.type === "notify_manager_chain") return { type: a.type, levels: a.levels };
      return { type: a.type };
    }),
  }));
}

export function audiencePayload(rules: AudDraft[]): AudienceRule[] {
  return rules.map((r) => ({
    selector_type: r.selector_type,
    selector_ref: r.selector_type === "all" ? null : r.selector_ref || null,
    effect: r.effect,
    participation: r.effect === "exclude" ? "required" : r.participation,
  }));
}

/** The body for POST/PATCH /compliance/definitions. */
export function toPayload(f: FormState, tz: string): Record<string, unknown> {
  return {
    name: f.name.trim(),
    description: f.description.trim(),
    category: f.category.trim(),
    type_key: f.type_key,
    action_text: f.action_text.trim(),
    priority: f.priority,
    start_at: zonedInputToIso(f.start_at, tz),
    due_at: zonedInputToIso(f.due_at, tz),
    completion_policy: f.completion_policy,
    completion_param: f.completion_policy === "at_least_n" || f.completion_policy === "percentage" ? Number(f.completion_param) || null : null,
    review_mode: f.review_mode,
    reviewer_email: f.review_mode === "named" ? f.reviewer_email || null : null,
    max_resubmissions: Number(f.max_resubmissions || 0),
    dynamic_audience: f.dynamic_audience,
    evidence_requirements: evidencePayload(f.evidence),
    escalation_rules: escalationPayload(f.escalation),
    audience: audiencePayload(f.audience),
  };
}

/** Key-order independent JSON, for comparing payloads. */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** The fields of `now` that differ from `before` (PATCH only sends what changed). */
export function changedFields(now: Record<string, unknown>, before: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(now)) if (stable(now[k]) !== stable(before[k])) out[k] = now[k];
  return out;
}

/** Has the person changed the type's proof / review / reminders from that type's defaults? */
export function differsFromType(f: FormState, type: Meta["types"][number] | undefined, presets: Meta["escalation_presets"]): boolean {
  if (!type) return f.evidence.length > 0 || f.escalation.length > 0;
  const want = evidencePayload(type.evidence.map((r) => evFromReq(r, false)));
  const preset = presets.find((p) => p.key === type.escalation);
  const wantRules = escalationPayload((preset?.rules ?? []).map((r) => ruleFromServer(r, false)));
  return (
    stable(evidencePayload(f.evidence)) !== stable(want) ||
    stable(escalationPayload(f.escalation)) !== stable(wantRules) ||
    f.review_mode !== type.review_mode
  );
}

// -------------------------------------------------------------- validation

export interface Issue {
  section: SectionId;
  /** "save" blocks every save; "publish" only blocks publishing a draft. */
  level: "save" | "publish";
  message: string;
  /** Which control it belongs to, for inline display. */
  field?: string;
}

export function validate(f: FormState, tz: string): Issue[] {
  const out: Issue[] = [];
  const add = (section: SectionId, message: string, field?: string, level: Issue["level"] = "save") => out.push({ section, level, message, field });

  if (!f.name.trim()) add("basics", "Give it a name", "name");

  const start = f.start_at ? zonedInputToInstant(f.start_at, tz) : null;
  const due = f.due_at ? zonedInputToInstant(f.due_at, tz) : null;
  if (start && due && due.at < start.at) add("deadline", "The deadline is before the start date", "due_at");

  f.audience.forEach((r, i) => {
    if (r.selector_type !== "all" && !r.selector_ref) add("audience", "Choose who this rule applies to", `aud-${r.uid}`);
    void i;
  });
  if (!f.audience.some((r) => r.effect === "include")) add("audience", "Choose who this applies to before publishing: add at least one rule that includes people", "audience", "publish");

  const keys = new Map<string, number>();
  f.evidence.forEach((e) => keys.set(e.key.trim(), (keys.get(e.key.trim()) ?? 0) + 1));
  f.evidence.forEach((e) => {
    const f1 = (m: string, field = `ev-${e.uid}`) => add("proof", m, field);
    if (!e.label.trim()) f1("Give this item a label so people know what to provide", `ev-label-${e.uid}`);
    if (!SLUG.test(e.key.trim())) f1("The key must be lowercase letters, digits, - or _", `ev-key-${e.uid}`);
    else if ((keys.get(e.key.trim()) ?? 0) > 1) f1("Another item already uses this key", `ev-key-${e.uid}`);
    if (e.kind === "choice" && e.options.map((o) => o.trim()).filter(Boolean).length < 2) f1("A choice needs at least two options", `ev-options-${e.uid}`);
    if (e.kind === "text") {
      const mn = e.minLength.trim() === "" ? null : Number(e.minLength);
      const mx = e.maxLength.trim() === "" ? null : Number(e.maxLength);
      if ((mn != null && (!Number.isInteger(mn) || mn < 0)) || (mx != null && (!Number.isInteger(mx) || mx < 1))) f1("Lengths must be whole numbers", `ev-len-${e.uid}`);
      else if (mn != null && mx != null && mn > mx) f1("The minimum can't be more than the maximum", `ev-len-${e.uid}`);
    }
  });

  if (f.review_mode === "named" && !f.reviewer_email) add("review", "Choose who reviews submissions", "reviewer");
  const mr = Number(f.max_resubmissions);
  if (f.max_resubmissions.trim() === "" || !Number.isInteger(mr) || mr < 0 || mr > 20) add("review", "Resubmissions must be a whole number from 0 to 20", "max_resubmissions");

  if (f.completion_policy === "at_least_n" || f.completion_policy === "percentage") {
    const n = Number(f.completion_param);
    if (!f.completion_param.trim() || !Number.isInteger(n) || n < 1) add("completion", f.completion_policy === "percentage" ? "Enter what percentage must complete it" : "Enter how many people must complete it", "completion_param");
    else if (f.completion_policy === "percentage" && n > 100) add("completion", "A percentage can't be more than 100", "completion_param");
  }

  const ids = new Map<string, number>();
  f.escalation.forEach((r) => ids.set(r.id.trim(), (ids.get(r.id.trim()) ?? 0) + 1));
  f.escalation.forEach((r) => {
    const e = (m: string, field: string) => add("escalation", m, field);
    if (!r.name.trim()) e("Give this rule a name", `esc-name-${r.uid}`);
    if (!SLUG.test(r.id.trim())) e("The rule id must be lowercase letters, digits, - or _", `esc-id-${r.uid}`);
    else if ((ids.get(r.id.trim()) ?? 0) > 1) e("Another rule already uses this id", `esc-id-${r.uid}`);
    const d = Number(r.days);
    if (r.trigger !== "on_due" && (r.days.trim() === "" || !Number.isInteger(d) || d < 0 || d > 365)) e("Days must be a whole number from 0 to 365", `esc-days-${r.uid}`);
    if (r.actions.length === 0) e("Add at least one action", `esc-actions-${r.uid}`);
    r.actions.forEach((a) => {
      if (a.type === "notify_users" && a.emails.length === 0) e("Choose at least one person to notify", `esc-act-${a.uid}`);
    });
  });
  return out;
}
