/**
 * Small pieces every compliance page shares: status / priority labels, person and
 * due-date cells, a labelled form field, a textarea and the "give a reason" dialog.
 */
import { useId, useState } from "react";
import clsx from "clsx";
import { toast } from "sonner";
import { fmtDate } from "../../lib/format";
import {
  DEFINITION_STATUS_LABEL,
  PARTICIPATION_LABEL,
  PRIORITY_LABEL,
  STATUS_LABEL,
  type ComplianceDef,
  type DefinitionStatus,
  type Obligation,
  type ObligationStatus,
  type Participation,
  type Person,
  type Priority,
  type Progress,
} from "../../lib/compliance";
import { Avatar, Button, Label, ProgressBar, type Tone } from "../ui";
import { useOverlay } from "../Modal";

/** The message to show for anything thrown by the API client. */
export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function toastError(title: string, e: unknown) {
  toast.error(title, { description: errText(e) });
}

// ------------------------------------------------------------------ labels

const STATUS_TONE: Record<ObligationStatus, Tone> = {
  not_started: "neutral",
  in_progress: "accent",
  submitted: "accent",
  under_review: "accent",
  rejected: "warn",
  completed: "good",
  waived: "neutral",
  cancelled: "neutral",
};

/** Obligation status; an overdue or non-compliant item shows that instead of its workflow state. */
export function ObligationStatusLabel({ o, size = "md" }: { o: Pick<Obligation, "status" | "overdue" | "non_compliant">; size?: "sm" | "md" }) {
  if (o.non_compliant && !["completed", "waived", "cancelled"].includes(o.status)) {
    return <Label tone="crit" variant="solid" size={size} dot>Non-compliant</Label>;
  }
  if (o.overdue) return <Label tone="crit" size={size} dot>Overdue</Label>;
  return <Label tone={STATUS_TONE[o.status]} size={size} dot>{STATUS_LABEL[o.status]}</Label>;
}

const DEF_TONE: Record<DefinitionStatus, Tone> = { draft: "neutral", published: "good", paused: "warn", closed: "neutral", archived: "neutral" };
export function DefinitionStatusLabel({ status, size = "md" }: { status: DefinitionStatus; size?: "sm" | "md" }) {
  return <Label tone={DEF_TONE[status]} size={size} dot>{DEFINITION_STATUS_LABEL[status]}</Label>;
}

const PRIORITY_TONE: Record<Priority, Tone> = { low: "neutral", medium: "accent", high: "warn", critical: "crit" };
export function PriorityLabel({ priority, size = "sm" }: { priority: Priority; size?: "sm" | "md" }) {
  return <Label tone={PRIORITY_TONE[priority]} variant="outline" size={size}>{PRIORITY_LABEL[priority]}</Label>;
}

export function ParticipationLabel({ participation, size = "sm" }: { participation: Participation; size?: "sm" | "md" }) {
  const tone: Tone = participation === "required" ? "accent" : "neutral";
  return <Label tone={tone} variant={participation === "required" ? "subtle" : "outline"} size={size}>{PARTICIPATION_LABEL[participation]}</Label>;
}

// ------------------------------------------------------------------- cells

export function PersonCell({ person, size = 24, showTitle = false }: { person: Person | null | undefined; size?: number; showTitle?: boolean }) {
  if (!person) return <span className="text-ink3">—</span>;
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <Avatar name={person.name} size={size} />
      <div className="min-w-0">
        <div className="font-semibold text-ink truncate">{person.name}</div>
        {showTitle && <div className="text-xs text-ink2 truncate">{[person.title, person.department].filter(Boolean).join(" · ")}</div>}
      </div>
    </div>
  );
}

/** "Due 12 Oct · in 3 days" / "Due 2 Oct · 4 days late". Finished items just show the date. */
export function DueLabel({ iso, finished, className }: { iso: string | null; finished?: boolean; className?: string }) {
  if (!iso) return <span className={clsx("text-ink3", className)}>No deadline</span>;
  const days = Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
  let rel = "";
  let tone = "text-ink2";
  if (!finished) {
    if (days < 0) {
      rel = ` · ${-days} day${days === -1 ? "" : "s"} late`;
      tone = "text-crit font-semibold";
    } else if (days === 0) {
      rel = " · today";
      tone = "text-warn font-semibold";
    } else if (days <= 3) {
      rel = ` · in ${days} day${days === 1 ? "" : "s"}`;
      tone = "text-warn";
    } else {
      rel = ` · in ${days} days`;
    }
  }
  return <span className={clsx("text-[13px] tabular", tone, className)}>{fmtDate(iso)}{rel}</span>;
}

export function ProgressCell({ progress, def }: { progress: Progress; def?: Pick<ComplianceDef, "completion_policy"> }) {
  void def;
  if (progress.required_total === 0) return <span className="text-ink3 text-[13px]">Nobody yet</span>;
  return (
    <div className="flex items-center gap-2.5 min-w-[130px]">
      <ProgressBar value={progress.percent} tone={progress.satisfied ? "good" : "accent"} className="flex-1" />
      <span className="w-[74px] text-right text-[13px] tabular text-ink2">
        {progress.completed}/{progress.required_total}
      </span>
    </div>
  );
}

// ------------------------------------------------------------------- forms

/** Label + control + hint/error, wired for accessibility (the control gets `id`). */
export function Field({
  label,
  hint,
  error,
  required,
  children,
  className,
}: {
  label: string;
  hint?: React.ReactNode;
  error?: string | null;
  required?: boolean;
  children: (id: string) => React.ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={clsx("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-[13px] font-semibold text-ink">
        {label}
        {required && <span className="text-crit" aria-hidden> *</span>}
      </label>
      {children(id)}
      {error ? <p className="text-xs text-crit">{error}</p> : hint ? <p className="text-xs text-ink2">{hint}</p> : null}
    </div>
  );
}

export function Textarea({ className, invalid, rows = 4, ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return <textarea rows={rows} aria-invalid={invalid || undefined} className={clsx("field px-3 py-2 text-sm leading-5 resize-y", className)} {...rest} />;
}

// -------------------------------------------------------- reason dialog

function ReasonDialog({
  title,
  description,
  label,
  confirm,
  required,
  tone,
  onSubmit,
}: {
  title: string;
  description?: string;
  label: string;
  confirm: string;
  required: boolean;
  tone: "primary" | "danger";
  onSubmit: (reason: string) => Promise<unknown>;
}) {
  const { close } = useOverlay();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const missing = required && !reason.trim();

  async function go() {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(reason.trim());
      close();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!missing) void go();
      }}
      className="flex flex-col gap-4 pr-6"
    >
      <div>
        <h2 className="text-lg font-semibold text-ink">{title}</h2>
        {description && <p className="text-sm text-ink2 mt-1">{description}</p>}
      </div>
      <Field label={label} required={required} error={error}>
        {(id) => <Textarea id={id} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} rows={4} invalid={Boolean(error)} />}
      </Field>
      <div className="flex justify-end gap-2">
        <Button type="button" onClick={close} disabled={busy}>Cancel</Button>
        <Button type="submit" variant={tone === "danger" ? "danger" : "primary"} loading={busy} disabled={missing}>{confirm}</Button>
      </div>
    </form>
  );
}

/**
 * Opens a dialog asking for a reason, then runs `onSubmit(reason)`. The dialog stays open (showing the
 * server's message) if it fails and closes if it succeeds.
 */
export function useReasonPrompt() {
  const { openModal } = useOverlay();
  return (opts: {
    title: string;
    description?: string;
    label?: string;
    confirm: string;
    required?: boolean;
    tone?: "primary" | "danger";
    onSubmit: (reason: string) => Promise<unknown>;
  }) =>
    openModal(
      <ReasonDialog
        title={opts.title}
        description={opts.description}
        label={opts.label ?? "Reason"}
        confirm={opts.confirm}
        required={opts.required ?? true}
        tone={opts.tone ?? "primary"}
        onSubmit={opts.onSubmit}
      />
    );
}
