import { useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import clsx from "clsx";
import { toast } from "sonner";
import { AlertTriangle, CalendarClock, Check, FileUp, Info, MessageSquareWarning, Play, RotateCcw, Send, ShieldOff, Upload, X } from "lucide-react";
import { api, uploadFile } from "../../lib/api";
import { useApi } from "../../lib/useApi";
import { browserTimeZone, fmtBytes, fmtDate, fmtDateTime } from "../../lib/format";
import { useCompliance } from "../../lib/ComplianceContext";
import {
  REVIEW_MODE_LABEL,
  type EvidenceRequirement,
  type Obligation,
  type Submission,
} from "../../lib/compliance";
import {
  Banner,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  Label,
  PageHeader,
  Select,
  Skeleton,
  TextInput,
  type Tone,
} from "../../components/ui";
import { useOverlay } from "../../components/Modal";
import {
  DueLabel,
  Field,
  ObligationStatusLabel,
  ParticipationLabel,
  PersonCell,
  PriorityLabel,
  Textarea,
  errText,
  toastError,
  useReasonPrompt,
} from "../../components/compliance/common";
import { DecisionLine, EvidenceList, latestSubmission, useReviewActions } from "../../components/compliance/evidence";
import { EmailButton } from "../../components/compliance/email/EmailButton";
import { CommunicationHistory } from "../../components/compliance/email/CommunicationHistory";

const MAX_FILE_MB = 10;
const DEFAULT_MAX_TEXT = 5000;

// ------------------------------------------------------------------ form model

interface UploadedFile {
  id: string;
  name: string;
  size: number;
  mime: string;
}

interface Value {
  text: string;
  checked: boolean;
  file: UploadedFile | null;
}

const EMPTY_VALUE: Value = { text: "", checked: false, file: null };

const isMandatory = (r: EvidenceRequirement) => r.mandatory !== false;
const extensionsOf = (r: EvidenceRequirement) => (r.constraints?.extensions ?? []).map((e) => e.toLowerCase());

function isEmpty(r: EvidenceRequirement, v: Value): boolean {
  switch (r.kind) {
    case "attestation":
      return !v.checked;
    case "file":
      return !v.file;
    default:
      return !v.text.trim();
  }
}

/** A problem with what's been entered so far (never reported for an empty field: "required" is handled separately). */
function problemWith(r: EvidenceRequirement, v: Value): string | null {
  const c = r.constraints ?? {};
  if (isEmpty(r, v)) return null;
  if (r.kind === "text") {
    const n = v.text.trim().length;
    const min = c.min_length ?? 0;
    const max = c.max_length ?? DEFAULT_MAX_TEXT;
    if (n < min) return `Write at least ${min} characters (${n} so far).`;
    if (n > max) return `Keep it under ${max} characters (${n} now).`;
  }
  if (r.kind === "url" && !/^https?:\/\/\S+$/i.test(v.text.trim())) {
    return "Enter a full web address starting with http:// or https://";
  }
  if (r.kind === "choice" && c.options && !c.options.includes(v.text.trim())) return "Pick one of the listed options.";
  if (r.kind === "file" && v.file) {
    const allowed = extensionsOf(r);
    if (allowed.length && !allowed.some((e) => v.file!.name.toLowerCase().endsWith(e))) return `Allowed file types: ${allowed.join(", ")}`;
  }
  return null;
}

function initialValues(reqs: EvidenceRequirement[], previous: Submission | null): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const r of reqs) {
    out[r.key] = { ...EMPTY_VALUE };
    // After "changes needed", start from what was sent last time. Files are not reused: each upload is single-use.
    const prev = previous?.items.find((i) => i.key === r.key);
    if (prev && r.kind !== "file") {
      out[r.key] = { text: prev.text ?? "", checked: Boolean(prev.checked), file: null };
    }
  }
  return out;
}

// ------------------------------------------------------------ requirement inputs

function FileInput({
  req,
  value,
  onChange,
  invalid,
}: {
  req: EvidenceRequirement;
  value: UploadedFile | null;
  onChange: (f: UploadedFile | null) => void;
  invalid: string | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const allowed = extensionsOf(req);
  const hint = `${allowed.length ? `Allowed: ${allowed.join(", ")}. ` : ""}Up to ${MAX_FILE_MB} MB.`;

  async function pick(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
      setError(`That file is ${fmtBytes(file.size)}. The limit is ${MAX_FILE_MB} MB.`);
      return;
    }
    if (allowed.length && !allowed.some((e) => file.name.toLowerCase().endsWith(e))) {
      setError(`This file type isn't accepted here. Allowed: ${allowed.join(", ")}`);
      return;
    }
    setUploading(true);
    try {
      const up = await uploadFile<UploadedFile>("/compliance/evidence", file);
      onChange({ id: up.id, name: up.name, size: up.size, mime: up.mime });
    } catch (e) {
      setError(errText(e));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  const shownError = error ?? invalid;
  return (
    <Field label={req.label} required={isMandatory(req)} hint={hint} error={shownError}>
      {(id) => (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void pick(e.dataTransfer.files?.[0]);
          }}
          className={clsx(
            "rounded-md border border-dashed px-3 py-3 flex flex-wrap items-center gap-3 transition-colors",
            dragging ? "border-accent bg-accent-soft" : "border-line bg-panel2"
          )}
        >
          <input
            ref={inputRef}
            id={id}
            type="file"
            className="sr-only"
            accept={allowed.join(",") || undefined}
            onChange={(e) => void pick(e.target.files?.[0])}
            tabIndex={-1}
          />
          {value ? (
            <>
              <FileUp size={18} className="text-ink2 flex-none" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-ink truncate">{value.name}</div>
                <div className="text-xs text-ink2 tabular">{fmtBytes(value.size)} · uploaded</div>
              </div>
              <Button size="sm" leadingIcon={X} onClick={() => onChange(null)} aria-label={`Remove ${value.name}`}>
                Remove
              </Button>
            </>
          ) : (
            <>
              <Upload size={18} className="text-ink2 flex-none" aria-hidden />
              <span className="text-sm text-ink2 flex-1 min-w-[10rem]">{uploading ? "Uploading…" : "Drop a file here or choose one"}</span>
              <Button size="sm" loading={uploading} onClick={() => inputRef.current?.click()} aria-describedby={id}>
                Choose file
              </Button>
            </>
          )}
        </div>
      )}
    </Field>
  );
}

function RequirementInput({
  req,
  value,
  onChange,
  touched,
}: {
  req: EvidenceRequirement;
  value: Value;
  onChange: (patch: Partial<Value>) => void;
  touched: boolean;
}) {
  const c = req.constraints ?? {};
  const problem = problemWith(req, value);
  const required = isMandatory(req);

  switch (req.kind) {
    case "text": {
      const max = c.max_length ?? DEFAULT_MAX_TEXT;
      const min = c.min_length ?? 0;
      return (
        <Field
          label={req.label}
          required={required}
          error={problem}
          hint={`${min ? `At least ${min} characters. ` : ""}${value.text.trim().length}/${max}`}
        >
          {(id) => (
            <Textarea id={id} value={value.text} onChange={(e) => onChange({ text: e.target.value })} invalid={Boolean(problem)} rows={5} aria-required={required} />
          )}
        </Field>
      );
    }
    case "url":
      return (
        <Field label={req.label} required={required} error={problem}>
          {(id) => (
            <TextInput
              id={id}
              type="url"
              inputMode="url"
              placeholder="https://…"
              value={value.text}
              onChange={(e) => onChange({ text: e.target.value })}
              invalid={Boolean(problem)}
              aria-required={required}
              autoComplete="off"
            />
          )}
        </Field>
      );
    case "choice": {
      const options = c.options ?? [];
      if (options.length > 5) {
        return (
          <Field label={req.label} required={required} error={problem}>
            {(id) => (
              <Select id={id} value={value.text} onChange={(e) => onChange({ text: e.target.value })} aria-required={required} className="w-full sm:max-w-sm">
                <option value="">Choose…</option>
                {options.map((o) => <option key={o} value={o}>{o}</option>)}
              </Select>
            )}
          </Field>
        );
      }
      return (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-[13px] font-semibold text-ink mb-1.5">
            {req.label}
            {required && <span className="text-crit" aria-hidden> *</span>}
          </legend>
          <div className="flex flex-col gap-1" role="radiogroup" aria-required={required}>
            {options.map((o) => (
              <label key={o} className="flex items-center gap-2.5 min-h-8 px-2.5 rounded-md border border-line bg-panel hover:bg-panel2 cursor-pointer text-sm text-ink">
                <input
                  type="radio"
                  name={`req-${req.key}`}
                  value={o}
                  checked={value.text === o}
                  onChange={() => onChange({ text: o })}
                  style={{ accentColor: "var(--accent)" }}
                />
                {o}
              </label>
            ))}
          </div>
          {touched && required && isEmpty(req, value) && <p className="text-xs text-crit">Pick one option.</p>}
        </fieldset>
      );
    }
    case "attestation":
      return (
        <div>
          <label className="flex items-start gap-2.5 rounded-md border border-line bg-panel px-3 py-2.5 hover:bg-panel2 cursor-pointer text-sm text-ink">
            <input
              type="checkbox"
              checked={value.checked}
              onChange={(e) => onChange({ checked: e.target.checked })}
              className="mt-0.5 h-4 w-4 flex-none"
              style={{ accentColor: "var(--accent)" }}
              aria-required={required}
            />
            <span>
              {req.label}
              {required && <span className="text-crit" aria-hidden> *</span>}
            </span>
          </label>
          {touched && required && !value.checked && <p className="text-xs text-crit mt-1.5">Tick this box to confirm.</p>}
        </div>
      );
    case "file":
      return <FileInput req={req} value={value.file} onChange={(file) => onChange({ file })} invalid={problem} />;
  }
}

// ------------------------------------------------------------ submission form

function SubmissionForm({
  o,
  requirements,
  previous,
  onDone,
}: {
  o: Obligation;
  requirements: EvidenceRequirement[];
  previous: Submission | null;
  onDone: () => void;
}) {
  const [values, setValues] = useState(() => initialValues(requirements, o.status === "rejected" ? previous : null));
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const resubmitting = o.status === "rejected";

  const missing = requirements.filter((r) => isMandatory(r) && isEmpty(r, values[r.key] ?? EMPTY_VALUE));
  const invalid = requirements.filter((r) => problemWith(r, values[r.key] ?? EMPTY_VALUE));
  const ready = missing.length === 0 && invalid.length === 0;

  function patch(key: string, p: Partial<Value>) {
    setValues((v) => ({ ...v, [key]: { ...(v[key] ?? EMPTY_VALUE), ...p } }));
    setServerError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setAttempted(true);
    if (!ready) return;
    const items = requirements.flatMap((r): { key: string; text?: string; checked?: boolean; file_id?: string }[] => {
      const v = values[r.key] ?? EMPTY_VALUE;
      if (isEmpty(r, v)) return [];
      if (r.kind === "attestation") return [{ key: r.key, checked: true }];
      if (r.kind === "file") return [{ key: r.key, file_id: v.file!.id }];
      return [{ key: r.key, text: v.text.trim() }];
    });
    setBusy(true);
    setServerError(null);
    try {
      await api.post(`/compliance/obligations/${o.id}/submit`, { items });
      toast.success(resubmitting ? "Resubmitted for review" : "Submitted", {
        description: o.instructions?.review_mode === "none" ? "This is now recorded as complete." : "A reviewer will take a look.",
      });
      onDone();
    } catch (err) {
      setServerError(errText(err));
      toastError("Couldn't submit", err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card as="section">
      <CardHeader
        title={resubmitting ? "Fix and resubmit" : "Your submission"}
        description={
          requirements.length
            ? "Fields marked * are required."
            : "There's nothing to attach for this one. Submit to confirm you've done it."
        }
      />
      <form onSubmit={submit} noValidate className="flex flex-col gap-5">
        {requirements.map((r) => (
          <RequirementInput key={r.key} req={r} value={values[r.key] ?? EMPTY_VALUE} onChange={(p) => patch(r.key, p)} touched={attempted} />
        ))}
        {serverError && <Banner tone="crit" title="This wasn't accepted">{serverError}</Banner>}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" leadingIcon={Send} loading={busy} disabled={!ready}>
            {resubmitting ? "Resubmit for review" : "Submit"}
          </Button>
          {!ready && (
            <p className="text-xs text-ink2" aria-live="polite">
              {missing.length > 0
                ? `Still needed: ${missing.map((r) => r.label).join(", ")}`
                : `Fix: ${invalid.map((r) => r.label).join(", ")}`}
            </p>
          )}
        </div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------- dialogs

function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** End of the chosen calendar day in the browser's time zone, as an ISO instant. */
function endOfDayIso(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 0).toISOString();
}

function ExtendDialog({ current, onSubmit }: { current: string | null; onSubmit: (iso: string, reason: string) => Promise<unknown> }) {
  const { close } = useOverlay();
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zone = browserTimeZone();
  const ready = Boolean(date) && Boolean(reason.trim());

  async function go() {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(endOfDayIso(date), reason.trim());
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
        if (ready) void go();
      }}
      className="flex flex-col gap-4 pr-6"
    >
      <div>
        <h2 className="text-lg font-semibold text-ink">Change deadline</h2>
        <p className="text-sm text-ink2 mt-1">
          {current ? `Currently due ${fmtDate(current)}. ` : "There's no deadline yet. "}
          The person is notified of the new date.
        </p>
      </div>
      <Field label="New deadline" required hint={`Counts until the end of that day${zone ? ` (${zone})` : ""}.`}>
        {(id) => <input id={id} type="date" min={localDate(new Date())} value={date} onChange={(e) => setDate(e.target.value)} className="field h-8 px-3 text-sm w-full sm:max-w-[200px]" autoFocus />}
      </Field>
      <Field label="Reason" required error={error}>
        {(id) => <Textarea id={id} value={reason} onChange={(e) => setReason(e.target.value)} rows={3} invalid={Boolean(error)} />}
      </Field>
      <div className="flex justify-end gap-2">
        <Button onClick={close} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" loading={busy} disabled={!ready}>Change deadline</Button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------ history

const SUB_TONE: Record<Submission["status"], Tone> = { submitted: "accent", under_review: "accent", approved: "good", rejected: "warn" };
const SUB_LABEL: Record<Submission["status"], string> = {
  submitted: "Waiting for review",
  under_review: "Being reviewed",
  approved: "Approved",
  rejected: "Changes requested",
};

function SubmissionBlock({
  sub,
  requirements,
  showSameFileNote,
  footer,
}: {
  sub: Submission;
  requirements: EvidenceRequirement[];
  showSameFileNote: boolean;
  footer?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-semibold text-ink">Version {sub.version}</span>
        <Label tone={SUB_TONE[sub.status]} size="sm" dot>{SUB_LABEL[sub.status]}</Label>
        {sub.late && <Label tone="crit" size="sm">Late</Label>}
        <span className="text-[13px] text-ink2">
          {sub.submitted_by ? `by ${sub.submitted_by.name} · ` : ""}
          {fmtDateTime(sub.submitted_at)}
        </span>
      </div>
      <EvidenceList items={sub.items} requirements={requirements} showSameFileNote={showSameFileNote} />
      {sub.decisions.length > 0 && (
        <div className="flex flex-col gap-2">
          {sub.decisions.map((d, i) => <DecisionLine key={i} d={d} />)}
        </div>
      )}
      {footer}
    </div>
  );
}

function History({ subs, requirements, showSameFileNote, title }: { subs: Submission[]; requirements: EvidenceRequirement[]; showSameFileNote: boolean; title: string }) {
  if (subs.length === 0) return null;
  const sorted = [...subs].sort((a, b) => b.version - a.version);
  return (
    <Card as="section">
      <CardHeader title={title} description={`${sorted.length} ${sorted.length === 1 ? "submission" : "submissions"}, newest first.`} />
      <ol className="flex flex-col">
        {sorted.map((s, i) => (
          <li key={s.id} className="relative pl-5 pb-5 last:pb-0">
            <span className={clsx("absolute left-[3px] top-1.5 w-2 h-2 rounded-full", i === 0 ? "bg-accent" : "bg-line-strong")} aria-hidden />
            {i < sorted.length - 1 && <span className="absolute left-[6.5px] top-4 bottom-0 w-px bg-line" aria-hidden />}
            <SubmissionBlock sub={s} requirements={requirements} showSameFileNote={showSameFileNote} />
          </li>
        ))}
      </ol>
    </Card>
  );
}

// -------------------------------------------------------------------- page

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-ink2">{label}</dt>
      <dd className="text-sm text-ink min-w-0">{children}</dd>
    </div>
  );
}

function PageSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <Skeleton className="h-3.5 w-40 mb-3" />
      <Skeleton className="h-8 w-80 max-w-full" />
      <Skeleton className="h-5 w-64 max-w-full mt-3" />
      <div className="grid lg:grid-cols-[1fr_300px] gap-4 mt-6">
        <div className="flex flex-col gap-4">
          <Skeleton className="h-36 w-full rounded-lg" />
          <Skeleton className="h-64 w-full rounded-lg" />
        </div>
        <Skeleton className="h-56 w-full rounded-lg" />
      </div>
    </div>
  );
}

export function ObligationPage() {
  const { id } = useParams<{ id: string }>();
  const { me } = useCompliance();
  const { data, error, initialLoading, reload } = useApi<Obligation>(id ? `/compliance/obligations/${encodeURIComponent(id)}` : null);
  const askReason = useReasonPrompt();
  const { openModal } = useOverlay();
  const { approve, requestChanges } = useReviewActions();
  const [busy, setBusy] = useState<string | null>(null);
  const [mailTick, setMailTick] = useState(0);

  const o = data && data.id === id ? data : null;
  const requirements = o?.instructions?.evidence_requirements ?? [];
  const latest = useMemo(() => latestSubmission(o?.submissions), [o]);

  if (!id || (error && !o)) {
    const notFound = !id || /no such|not found/i.test(error?.message ?? "");
    return (
      <div>
        <PageHeader title="Compliance item" breadcrumbs={[{ label: "My compliance", to: "/compliance/mine" }, { label: "Item" }]} />
        <Card>
          {notFound ? (
            <EmptyState
              title="We couldn't find this item"
              description="It may have been removed, or it isn't assigned to you and you don't have access to it."
              action={<Link to="/compliance/mine"><Button variant="primary">Back to my compliance</Button></Link>}
            />
          ) : (
            <ErrorState title="Couldn't load this item" message={error?.message} onRetry={reload} />
          )}
        </Card>
      </div>
    );
  }
  if (!o || initialLoading) return <PageSkeleton />;

  const mine = Boolean(me?.user && o.user && me.user.email === o.user.email);
  const informational = o.participation === "informational";
  const open = ["not_started", "in_progress", "rejected"].includes(o.status);
  const finished = ["completed", "waived", "cancelled"].includes(o.status);
  const max = o.instructions?.max_resubmissions ?? 3;
  const remaining = Math.max(0, max - o.resubmissions);
  const pending = o.can.review && latest && (latest.status === "submitted" || latest.status === "under_review") ? latest : null;
  const rest = (o.submissions ?? []).filter((s) => s.id !== pending?.id);
  const rejection = latest?.decisions.filter((d) => d.decision === "rejected").slice(-1)[0] ?? null;
  const rejectedReason = rejection?.reason || o.status_reason || "";
  const personName = o.user?.name ?? "this person";

  async function run(key: string, fn: () => Promise<unknown>, success: string) {
    setBusy(key);
    try {
      await fn();
      toast.success(success);
      reload();
    } catch (e) {
      toastError("That didn't work", e);
    } finally {
      setBusy(null);
    }
  }

  const waive = () =>
    askReason({
      title: "Waive this item",
      description: `${personName} won't need to do it. The reason is recorded and they are told.`,
      confirm: "Waive",
      tone: "danger",
      onSubmit: async (reason) => {
        await api.post(`/compliance/obligations/${o.id}/waive`, { reason });
        toast.success("Waived");
        reload();
      },
    });
  const reopen = () =>
    askReason({
      title: "Reopen this item",
      description: "It goes back to the person's to-do list.",
      confirm: "Reopen",
      onSubmit: async (reason) => {
        await api.post(`/compliance/obligations/${o.id}/reopen`, { reason });
        toast.success("Reopened");
        reload();
      },
    });
  const extend = () =>
    openModal(
      <ExtendDialog
        current={o.due_at}
        onSubmit={async (due_at, reason) => {
          await api.post(`/compliance/obligations/${o.id}/extend`, { due_at, reason });
          toast.success("Deadline changed");
          reload();
        }}
      />
    );

  const crumbs = mine
    ? [{ label: "My compliance", to: "/compliance/mine" }, { label: o.compliance.name }]
    : o.can.review
      ? [{ label: "Reviews", to: "/compliance/reviews" }, { label: o.compliance.name }]
      : [{ label: "Compliance", to: "/compliance" }, { label: o.compliance.name }];

  const manage = o.can.waive || o.can.extend || o.can.reopen;

  return (
    <div>
      <PageHeader
        title={o.compliance.name}
        description={o.compliance.category}
        breadcrumbs={crumbs}
        actions={
          <>
            {o.can.start && (
              <Button
                variant="primary"
                leadingIcon={Play}
                loading={busy === "start"}
                onClick={() => run("start", () => api.post(`/compliance/obligations/${o.id}/start`), "Started. Take your time.")}
              >
                Start working
              </Button>
            )}
            {!mine && o.user && (
              <>
                <EmailButton
                  label="Email"
                  onDone={() => setMailTick((t) => t + 1)}
                  target={() => ({
                    recipients: { obligation_id: o.id },
                    heading: `Email ${personName}`,
                    subtitle: `About ${o.compliance.name}. Replies go to you.`,
                    defaultKind: o.status === "completed" ? "thanks" : "reminder",
                  })}
                />
                {!finished && !informational && (o.overdue || o.non_compliant) && (
                  <EmailButton
                    label="Send a warning"
                    icon={AlertTriangle}
                    onDone={() => setMailTick((t) => t + 1)}
                    target={() => ({
                      recipients: { obligation_id: o.id },
                      heading: `Send ${personName} a warning`,
                      subtitle: `About ${o.compliance.name}, which is overdue. Replies go to you.`,
                      defaultKind: "warning",
                    })}
                  />
                )}
              </>
            )}
          </>
        }
      />

      <div className="-mt-3 mb-5 flex flex-wrap items-center gap-x-3 gap-y-2">
        <ObligationStatusLabel o={o} />
        <DueLabel iso={o.due_at} finished={finished || informational} />
        <PriorityLabel priority={o.compliance.priority} size="md" />
        <ParticipationLabel participation={o.participation} size="md" />
        {o.due_overridden && <Label size="sm" icon={CalendarClock}>Deadline changed</Label>}
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_300px] gap-4 items-start">
        <div className="flex flex-col gap-4 min-w-0">
          {/* ---- status banners */}
          {informational && (
            <Banner tone="info" icon={Info} title="This is for your information">
              Nothing to do. You were included so you're aware of it.
            </Banner>
          )}
          {!informational && o.non_compliant && !finished && (
            <Banner tone="crit" title="Recorded as non-compliant">
              {mine ? "This wasn't completed in time or wasn't accepted. Talk to your manager or the compliance team." : `${personName} is recorded as non-compliant on this item.`}
            </Banner>
          )}
          {!informational && o.overdue && !o.non_compliant && !finished && (
            <Banner tone="crit" title="This is overdue">
              It was due {o.due_at ? fmtDateTime(o.due_at) : "earlier"}.{o.can.submit && mine ? " Submit as soon as you can." : ""}
            </Banner>
          )}
          {o.status === "rejected" && (
            <Banner
              tone="warn"
              icon={MessageSquareWarning}
              title={mine ? "Changes are needed" : `Changes were requested from ${personName}`}
            >
              {rejectedReason && (
                <p className="text-ink whitespace-pre-wrap break-words">
                  {rejection?.reviewer ? <span className="font-semibold">{rejection.reviewer.name}: </span> : null}
                  {rejectedReason}
                </p>
              )}
              <p className="mt-1">
                {o.can.submit
                  ? `${remaining} ${remaining === 1 ? "resubmission" : "resubmissions"} left of ${max}.`
                  : "No resubmissions are left on this item."}
              </p>
            </Banner>
          )}
          {(o.status === "submitted" || o.status === "under_review") && mine && (
            <Banner tone="info" title={o.status === "submitted" ? "Submitted: waiting for review" : "A reviewer is looking at it"}>
              You'll be notified of the decision{o.submitted_at ? `. You submitted this ${fmtDateTime(o.submitted_at)}` : ""}.
            </Banner>
          )}
          {o.status === "completed" && (
            <Banner tone="good" title="Completed">{o.completed_at ? `Recorded ${fmtDateTime(o.completed_at)}.` : "This is done."}</Banner>
          )}
          {(o.status === "waived" || o.status === "cancelled") && (
            <Banner tone="info" title={o.status === "waived" ? "Waived" : "Cancelled"}>
              {o.status_reason || "No reason was recorded."}
            </Banner>
          )}
          {open && !informational && o.compliance.status !== "published" && (
            <Banner tone="warn" title={`This compliance is ${o.compliance.status}`}>It can't be submitted right now.</Banner>
          )}

          {/* ---- instructions */}
          <Card as="section">
            <CardHeader title="What you need to do" />
            {o.instructions?.action_text || o.compliance.action_text ? (
              <p className="text-[15px] font-semibold text-ink">{o.instructions?.action_text || o.compliance.action_text}</p>
            ) : null}
            {o.instructions?.description ? (
              <p className="text-sm text-ink2 mt-2 whitespace-pre-wrap break-words">{o.instructions.description}</p>
            ) : (
              !o.compliance.action_text && <p className="text-sm text-ink3">No instructions were written for this one.</p>
            )}
            <dl className="mt-4 grid sm:grid-cols-2 gap-3 text-sm">
              <DetailRow label="Who checks it">
                {o.instructions ? REVIEW_MODE_LABEL[o.instructions.review_mode] : "—"}
              </DetailRow>
              <DetailRow label="What to send">
                {requirements.length === 0
                  ? "Nothing to attach"
                  : requirements.map((r) => r.label).join(", ")}
              </DetailRow>
            </dl>
          </Card>

          {/* ---- review (reviewers) */}
          {pending && (
            <Card as="section" className="border-accent">
              <CardHeader
                title="Needs your review"
                description={`Look over what ${personName} sent, then approve it or ask for changes.`}
              />
              <SubmissionBlock
                sub={pending}
                requirements={requirements}
                showSameFileNote
                footer={
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button
                      variant="primary"
                      leadingIcon={Check}
                      loading={busy === "approve"}
                      onClick={async () => {
                        setBusy("approve");
                        const ok = await approve(pending, o.compliance.name);
                        setBusy(null);
                        if (ok) reload();
                      }}
                    >
                      Approve
                    </Button>
                    <Button variant="danger" leadingIcon={MessageSquareWarning} onClick={() => requestChanges(pending, reload, personName)}>
                      Request changes
                    </Button>
                  </div>
                }
              />
            </Card>
          )}

          {/* ---- submission form */}
          {o.can.submit && <SubmissionForm key={`${o.id}:${latest?.id ?? "new"}`} o={o} requirements={requirements} previous={latest} onDone={reload} />}

          {/* ---- history */}
          <History
            subs={rest}
            requirements={requirements}
            showSameFileNote={!mine}
            title={pending ? "Earlier submissions" : "Submission history"}
          />
          {(o.submissions ?? []).length === 0 && !o.can.submit && !informational && (
            <Card>
              <EmptyState compact title="Nothing has been submitted yet" description={mine ? "Your submissions will be listed here." : `${personName} hasn't submitted anything yet.`} />
            </Card>
          )}
          {!mine && <CommunicationHistory query={`obligation_id=${o.id}`} refresh={mailTick} description={`E-mails sent to ${personName} about this item.`} />}
        </div>

        {/* ---- side */}
        <div className="flex flex-col gap-4 min-w-0">
          <Card as="section">
            <CardHeader title="Details" />
            <dl className="flex flex-col gap-3">
              <DetailRow label="Assigned to">
                <PersonCell person={o.user} size={28} showTitle />
              </DetailRow>
              <DetailRow label="Deadline">
                <DueLabel iso={o.due_at} finished={finished || informational} />
              </DetailRow>
              {o.assigned_via && o.assigned_via.length > 0 && (
                <DetailRow label="Assigned because">{o.assigned_via.join(", ")}</DetailRow>
              )}
              {!informational && (
                <DetailRow label="Resubmissions">
                  {o.resubmissions} of {max} used
                </DetailRow>
              )}
              {o.submitted_at && <DetailRow label="Last submitted">{fmtDateTime(o.submitted_at)}</DetailRow>}
              {o.completed_at && <DetailRow label="Completed">{fmtDateTime(o.completed_at)}</DetailRow>}
            </dl>
          </Card>

          {manage && (
            <Card as="section">
              <CardHeader title="Manage" description="These are recorded in the audit log." />
              <div className="flex flex-col gap-2">
                {o.can.extend && <Button leadingIcon={CalendarClock} onClick={extend} block>Change deadline</Button>}
                {o.can.waive && <Button leadingIcon={ShieldOff} onClick={waive} block>Waive</Button>}
                {o.can.reopen && <Button leadingIcon={RotateCcw} onClick={reopen} block>Reopen</Button>}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
