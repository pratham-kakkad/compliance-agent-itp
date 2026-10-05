import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import clsx from "clsx";
import { toast } from "sonner";
import { AlertCircle, Lock, Rocket, Save } from "lucide-react";
import { api } from "../../lib/api";
import { useApi } from "../../lib/useApi";
import { useCompliance } from "../../lib/ComplianceContext";
import { useSettings } from "../../lib/SettingsContext";
import { fmtDateTime, utcOffsetLabel } from "../../lib/format";
import {
  PRIORITY_LABEL,
  REVIEW_MODE_LABEL,
  COMPLETION_LABEL,
  type ComplianceDef,
  type CompletionPolicy,
  type Meta,
  type Priority,
  type ReviewMode,
} from "../../lib/compliance";
import { Banner, Button, Card, EmptyState, ErrorState, PageHeader, Select, Skeleton, TextInput } from "../../components/ui";
import { Field, Textarea, errText, toastError } from "../../components/compliance/common";
import { AudienceBuilder, peopleOptions, useAudiencePreview } from "../../components/compliance/library/AudienceBuilder";
import { Combobox } from "../../components/compliance/library/Combobox";
import { EscalationBuilder } from "../../components/compliance/library/EscalationBuilder";
import { EvidenceBuilder } from "../../components/compliance/library/EvidenceBuilder";
import { RadioCards } from "../../components/compliance/library/RadioCards";
import { useConfirm } from "../../components/compliance/library/confirm";
import { COMPLETION_HELP, REVIEW_MODE_HELP, completionText } from "../../components/compliance/library/describe";
import { inDaysInput, zonedInputToInstant } from "../../components/compliance/library/datetime";
import {
  SECTIONS,
  applyTypeDefaults,
  changedFields,
  differsFromType,
  emptyForm,
  formFromDef,
  stable,
  toPayload,
  validate,
  type FormState,
  type SectionId,
} from "../../components/compliance/library/formModel";
import { useLookup } from "../../components/compliance/library/lookup";
import { useUnsavedGuard } from "../../components/compliance/library/unsaved";

function Section({ id, step, title, description, children }: { id: SectionId; step: number; title: string; description?: string; children: React.ReactNode }) {
  return (
    <section id={`sec-${id}`} aria-labelledby={`sec-${id}-h`} className="scroll-mt-20">
      <Card padding="none">
        <div className="px-4 sm:px-5 pt-4 pb-3 border-b border-line flex items-start gap-3">
          <span className="w-6 h-6 rounded-full bg-panel2 border border-line text-xs font-semibold text-ink2 flex items-center justify-center flex-none mt-px" aria-hidden>
            {step}
          </span>
          <div className="min-w-0">
            <h2 id={`sec-${id}-h`} className="text-base font-semibold text-ink leading-6">
              {title}
            </h2>
            {description && <p className="text-[13px] text-ink2 mt-0.5">{description}</p>}
          </div>
        </div>
        <div className="p-4 sm:p-5">{children}</div>
      </Card>
    </section>
  );
}

function FormSkeleton() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-label="Loading">
      {[0, 1, 2].map((i) => (
        <Card key={i}>
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-8 w-full mt-4" />
          <Skeleton className="h-20 w-full mt-3" />
        </Card>
      ))}
    </div>
  );
}

export function ComplianceEditor() {
  const { id } = useParams<{ id: string }>();
  const isNew = !id;
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { can, meta: ctxMeta } = useCompliance();
  const { timezone } = useSettings();

  const metaFallback = useApi<Meta>(ctxMeta ? null : "/compliance/meta");
  const meta = ctxMeta ?? metaFallback.data;
  const defQ = useApi<ComplianceDef>(isNew ? null : `/compliance/definitions/${id}`);
  const lk = useLookup();
  const cats = useApi<string[]>("/compliance/categories");

  const [def, setDef] = useState<ComplianceDef | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [baseline, setBaseline] = useState("");
  const baselinePayload = useRef<Record<string, unknown>>({});
  const [attempt, setAttempt] = useState<null | "save" | "publish">(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "publish" | null>(null);
  const [applyExisting, setApplyExisting] = useState(false);

  // ---- initial state: a new compliance starts from the default type; an existing one from the server
  const adopt = (d: ComplianceDef | null, f: FormState) => {
    const payload = toPayload(f, timezone);
    baselinePayload.current = payload;
    setBaseline(stable(payload));
    setDef(d);
    setForm(f);
  };

  useEffect(() => {
    if (form || !meta) return;
    if (isNew) {
      const type = meta.types.find((t) => t.key === "general") ?? meta.types[0];
      const base = emptyForm();
      adopt(null, type ? applyTypeDefaults(base, type, meta.escalation_presets) : base);
    } else if (defQ.data) {
      adopt(defQ.data, formFromDef(defQ.data, timezone));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, defQ.data, isNew, form]);

  const payload = useMemo(() => (form ? toPayload(form, timezone) : null), [form, timezone]);
  const dirty = Boolean(payload) && stable(payload) !== baseline;
  const allowNext = useUnsavedGuard(dirty);

  const issues = useMemo(() => (form ? validate(form, timezone) : []), [form, timezone]);
  const saveIssues = issues.filter((i) => i.level === "save");
  // Problems only show once someone has tried to save or publish; a failed "save" only counts the ones that block saving.
  const shown = useMemo(() => (attempt ? issues.filter((i) => attempt === "publish" || i.level === "save") : []), [issues, attempt]);
  const submitted = attempt !== null;
  const sectionHasIssue = (s: SectionId) => shown.some((i) => i.section === s);

  const readOnly = !isNew && Boolean(def) && !def!.can?.edit;
  const audienceReadOnly = readOnly || (!isNew && Boolean(def?.can) && !def!.can!.assign);
  const preview = useAudiencePreview(form?.audience ?? [], Boolean(form) && !readOnly);
  const people = useMemo(() => peopleOptions(lk.lookup ?? null), [lk.lookup]);
  const live = def?.status === "published" || def?.status === "paused";
  const canPublish = (isNew || def?.status === "draft") && can("compliance", "assign") && (isNew || Boolean(def?.can?.assign));

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => (f ? { ...f, [key]: value } : f));
  const fieldError = (field: string) => shown.find((i) => i.field === field)?.message;

  const goToFirstIssue = (list: typeof issues) => {
    const first = SECTIONS.find((s) => list.some((i) => i.section === s.id));
    if (first) document.getElementById(`sec-${first.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // ---- type change: new compliance picks up the type's defaults, asking first if that would overwrite edits
  const changeType = (key: string) => {
    if (!form || !meta) return;
    const next = meta.types.find((t) => t.key === key);
    if (!next) return;
    if (!isNew) return set("type_key", key);
    const current = meta.types.find((t) => t.key === form.type_key);
    if (differsFromType(form, current, meta.escalation_presets)) {
      confirm({
        title: `Use the defaults for “${next.name}”?`,
        description: "You've changed the proof, review or reminder settings. Switching to this type can replace them with the type's usual setup.",
        confirm: "Replace with its defaults",
        alternate: { label: "Keep my settings", onChoose: () => setForm((f) => (f ? { ...f, type_key: key } : f)) },
        onConfirm: () => setForm((f) => (f ? applyTypeDefaults(f, next, meta.escalation_presets) : f)),
      });
    } else {
      setForm(applyTypeDefaults(form, next, meta.escalation_presets));
    }
  };

  // ---- saving
  /** Creates or updates; resolves to the saved compliance, or null if nothing needed saving. */
  async function persist(): Promise<ComplianceDef | null> {
    if (!form || !payload) return null;
    if (isNew) return api.post<ComplianceDef>("/compliance/definitions", payload);
    const diff = changedFields(payload, baselinePayload.current);
    if (Object.keys(diff).length === 0) return null;
    return api.patch<ComplianceDef>(`/compliance/definitions/${id}${live && applyExisting ? "?apply_to_existing=true" : ""}`, diff);
  }

  function blocked(level: "save" | "publish"): boolean {
    setAttempt(level);
    const list = level === "save" ? saveIssues : issues;
    if (list.length === 0) return false;
    toast.error(list.length === 1 ? "One thing needs fixing" : `${list.length} things need fixing`, { description: list[0].message });
    goToFirstIssue(list);
    return true;
  }

  async function save() {
    if (!form || blocked("save")) return;
    setBusy("save");
    setServerError(null);
    try {
      const saved = await persist();
      if (isNew && saved) {
        toast.success("Draft saved", { description: saved.name });
        allowNext();
        navigate(`/compliance/library/${saved.id}/edit`, { replace: true });
        return;
      }
      if (saved) {
        const versionUp = def && saved.current_version > def.current_version;
        toast.success("Changes saved", { description: versionUp ? `Saved as version ${saved.current_version}.` : undefined });
        adopt(saved, formFromDef(saved, timezone));
        setApplyExisting(false);
        setAttempt(null);
      }
    } catch (e) {
      setServerError(errText(e));
      toastError("Couldn't save", e);
    } finally {
      setBusy(null);
    }
  }

  async function publish() {
    if (!form || blocked("publish")) return;
    setBusy("publish");
    setServerError(null);
    let target = def;
    try {
      if (isNew || dirty) {
        const saved = await persist();
        if (saved) {
          target = saved;
          if (!isNew) adopt(saved, formFromDef(saved, timezone));
        }
      }
      if (!target) throw new Error("There is nothing to publish yet");
      const r = await api.post<{ result: { added: number; total?: number }; compliance: ComplianceDef }>(`/compliance/definitions/${target.id}/publish`);
      const n = r.result.total ?? r.result.added;
      toast.success(`Published to ${n} ${n === 1 ? "person" : "people"}`, { description: target.name });
      allowNext();
      navigate(`/compliance/library/${target.id}`);
    } catch (e) {
      setServerError(errText(e));
      toastError("Couldn't publish", e);
      if (isNew && target) {
        // It was created as a draft before publishing failed: carry on from that draft so a retry doesn't duplicate it.
        allowNext();
        navigate(`/compliance/library/${target.id}/edit`, { replace: true });
      }
    } finally {
      setBusy(null);
    }
  }

  function cancel() {
    navigate(isNew ? "/compliance/library" : `/compliance/library/${id}`);
  }

  // ---- early states
  if (isNew && !can("compliance", "create")) {
    return (
      <div>
        <PageHeader title="New compliance" breadcrumbs={[{ label: "Compliance library", to: "/compliance/library" }, { label: "New" }]} />
        <Card>
          <EmptyState icon={Lock} title="You can't create compliance" description="Ask a compliance admin to give you permission to create it." action={<Button onClick={cancel}>Back to the library</Button>} />
        </Card>
      </div>
    );
  }
  if (!isNew && defQ.error && !defQ.data) {
    return (
      <div>
        <PageHeader title="Edit compliance" breadcrumbs={[{ label: "Compliance library", to: "/compliance/library" }, { label: "Edit" }]} />
        <Card>
          <ErrorState title="This compliance couldn't be opened" message={defQ.error.message} onRetry={defQ.reload} />
        </Card>
      </div>
    );
  }
  if (!meta && metaFallback.error) {
    return (
      <Card>
        <ErrorState title="The form options couldn't be loaded" message={metaFallback.error.message} onRetry={metaFallback.reload} />
      </Card>
    );
  }
  if (!form || !meta) {
    return (
      <div>
        <PageHeader title={isNew ? "New compliance" : "Edit compliance"} breadcrumbs={[{ label: "Compliance library", to: "/compliance/library" }, { label: isNew ? "New" : "Edit" }]} />
        <FormSkeleton />
      </div>
    );
  }

  const type = meta.types.find((t) => t.key === form.type_key);
  const due = form.due_at ? zonedInputToInstant(form.due_at, timezone) : null;
  const dueInPast = Boolean(due && due.at.getTime() < Date.now() && (isNew || payload?.due_at !== baselinePayload.current.due_at));
  const categories = (cats.data ?? []).filter(Boolean);
  const title = isNew ? "New compliance" : `Edit: ${def?.name ?? ""}`;
  const policyNeedsNumber = form.completion_policy === "at_least_n" || form.completion_policy === "percentage";
  const closed = def?.status === "closed" || def?.status === "archived";

  return (
    <div>
      <PageHeader
        title={title}
        description={isNew ? "Set out what is asked, of whom, by when, and what proof counts. Nothing is sent until you publish." : undefined}
        breadcrumbs={[
          { label: "Compliance library", to: "/compliance/library" },
          ...(def ? [{ label: def.name, to: `/compliance/library/${def.id}` }] : []),
          { label: isNew ? "New" : "Edit" },
        ]}
      />

      {readOnly && (
        <Banner tone="warn" icon={Lock} className="mb-4" title={closed ? `This compliance is ${def?.status}` : "You can't edit this compliance"} action={<Button size="sm" onClick={cancel}>Back to details</Button>}>
          {closed ? "Closed and archived compliance is kept as it was, so it can't be changed." : "You can look at its settings but not change them."}
        </Banner>
      )}
      {def?.status === "draft" && !readOnly && (
        <Banner tone="info" className="mb-4" title="This is a draft">
          Nobody has been asked to do anything yet. Finish the sections below, then publish to assign it.
        </Banner>
      )}
      {live && !readOnly && (
        <Banner tone="warn" className="mb-4" title="This compliance is live">
          <p>People are already working on it. Saving changes to the deadline, proof, review or completion rules creates version {def!.current_version + 1}; people who started keep the version they began on unless you move them.</p>
          <label className="flex items-start gap-2 mt-2 text-sm text-ink cursor-pointer">
            <input type="checkbox" checked={applyExisting} onChange={(e) => setApplyExisting(e.target.checked)} className="mt-0.5 accent-[var(--accent)]" />
            <span>Move people who haven't finished onto the new version and deadline</span>
          </label>
        </Banner>
      )}

      <div className="lg:grid lg:grid-cols-[190px_minmax(0,1fr)] lg:gap-8">
        <nav aria-label="Sections" className="hidden lg:block">
          <ol className="sticky top-20 flex flex-col gap-0.5">
            {SECTIONS.map((s, i) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => document.getElementById(`sec-${s.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                  className="w-full flex items-center gap-2.5 px-2 h-8 rounded-md text-left text-[13px] text-ink2 hover:text-ink hover:bg-panel2"
                >
                  <span className="w-5 h-5 rounded-full border border-line text-[11px] font-semibold flex items-center justify-center flex-none">{i + 1}</span>
                  <span className="truncate flex-1">{s.label}</span>
                  {sectionHasIssue(s.id) && (
                    <>
                      <AlertCircle size={14} className="text-crit flex-none" aria-hidden />
                      <span className="sr-only">has something to fix</span>
                    </>
                  )}
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          className="min-w-0"
        >
          <fieldset disabled={readOnly} className="min-w-0 border-0 p-0 m-0 flex flex-col gap-5">
            <legend className="sr-only">Compliance settings</legend>

            <Section id="basics" step={1} title="Basics" description="What this is and what each person has to do.">
              <div className="flex flex-col gap-4">
                <Field label="Name" required error={fieldError("name")}>
                  {(fid) => <TextInput id={fid} value={form.name} invalid={Boolean(fieldError("name"))} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Annual security awareness training" maxLength={200} />}
                </Field>
                <Field label="Description" hint="Shown to everyone it applies to. Say why it matters.">
                  {(fid) => <Textarea id={fid} value={form.description} onChange={(e) => set("description", e.target.value)} rows={3} />}
                </Field>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="Category" hint="Type your own or pick one already in use.">
                    {(fid) => (
                      <>
                        <TextInput id={fid} list="compliance-categories" value={form.category} onChange={(e) => set("category", e.target.value)} placeholder="e.g. Security" />
                        <datalist id="compliance-categories">
                          {categories.map((c) => (
                            <option key={c} value={c} />
                          ))}
                        </datalist>
                      </>
                    )}
                  </Field>
                  <Field label="Type" hint={type?.description}>
                    {(fid) => (
                      <Select id={fid} value={form.type_key} onChange={(e) => changeType(e.target.value)} className="w-full">
                        {meta.types.map((t) => (
                          <option key={t.key} value={t.key}>
                            {t.name}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label="Priority">
                    {(fid) => (
                      <Select id={fid} value={form.priority} onChange={(e) => set("priority", e.target.value as Priority)} className="w-full">
                        {meta.priorities.map((p) => (
                          <option key={p} value={p}>
                            {PRIORITY_LABEL[p]}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                </div>
                <Field label="What people have to do" hint="Say exactly what to do, for example “Repost the launch announcement on LinkedIn”.">
                  {(fid) => <Textarea id={fid} value={form.action_text} onChange={(e) => set("action_text", e.target.value)} rows={2} />}
                </Field>
              </div>
            </Section>

            <Section id="deadline" step={2} title="Deadline" description="When people can start and when it is due. Reminders are set up in the last section.">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Starts" hint="Optional. Leave empty to start as soon as it is published.">
                  {(fid) => <TextInput id={fid} type="datetime-local" value={form.start_at} onChange={(e) => set("start_at", e.target.value)} />}
                </Field>
                <Field label="Due" error={fieldError("due_at")} hint={dueInPast ? undefined : "Optional. Without a deadline nobody can be late."}>
                  {(fid) => (
                    <>
                      <TextInput id={fid} type="datetime-local" value={form.due_at} invalid={Boolean(fieldError("due_at"))} onChange={(e) => set("due_at", e.target.value)} />
                      <div className="flex flex-wrap gap-1.5">
                        {[
                          ["In 1 week", 7],
                          ["In 2 weeks", 14],
                          ["In 30 days", 30],
                        ].map(([label, days]) => (
                          <Button key={label} size="sm" variant="outline" onClick={() => set("due_at", inDaysInput(days as number, timezone, form.due_at))}>
                            {label}
                          </Button>
                        ))}
                        {form.due_at && (
                          <Button size="sm" variant="ghost" onClick={() => set("due_at", "")}>
                            Clear
                          </Button>
                        )}
                      </div>
                      {dueInPast && <p className="text-xs text-warn">That time has already passed, so people would be late as soon as it is published.</p>}
                    </>
                  )}
                </Field>
              </div>
              <p className="text-[13px] text-ink2 mt-3">
                Times are in the organization time zone, <span className="font-semibold text-ink">{timezone}</span> ({utcOffsetLabel(timezone)}).
                {due && (
                  <>
                    {" "}
                    The deadline is <span className="font-semibold text-ink">{fmtDateTime(due.at.toISOString())}</span>.
                  </>
                )}
              </p>
            </Section>

            <Section id="audience" step={3} title="Who it applies to" description="Build the list of people from teams, departments, roles or names.">
              <fieldset disabled={audienceReadOnly} className="min-w-0 border-0 p-0 m-0">
                <legend className="sr-only">Audience</legend>
                {audienceReadOnly && !readOnly && (
                  <Banner tone="info" className="mb-4">
                    You can edit this compliance but not change who it is assigned to.
                  </Banner>
                )}
                <AudienceBuilder
                  rules={form.audience}
                  onChange={(r) => set("audience", r)}
                  lookup={lk.lookup ?? null}
                  lookupError={lk.error?.message ?? null}
                  onRetryLookup={lk.reload}
                  meta={meta}
                  dynamic={form.dynamic_audience}
                  onDynamic={(v) => set("dynamic_audience", v)}
                  preview={preview}
                  issues={shown}
                  readOnly={audienceReadOnly}
                  showErrors={submitted}
                />
              </fieldset>
            </Section>

            <Section id="proof" step={4} title="What counts as proof" description="What each person has to provide when they say they have done it.">
              <EvidenceBuilder items={form.evidence} onChange={(v) => set("evidence", v)} issues={shown} showErrors={submitted} readOnly={readOnly} />
            </Section>

            <Section id="review" step={5} title="Review" description="Who checks the proof, and how many second chances people get.">
              <div className="flex flex-col gap-4">
                <RadioCards
                  legend="Who reviews submissions"
                  value={form.review_mode}
                  onChange={(v: ReviewMode) => set("review_mode", v)}
                  options={meta.review_modes.map((m) => ({ value: m, label: REVIEW_MODE_LABEL[m], description: REVIEW_MODE_HELP[m] }))}
                />
                {form.review_mode === "named" && (
                  <Field label="Reviewer" required error={fieldError("reviewer")} className="max-w-md">
                    {(fid) => (
                      <Combobox
                        id={fid}
                        value={form.reviewer_email}
                        onChange={(v) => set("reviewer_email", v)}
                        options={people}
                        placeholder="Choose a person…"
                        invalid={Boolean(fieldError("reviewer"))}
                        emptyText={lk.lookup ? "Nobody matches" : "The list couldn't be loaded"}
                        disabled={readOnly}
                      />
                    )}
                  </Field>
                )}
                {form.review_mode !== "none" && (
                  <Field label="Times someone may resubmit" hint="After the reviewer sends it back. 0 means one try only." error={fieldError("max_resubmissions")} className="max-w-[220px]">
                    {(fid) => (
                      <TextInput id={fid} type="number" min={0} max={20} value={form.max_resubmissions} invalid={Boolean(fieldError("max_resubmissions"))} onChange={(e) => set("max_resubmissions", e.target.value)} />
                    )}
                  </Field>
                )}
              </div>
            </Section>

            <Section id="completion" step={6} title="Completion rule" description="When the compliance as a whole counts as met.">
              <div className="flex flex-col gap-4">
                <RadioCards
                  legend="Completion rule"
                  value={form.completion_policy}
                  onChange={(v: CompletionPolicy) => set("completion_policy", v)}
                  options={meta.completion_policies.map((p) => ({ value: p, label: COMPLETION_LABEL[p], description: COMPLETION_HELP[p] }))}
                />
                {policyNeedsNumber && (
                  <Field
                    label={form.completion_policy === "percentage" ? "Percentage of people" : "Number of people"}
                    required
                    error={fieldError("completion_param")}
                    hint={form.completion_policy === "percentage" ? "A whole number from 1 to 100." : "At least 1."}
                    className="max-w-[220px]"
                  >
                    {(fid) => (
                      <TextInput
                        id={fid}
                        type="number"
                        min={1}
                        max={form.completion_policy === "percentage" ? 100 : undefined}
                        value={form.completion_param}
                        invalid={Boolean(fieldError("completion_param"))}
                        onChange={(e) => set("completion_param", e.target.value)}
                        trailingVisual={form.completion_policy === "percentage" ? <span className="text-ink2 text-sm">%</span> : undefined}
                      />
                    )}
                  </Field>
                )}
                <p className="text-[13px] text-ink2">
                  In words: <span className="font-semibold text-ink">{completionText({ completion_policy: form.completion_policy, completion_param: Number(form.completion_param) || null })}</span>. Only people marked “Must act” count.
                </p>
              </div>
            </Section>

            <Section id="escalation" step={7} title="Reminders and escalation" description="What happens automatically when people are slow.">
              <EscalationBuilder
                rules={form.escalation}
                onChange={(v) => set("escalation", v)}
                meta={meta}
                people={people}
                nameOf={lk.nameOf}
                issues={shown}
                showErrors={submitted}
                readOnly={readOnly}
              />
            </Section>
          </fieldset>

          {/* sticky summary and actions */}
          <div className="sticky bottom-3 z-20 mt-6 mr-[72px] flex flex-col gap-2">
            {serverError && (
              <Banner tone="crit" title="The server didn't accept that" onDismiss={() => setServerError(null)} className="shadow-md">
                {serverError}
              </Banner>
            )}
            <div className="rounded-xl border border-line bg-panel shadow-lg px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="min-w-0 flex-1 text-[13px] text-ink2" aria-live="polite">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                  <span className={clsx("inline-flex items-center gap-1.5 font-semibold", dirty ? "text-warn" : "text-ink2")}>
                    <span className={clsx("w-1.5 h-1.5 rounded-full", dirty ? "bg-warn" : "bg-good")} aria-hidden />
                    {dirty ? "Unsaved changes" : isNew ? "Nothing entered yet" : "All changes saved"}
                  </span>
                  <span>{preview.data ? `Reaches ${preview.data.total} ${preview.data.total === 1 ? "person" : "people"}` : "Audience not set"}</span>
                  <span>{due ? `Due ${fmtDateTime(due.at.toISOString())}` : "No deadline"}</span>
                  {shown.length > 0 && <span className="text-crit font-semibold">{shown.length} to fix</span>}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 ml-auto">
                <Button onClick={cancel} disabled={busy !== null}>
                  {readOnly ? "Back" : "Cancel"}
                </Button>
                {!readOnly && (
                  <Button type="submit" leadingIcon={Save} loading={busy === "save"} disabled={busy === "publish" || (!isNew && !dirty)}>
                    {live ? "Save changes" : "Save draft"}
                  </Button>
                )}
                {!readOnly && canPublish && (
                  <Button variant="primary" leadingIcon={Rocket} loading={busy === "publish"} disabled={busy === "save"} onClick={() => void publish()}>
                    Publish
                  </Button>
                )}
              </div>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
