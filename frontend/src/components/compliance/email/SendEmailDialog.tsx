/**
 * "E-mail these people about their compliance": the one dialog behind every Email / Send a warning action.
 *
 * Compose (recipients, template, subject and message, options, live preview) -> optional confirm for a big
 * warning batch -> progress and result. The server resolves and checks who is reached (`target.recipients` is
 * only a request, limited to the sender's scope), renders every variable and sends in the background.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import * as D from "@radix-ui/react-dialog";
import clsx from "clsx";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleSlash,
  Mail,
  Send,
  Users,
  X,
  XCircle,
} from "lucide-react";
import { api } from "../../../lib/api";
import { useCompliance } from "../../../lib/ComplianceContext";
import { useDebouncedValue } from "../../../lib/useDebouncedValue";
import {
  KIND_LABEL,
  type BatchStatus,
  type EmailPreview,
  type EmailTemplate,
  type EmailVariable,
  type RecipientSpec,
  type SendOptions,
  type TemplateKind,
  type VariablesResponse,
} from "../../../lib/emailTemplates";
import { Avatar, Banner, Button, IconButton, ProgressBar, Skeleton, Spinner, TextInput } from "../../ui";
import { Chip, CheckRow } from "../admin/parts";
import { Field, errText } from "../common";
import { KindChip } from "./KindChip";
import { PreviewFrame } from "./PreviewFrame";
import { TemplatePicker } from "./TemplatePicker";
import { useVariableInsert } from "./useVariableInsert";
import { InsertVariableMenu } from "./VariableMenu";

export interface EmailTarget {
  /** Who to e-mail, as a request: the server works out who may actually be reached. */
  recipients: RecipientSpec;
  /** Dialog heading, e.g. "Email Daniel Kim". */
  heading: string;
  /** One line under the heading, e.g. what it is about. */
  subtitle?: string;
  /** The kind of template that is chosen first (the first active one of that kind). */
  defaultKind?: TemplateKind;
}

type Step = "compose" | "confirm" | "result";

const DEFAULT_OPTIONS: SendOptions = { cc_manager: false, copy_me: false, in_app: false };

export function SendEmailDialog({
  open,
  onOpenChange,
  target,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: EmailTarget;
  /** Called when a batch has finished, so the page can refresh its history. */
  onDone?: (batch: BatchStatus) => void;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="mc-scrim fixed inset-0 z-50" style={{ background: "var(--scrim)" }} />
        <div className="fixed inset-0 z-50 grid place-items-center p-2 sm:p-4 pointer-events-none">
          <D.Content
            aria-describedby={undefined}
            onInteractOutside={(e) => e.preventDefault()}
            className="mc-dialog pointer-events-auto relative w-full max-w-[1040px] max-h-[94vh] overflow-y-auto rounded-xl bg-panel border border-line shadow-lg outline-none"
          >
            <D.Title className="sr-only">{target.heading}</D.Title>
            <DialogBody target={target} close={() => onOpenChange(false)} onDone={onDone} />
          </D.Content>
        </div>
      </D.Portal>
    </D.Root>
  );
}

// ---------------------------------------------------------------------- body

function DialogBody({ target, close, onDone }: { target: EmailTarget; close: () => void; onDone?: (b: BatchStatus) => void }) {
  const { can } = useCompliance();
  const [step, setStep] = useState<Step>("compose");

  // what is loaded
  const [templates, setTemplates] = useState<EmailTemplate[] | null>(null);
  const [variables, setVariables] = useState<EmailVariable[]>([]);
  const [base, setBase] = useState<EmailPreview | null>(null); // the people, before any un-ticking
  const [loadError, setLoadError] = useState<string | null>(null);

  // the draft
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [options, setOptions] = useState<SendOptions>(DEFAULT_OPTIONS);
  const [exclude, setExclude] = useState<Set<string>>(new Set());

  // the live preview
  const [preview, setPreview] = useState<EmailPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [idx, setIdx] = useState(0);
  const [showPeople, setShowPeople] = useState(false);
  const [showSkipped, setShowSkipped] = useState(false);

  // sending
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [batch, setBatch] = useState<BatchStatus | null>(null);

  const ready = templates !== null && base !== null;
  const template = templates?.find((t) => t.id === templateId) ?? null;

  // ---- first load: templates, variables and the people (without a draft)
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [tpl, vars, people] = await Promise.all([
          api.get<EmailTemplate[]>("/compliance/email-templates"),
          api.get<VariablesResponse>("/compliance/email-variables"),
          api.post<EmailPreview>("/compliance/emails/preview", { recipients: target.recipients, template_id: null, subject: "", body: "" }),
        ]);
        if (!alive) return;
        const first = tpl.find((t) => t.kind === (target.defaultKind ?? "reminder")) ?? tpl[0] ?? null;
        setTemplates(tpl);
        setVariables(vars.variables);
        setBase(people);
        if (first) {
          setTemplateId(first.id);
          setSubject(first.subject);
          setBody(first.body);
        }
      } catch (e) {
        if (alive) setLoadError(errText(e));
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- live preview, debounced; an older answer never replaces a newer one
  const draftKey = JSON.stringify([templateId, subject, body, options.cc_manager, Array.from(exclude).sort()]);
  const debounced = useDebouncedValue(draftKey, 350);
  const seq = useRef(0);
  useEffect(() => {
    if (!ready) return;
    const mine = ++seq.current;
    setPreviewBusy(true);
    api
      .post<EmailPreview>("/compliance/emails/preview", {
        recipients: { ...target.recipients, exclude: Array.from(exclude) },
        template_id: templateId,
        subject,
        body,
        options,
      })
      .then((p) => {
        if (mine !== seq.current) return;
        setPreview(p);
        setPreviewError(null);
        setIdx((i) => Math.min(i, Math.max(0, p.previews.length - 1)));
      })
      .catch((e) => {
        if (mine === seq.current) setPreviewError(errText(e));
      })
      .finally(() => {
        if (mine === seq.current) setPreviewBusy(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, ready]);

  // ---- progress: poll the batch until it is done
  useEffect(() => {
    if (step !== "result" || !batchId) return;
    let stop = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const b = await api.get<BatchStatus>(`/compliance/emails/batches/${batchId}`);
        if (stop) return;
        setBatch(b);
        if (b.status === "done") {
          onDone?.(b);
          return;
        }
      } catch {
        /* a blip: try again */
      }
      timer = window.setTimeout(() => void tick(), 900);
    };
    void tick();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, batchId]);

  const { subjectRef, bodyRef, fieldProps, insert, refocus } = useVariableInsert(subject, setSubject, body, setBody);

  function pickTemplate(id: string | null) {
    setTemplateId(id);
    const t = templates?.find((x) => x.id === id);
    if (t) {
      setSubject(t.subject);
      setBody(t.body);
    }
  }

  const edited = template !== null && (subject !== template.subject || body !== template.body);
  const people = base?.recipients ?? [];
  const willSend = preview?.will_send ?? Math.max(0, people.length - exclude.size);
  const unresolved = preview?.unresolved ?? [];
  const skipped = preview?.skipped_list ?? base?.skipped_list ?? [];
  const skippedCounts = preview?.skipped_counts ?? base?.skipped_counts ?? {};
  const message = preview?.previews[idx] ?? null;
  // People who are in the list but won't be e-mailed with this template (e.g. nothing open to chase), by e-mail.
  const skippedWhy = useMemo(() => new Map(skipped.filter((s) => s.email).map((s) => [s.email.toLowerCase(), s.label.toLowerCase()])), [skipped]);
  const kind: TemplateKind = preview?.kind ?? template?.kind ?? "custom";

  let blocker: string | null = null;
  if (!ready) blocker = null;
  else if (!subject.trim()) blocker = "Add a subject";
  else if (!body.trim()) blocker = "Write the message";
  else if (unresolved.length > 0) blocker = "Fix the highlighted variables";
  else if (preview && preview.will_send === 0) blocker = "There is nobody to send this to";
  else if (preview?.over_cap) blocker = `A batch is limited to ${preview.limits.max_recipients} people`;
  else if (preview?.over_rate) blocker = "You've reached the hourly sending limit";
  else if (preview && !preview.smtp_configured) blocker = "E-mail isn't set up yet";
  else if (!preview || previewBusy) blocker = null;

  const canSend = ready && !blocker && Boolean(preview) && !previewBusy && !sending && willSend > 0;

  async function send(confirmed: boolean) {
    setSending(true);
    setSendError(null);
    try {
      const r = await api.post<{ batch_id: string; queued: number; skipped: number }>("/compliance/emails/send", {
        recipients: { ...target.recipients, exclude: Array.from(exclude) },
        template_id: templateId,
        subject,
        body,
        options,
        confirmed,
      });
      setBatchId(r.batch_id);
      setStep("result");
    } catch (e) {
      setSendError(errText(e));
      if (step === "confirm") setStep("compose");
    } finally {
      setSending(false);
    }
  }

  function toggle(email: string) {
    setExclude((s) => {
      const n = new Set(s);
      if (n.has(email)) n.delete(email);
      else n.add(email);
      return n;
    });
  }

  // ------------------------------------------------------------------ views

  const header = (
    <div className="flex items-start gap-3 px-5 pt-5 pb-3">
      <span
        className="w-9 h-9 rounded-lg flex items-center justify-center text-white flex-none"
        style={{ background: "linear-gradient(145deg, rgba(var(--hue-indigo), 1), rgba(var(--hue-indigo), 0.72))", boxShadow: "0 6px 14px -4px rgba(var(--hue-indigo), 0.6)" }}
        aria-hidden
      >
        <Mail size={18} />
      </span>
      <div className="min-w-0 flex-1 pr-8">
        <h2 className="text-lg font-semibold text-ink leading-6 truncate">{target.heading}</h2>
        <p className="text-[13px] text-ink2 mt-0.5">{target.subtitle ?? "Replies go to you."}</p>
      </div>
      <D.Close asChild>
        <IconButton icon={X} label="Close" tooltip={false} className="absolute top-3 right-3" />
      </D.Close>
    </div>
  );

  if (loadError) {
    return (
      <div>
        {header}
        <div className="px-5 pb-5">
          <Banner tone="crit" title="Couldn't prepare this e-mail">
            {loadError}
          </Banner>
          <div className="flex justify-end mt-4">
            <Button onClick={close}>Close</Button>
          </div>
        </div>
      </div>
    );
  }

  if (!ready) {
    return (
      <div aria-busy="true">
        {header}
        <div className="px-5 pb-5 grid lg:grid-cols-2 gap-5">
          <div className="flex flex-col gap-3">
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
          <Skeleton className="h-80 w-full" />
        </div>
      </div>
    );
  }

  if (step === "result") {
    return (
      <div>
        {header}
        <ResultView batch={batch} queued={willSend} close={close} />
      </div>
    );
  }

  if (step === "confirm") {
    const final = kind === "final";
    return (
      <div>
        {header}
        <div className="px-5 pb-5 flex flex-col gap-4" role="alertdialog" aria-label="Confirm sending">
          <Banner tone={final ? "crit" : "warn"} icon={AlertTriangle} title={`Send a ${KIND_LABEL[kind].toLowerCase()} to ${willSend} people?`}>
            This goes to {willSend} people at once and can't be undone. Each person gets their own copy, and everything is recorded in the history and the audit log.
          </Banner>
          <div className="rounded-lg border border-line bg-panel2 p-3 text-[13px] text-ink2">
            <p>
              <span className="text-ink font-semibold">{preview?.previews[0]?.subject || subject || "(no subject)"}</span>
            </p>
            <p className="mt-1">
              Template: {template?.name ?? "written by hand"} · {KIND_LABEL[kind]}
            </p>
          </div>
          {sendError && <Banner tone="crit">{sendError}</Banner>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={() => setStep("compose")} disabled={sending}>
              Back
            </Button>
            <Button variant="primary" leadingIcon={Send} loading={sending} onClick={() => void send(true)} autoFocus>
              Yes, send {willSend}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const countsText = Object.entries(skippedCounts)
    .map(([reason, n]) => `${n} ${skipLabel(reason, n)}`)
    .join(", ");

  return (
    <div>
      {header}

      <div className="px-5 pb-4 grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] gap-x-6 gap-y-5">
        {/* ------------------------------------------------------- form */}
        <div className="flex flex-col gap-4 min-w-0">
          {/* recipients */}
          <section aria-label="Recipients" className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 h-[26px] px-2.5 rounded-full text-[13px] font-semibold bg-accent-soft text-accent-strong">
                <Users size={14} aria-hidden /> {willSend} {willSend === 1 ? "person" : "people"} will receive this
              </span>
              {skipped.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowSkipped((v) => !v)}
                  aria-expanded={showSkipped}
                  className="inline-flex items-center gap-1 h-[26px] px-2.5 rounded-full text-[13px] bg-neutral-bg text-ink2 hover:text-ink"
                >
                  {skipped.length} skipped <ChevronDown size={13} className={clsx("transition-transform", showSkipped && "rotate-180")} aria-hidden />
                </button>
              )}
              {previewBusy && <Spinner size={14} className="text-ink3" label="Updating the preview" />}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {people
                .filter((p) => !exclude.has(p.email))
                .slice(0, 4)
                .map((p) => (
                  <Chip key={p.email}>{p.name}</Chip>
                ))}
              {willSend > 4 && <Chip className="bg-transparent border-dashed">+{willSend - 4} more</Chip>}
            </div>
            {people.length > 0 && (
              <button
                type="button"
                onClick={() => setShowPeople((v) => !v)}
                aria-expanded={showPeople}
                className="self-start inline-flex items-center gap-1 text-[13px] font-semibold text-accent hover:underline"
              >
                {showPeople ? "Hide recipients" : "Show recipients"} <ChevronDown size={14} className={clsx("transition-transform", showPeople && "rotate-180")} aria-hidden />
              </button>
            )}
            {showPeople && (
              <div role="group" aria-label="Recipients" className="border border-line rounded-lg max-h-52 overflow-y-auto divide-y divide-line-soft bg-panel">
                {people.map((p) => {
                  const why = skippedWhy.get(p.email.toLowerCase());
                  return (
                    <label key={p.email} className={clsx("flex items-center gap-3 px-3 py-2 hover:bg-panel2", why ? "opacity-60" : "cursor-pointer")}>
                      <input
                        type="checkbox"
                        checked={!why && !exclude.has(p.email)}
                        disabled={Boolean(why)}
                        onChange={() => toggle(p.email)}
                        className="w-4 h-4 accent-[var(--accent)] flex-none"
                      />
                      <Avatar name={p.name} size={24} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-ink truncate">{p.name}</span>
                        <span className="block text-xs text-ink2 truncate">
                          {p.email}
                          {p.item ? ` · ${p.item.compliance}` : p.open_count ? ` · ${p.open_count} open ${p.open_count === 1 ? "item" : "items"}` : ""}
                        </span>
                      </span>
                      {why && <span className="text-xs text-ink2 flex-none">Skipped: {why}</span>}
                    </label>
                  );
                })}
              </div>
            )}
            {showSkipped && (
              <div className="rounded-lg border border-line bg-panel2 p-3 text-[13px] flex flex-col gap-1.5">
                <p className="text-ink2">Not sent to these, so nobody is e-mailed by mistake:</p>
                <ul className="flex flex-col gap-1 max-h-40 overflow-y-auto">
                  {skipped.map((s, i) => (
                    <li key={`${s.email}-${i}`} className="flex items-center gap-2 min-w-0">
                      <CircleSlash size={13} className="text-ink3 flex-none" aria-hidden />
                      <span className="text-ink truncate">{s.name || s.email}</span>
                      <span className="text-ink2 ml-auto flex-none">{s.label}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!showSkipped && countsText && <p className="text-xs text-ink2">Skipped: {countsText}.</p>}
          </section>

          {/* template */}
          <Field label="Template" hint={template?.description || undefined}>
            {(id) => <TemplatePicker id={id} templates={templates ?? []} value={templateId} onChange={pickTemplate} />}
          </Field>

          {/* subject and message */}
          <div className="flex flex-col gap-3">
            <div className="flex items-end justify-between gap-2">
              <span className="text-[13px] font-semibold text-ink flex items-center gap-2">
                Message
                {edited && (
                  <button type="button" onClick={() => template && pickTemplate(template.id)} className="text-xs font-medium text-accent hover:underline">
                    Edited · reset to template
                  </button>
                )}
              </span>
              <InsertVariableMenu variables={variables} onInsert={insert} onClosed={refocus} />
            </div>
            <TextInput
              ref={subjectRef}
              aria-label="Subject"
              placeholder="Subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value.replace(/\n/g, " "))}
              {...fieldProps("subject")}
              invalid={unresolved.some((u) => subject.includes(u))}
            />
            <textarea
              ref={bodyRef}
              aria-label="Message"
              rows={11}
              value={body}
              placeholder="Write your message. Use Insert variable to add the person's name, the deadline and more."
              onChange={(e) => setBody(e.target.value)}
              {...fieldProps("body")}
              className="field px-3 py-2 text-sm leading-5 resize-y min-h-[160px] font-sans"
            />
            {unresolved.length > 0 && (
              <Banner tone="warn" title="These can't be filled in">
                {unresolved.map((u) => `{{${u}}}`).join(", ")}: remove them or pick a variable from the list.
              </Banner>
            )}
          </div>

          {/* options */}
          <fieldset className="flex flex-col gap-2">
            <legend className="text-[13px] font-semibold text-ink mb-1">Options</legend>
            <CheckRow
              checked={options.cc_manager}
              onChange={(v) => setOptions((o) => ({ ...o, cc_manager: v }))}
              title="Copy their manager"
              description="Each person's manager is cc'd, when they have one."
            />
            <CheckRow
              checked={options.copy_me && !preview?.sender_is_demo}
              disabled={preview?.sender_is_demo}
              onChange={(v) => setOptions((o) => ({ ...o, copy_me: v }))}
              title="Send me a copy"
              description={preview?.sender_is_demo ? "Your demo account has no mailbox." : "One copy to you, however many people you write to."}
            />
            <CheckRow
              checked={options.in_app}
              onChange={(v) => setOptions((o) => ({ ...o, in_app: v }))}
              title="Also show it in their notifications"
              description="They see it under the bell in Encop as well as in their inbox."
            />
          </fieldset>
        </div>

        {/* ---------------------------------------------------- preview */}
        <div className="flex flex-col gap-3 min-w-0 lg:sticky lg:top-1 self-start">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-ink flex items-center gap-2">
              Preview <KindChip kind={kind} size="sm" />
            </h3>
            {preview && preview.previews.length > 0 && (
              <div className="flex items-center gap-1 text-[13px] text-ink2">
                <IconButton icon={ChevronLeft} label="Previous recipient" size="sm" disabled={idx === 0} onClick={() => setIdx((i) => Math.max(0, i - 1))} />
                <span className="tabular min-w-[8.5rem] text-center truncate">
                  <span className="text-ink font-medium">{message?.name}</span> · {idx + 1} of {Math.min(preview.previews.length, preview.will_send)}
                  {preview.will_send > preview.previews.length ? "+" : ""}
                </span>
                <IconButton icon={ChevronRight} label="Next recipient" size="sm" disabled={idx >= preview.previews.length - 1} onClick={() => setIdx((i) => Math.min(preview.previews.length - 1, i + 1))} />
              </div>
            )}
          </div>
          {previewError ? (
            <Banner tone="crit">{previewError}</Banner>
          ) : message ? (
            <>
              <PreviewFrame subject={message.subject} html={message.html} text={message.text} heightClass="h-[380px] lg:h-[560px]" />
              {message.cc.length > 0 && <p className="text-xs text-ink2">Cc: {message.cc.join(", ")}</p>}
            </>
          ) : (
            <div className="rounded-lg border border-dashed border-line bg-panel2 h-[300px] flex items-center justify-center text-center px-6 text-[13px] text-ink2">
              {subject.trim() || body.trim() ? (willSend === 0 ? "Nobody would receive this." : "Updating the preview…") : "Pick a template or write a message to see how it will look."}
            </div>
          )}
          {preview?.notes.map((n) => (
            <p key={n} className="text-xs text-ink2">
              {n}
            </p>
          ))}
        </div>
      </div>

      {/* ----------------------------------------------------- footer */}
      <div className="sticky bottom-0 bg-panel border-t border-line px-5 py-3 flex flex-col gap-2.5">
        {preview && !preview.smtp_configured && (
          <Banner
            tone="warn"
            title="E-mail isn't set up yet"
            action={can("settings", "configure") ? <Link to="/settings" onClick={close}><Button size="sm">Open Settings</Button></Link> : undefined}
          >
            An administrator needs to add the SMTP host and a From address in Settings, under Email (SMTP).
          </Banner>
        )}
        {preview?.over_cap && (
          <Banner tone="warn">
            A batch is limited to {preview.limits.max_recipients} people and this one has {preview.will_send}. Untick some people or narrow it down.
          </Banner>
        )}
        {preview?.over_rate && !preview.over_cap && (
          <Banner tone="warn">
            You can e-mail {preview.limits.rate_limit_per_hour} people an hour and have {Math.max(0, preview.limits.rate_limit_per_hour - preview.limits.sent_last_hour)} left. Try again later.
          </Banner>
        )}
        {preview?.needs_confirm && !blocker && (
          <Banner tone={kind === "final" ? "crit" : "warn"} icon={AlertTriangle}>
            This sends a {KIND_LABEL[kind].toLowerCase()} to {preview.will_send} people. You'll be asked to confirm.
          </Banner>
        )}
        {sendError && <Banner tone="crit">{sendError}</Banner>}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {blocker && <span className="text-[13px] text-ink2 mr-auto">{blocker}</span>}
          <Button onClick={close} disabled={sending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            leadingIcon={Send}
            loading={sending}
            disabled={!canSend}
            onClick={() => (preview?.needs_confirm ? setStep("confirm") : void send(false))}
          >
            {willSend > 0 ? `Send to ${willSend} ${willSend === 1 ? "person" : "people"}` : "Send"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function skipLabel(reason: string, n: number): string {
  const one: Record<string, string> = {
    outside_scope: "outside your scope",
    duplicate: "duplicate",
    inactive: "inactive",
    demo: "demo account",
    no_email: "without an e-mail address",
    self: "you",
    nothing_open: "with nothing open",
    stopped: "not attempted",
  };
  const label = one[reason] ?? reason;
  return reason === "demo" && n !== 1 ? "demo accounts" : label;
}

// -------------------------------------------------------------------- result

function ResultView({ batch, queued, close }: { batch: BatchStatus | null; queued: number; close: () => void }) {
  const counts = batch?.counts ?? { queued: queued, sent: 0, failed: 0, skipped: 0 };
  const handled = counts.sent + counts.failed;
  const done = batch?.status === "done";
  const failed = batch?.recipients.filter((r) => r.status === "failed") ?? [];
  const skipped = batch?.recipients.filter((r) => r.status === "skipped") ?? [];
  const pct = done ? 100 : Math.round((handled / Math.max(1, handled + counts.queued)) * 100);

  return (
    <div className="px-5 pb-5 flex flex-col gap-4" aria-live="polite">
      <div>
        <div className="flex items-center gap-2 mb-2">
          {done ? (
            counts.failed === 0 ? <CheckCircle2 size={18} className="text-good" aria-hidden /> : <AlertTriangle size={18} className="text-warn" aria-hidden />
          ) : (
            <Spinner size={16} className="text-accent" label="Sending" />
          )}
          <h3 className="text-base font-semibold text-ink">
            {!done
              ? `Sending… ${handled} of ${handled + counts.queued}`
              : counts.failed === 0
                ? `Sent to ${counts.sent} ${counts.sent === 1 ? "person" : "people"}`
                : `${counts.sent} sent, ${counts.failed} didn't go`}
          </h3>
        </div>
        <ProgressBar value={pct} tone={done ? (counts.failed ? "warn" : "good") : "accent"} />
        {!done && <p className="text-xs text-ink2 mt-2">You can close this: the rest keeps sending in the background, and it's all in the history.</p>}
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Tile label="Sent" value={counts.sent} tone="good" />
        <Tile label="Failed" value={counts.failed} tone={counts.failed ? "crit" : "neutral"} />
        <Tile label="Skipped" value={counts.skipped} tone="neutral" />
      </div>

      {batch?.stopped && (
        <Banner tone="warn" title="The batch stopped early">
          The mail server failed several times in a row, so the rest weren't tried. Check the failures below and the e-mail settings, then send to the people who are missing.
        </Banner>
      )}

      {failed.length > 0 && (
        <section aria-label="Failed" className="flex flex-col gap-1.5">
          <h4 className="text-[13px] font-semibold text-ink">Didn't send</h4>
          <ul className="rounded-lg border border-line divide-y divide-line-soft max-h-48 overflow-y-auto">
            {failed.map((r) => (
              <li key={r.id} className="flex items-start gap-2 px-3 py-2 text-[13px]">
                <XCircle size={15} className="text-crit mt-0.5 flex-none" aria-hidden />
                <span className="min-w-0">
                  <span className="font-medium text-ink">{r.name || r.email}</span> <span className="text-ink2">{r.email}</span>
                  <span className="block text-ink2">{r.error}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {skipped.length > 0 && (
        <section aria-label="Skipped" className="flex flex-col gap-1.5">
          <h4 className="text-[13px] font-semibold text-ink">Skipped</h4>
          <ul className="rounded-lg border border-line divide-y divide-line-soft max-h-32 overflow-y-auto">
            {skipped.map((r) => (
              <li key={r.id} className="flex items-center gap-2 px-3 py-1.5 text-[13px]">
                <CircleSlash size={14} className="text-ink3 flex-none" aria-hidden />
                <span className="text-ink truncate">{r.name || r.email || "Someone outside your scope"}</span>
                <span className="text-ink2 ml-auto text-right">{r.error}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {done && counts.failed === 0 && counts.sent > 0 && (
        <p className="text-[13px] text-ink2 flex items-center gap-1.5">
          <Check size={14} className="text-good" aria-hidden /> Each message is saved in the communication history, and the batch is in the audit log.
        </p>
      )}

      <div className="flex justify-end">
        <Button variant={done ? "primary" : "secondary"} onClick={close}>
          {done ? "Done" : "Close"}
        </Button>
      </div>
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: number; tone: "good" | "crit" | "neutral" }) {
  const color = tone === "good" ? "var(--good)" : tone === "crit" ? "var(--crit)" : "var(--text)";
  return (
    <div className="rounded-lg border border-line bg-panel2 px-3 py-2.5">
      <div className="text-xs text-ink2">{label}</div>
      <div className="text-2xl font-semibold tabular leading-8" style={{ color }}>
        {value}
      </div>
    </div>
  );
}

// -------------------------------------------------------------- entry point

/** Re-exported for pages that only need the button. */
export { KIND_LABEL };
