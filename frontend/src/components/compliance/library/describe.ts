/**
 * Plain-language descriptions of a compliance's rules, shared by the library, the
 * detail page and the editor so every screen says the same thing.
 */
import {
  EVIDENCE_KIND_LABEL,
  PARTICIPATION_LABEL,
  type AudienceRule,
  type ComplianceDef,
  type EscalationAction,
  type EscalationRule,
  type EvidenceRequirement,
  type Lookup,
} from "../../../lib/compliance";

export const TRIGGER_LABEL: Record<string, string> = {
  before_due: "Before the deadline",
  on_due: "On the deadline",
  after_due: "After the deadline",
  rejected: "After a submission is sent back",
  review_pending: "While a submission waits for review",
};

export const ACTION_LABEL: Record<string, string> = {
  notify_assignee: "Remind the person",
  notify_manager: "Tell their manager",
  notify_manager_chain: "Tell their managers up the chain",
  notify_users: "Notify specific people",
  notify_reviewers: "Nudge the reviewers",
  mark_non_compliant: "Mark as non-compliant",
  flag_defaulter: "Flag as a defaulter",
};

export const REVIEW_MODE_HELP: Record<string, string> = {
  none: "People finish as soon as they submit. Best for simple confirmations.",
  manager: "Each person's line manager approves the proof or sends it back.",
  named: "One person you choose reviews every submission.",
  any_reviewer: "Anyone who is allowed to review submissions can pick it up.",
};

export const COMPLETION_HELP: Record<string, string> = {
  all: "The compliance is met once every person who must act has finished.",
  at_least_n: "The compliance is met once a set number of people have finished.",
  percentage: "The compliance is met once a set share of the people who must act have finished.",
  any: "The compliance is met as soon as one person has finished.",
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function lower(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "At least 3 people", "At least 60% of the people who must act". */
export function completionText(def: Pick<ComplianceDef, "completion_policy" | "completion_param">): string {
  const n = def.completion_param ?? 0;
  switch (def.completion_policy) {
    case "all":
      return "Everyone who must act has to finish";
    case "at_least_n":
      return `At least ${plural(n, "person", "people")}`;
    case "percentage":
      return `At least ${n}% of the people who must act`;
    case "any":
      return "Any one person";
    default:
      return def.completion_policy;
  }
}

/** Short review description for a table cell. */
export function reviewShort(def: Pick<ComplianceDef, "review_mode" | "reviewer">): string {
  switch (def.review_mode) {
    case "none":
      return "No review";
    case "manager":
      return "Manager";
    case "named":
      return def.reviewer ? def.reviewer.name : "Named reviewer";
    case "any_reviewer":
      return "Any reviewer";
    default:
      return def.review_mode;
  }
}

/** The constraint part of a requirement: "(.png, .jpg)", "(10 to 500 characters)", "(Yes / No)". */
export function constraintText(r: Pick<EvidenceRequirement, "kind" | "constraints">): string {
  const c = r.constraints ?? {};
  if (r.kind === "file" && c.extensions?.length) return c.extensions.join(", ");
  if (r.kind === "text") {
    if (c.min_length && c.max_length) return `${c.min_length} to ${c.max_length} characters`;
    if (c.min_length) return `at least ${plural(c.min_length, "character")}`;
    if (c.max_length) return `up to ${plural(c.max_length, "character")}`;
  }
  if (r.kind === "choice" && c.options?.length) return c.options.join(" / ");
  return "";
}

/** "Screenshot (.png, .jpg) — required". */
export function requirementSummary(r: EvidenceRequirement): string {
  const extra = constraintText(r);
  const what = r.label || EVIDENCE_KIND_LABEL[r.kind];
  return `${what}${extra ? ` (${extra})` : ""} — ${r.mandatory ? "required" : "optional"}`;
}

export function triggerText(t: { type: string; days: number }): string {
  const d = Number(t.days) || 0;
  switch (t.type) {
    case "before_due":
      return d === 0 ? "On the deadline" : `${plural(d, "day")} before the deadline`;
    case "on_due":
      return "On the deadline";
    case "after_due":
      return d === 0 ? "As soon as the deadline passes" : `${plural(d, "day")} after the deadline`;
    case "rejected":
      return d === 0 ? "As soon as a submission is sent back" : `${plural(d, "day")} after a submission is sent back`;
    case "review_pending":
      return d === 0 ? "As soon as a submission is waiting for review" : `When a submission has waited ${plural(d, "day")} for review`;
    default:
      return t.type;
  }
}

export function actionText(a: EscalationAction, names?: (email: string) => string): string {
  switch (a.type) {
    case "notify_assignee":
      return "remind the person";
    case "notify_manager":
      return "tell their manager";
    case "notify_manager_chain": {
      const n = a.levels ?? 2;
      return n === 1 ? "tell their manager" : `tell their managers up ${n} levels`;
    }
    case "notify_users": {
      const list = (a.emails ?? []).map((e) => (names ? names(e) : e));
      return list.length ? `notify ${list.join(", ")}` : "notify specific people";
    }
    case "notify_reviewers":
      return "nudge the reviewers";
    case "mark_non_compliant":
      return "mark them non-compliant";
    case "flag_defaulter":
      return "flag them as a defaulter";
    default:
      return a.type;
  }
}

function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** "3 days before the deadline: remind the person." */
export function ruleSentence(r: Pick<EscalationRule, "trigger" | "actions">, names?: (email: string) => string): string {
  const acts = r.actions.map((a) => actionText(a, names));
  return `${triggerText(r.trigger)}: ${acts.length ? joinAnd(acts) : "do nothing yet"}.`;
}

/** Name of what an audience rule points at, resolved through the lookup lists. */
export function audienceTarget(rule: Pick<AudienceRule, "selector_type" | "selector_ref">, lookup: Lookup | null): string {
  const ref = rule.selector_ref ?? "";
  switch (rule.selector_type) {
    case "all":
      return "The whole organization";
    case "person":
      return lookup?.users.find((u) => u.email === ref)?.name ?? ref;
    case "subtree": {
      const name = lookup?.users.find((u) => u.email === ref)?.name ?? ref;
      return `Everyone reporting to ${name}`;
    }
    case "team":
      return `Team: ${lookup?.teams.find((t) => t.id === ref)?.name ?? "unknown team"}`;
    case "department":
      return `Department: ${lookup?.departments.find((d) => d.id === ref)?.name ?? "unknown department"}`;
    case "role":
      return `Everyone with the role: ${lookup?.roles.find((r) => r.key === ref)?.name ?? ref}`;
    default:
      return ref;
  }
}

/** A whole audience rule in a sentence. */
export function audienceSentence(rule: AudienceRule, lookup: Lookup | null): string {
  const target = audienceTarget(rule, lookup);
  if (rule.effect === "exclude") return `Leave out: ${lower(target)}`;
  return `${target} (${lower(PARTICIPATION_LABEL[rule.participation])})`;
}

/** Why a person is in the audience: "team:ab12…" becomes "Team: Platform". */
export function viaText(via: string, lookup: Lookup | null): string {
  if (via === "all") return "Everyone";
  const i = via.indexOf(":");
  if (i < 0) return via;
  const type = via.slice(0, i) as AudienceRule["selector_type"];
  const ref = via.slice(i + 1);
  if (type === "person") return "Named directly";
  if (type === "subtree") return `Reports to ${lookup?.users.find((u) => u.email === ref)?.name ?? ref}`;
  if (type === "team") return `Team ${lookup?.teams.find((t) => t.id === ref)?.name ?? ""}`.trim();
  if (type === "department") return `Department ${lookup?.departments.find((d) => d.id === ref)?.name ?? ""}`.trim();
  if (type === "role") return `Role ${lookup?.roles.find((r) => r.key === ref)?.name ?? ref}`;
  return via;
}
