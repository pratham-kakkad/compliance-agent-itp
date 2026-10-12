import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { toast } from "sonner";
import { ArrowLeft, Copy, Mail, MailPlus, Power, RotateCcw, Save, Send, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { useApi } from "../../lib/useApi";
import { useCompliance } from "../../lib/ComplianceContext";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { KIND_LABEL, KIND_ORDER, type EmailTemplate, type TemplateKind, type VariablesResponse } from "../../lib/emailTemplates";
import { Banner, Button, Card, EmptyState, ErrorState, Label, PageHeader, Select, Skeleton, TextInput } from "../../components/ui";
import { Field, errText, toastError } from "../../components/compliance/common";
import { NoAccess, useConfirm } from "../../components/compliance/admin/parts";
import { KindChip } from "../../components/compliance/email/KindChip";
import { PreviewFrame } from "../../components/compliance/email/PreviewFrame";
import { useVariableInsert } from "../../components/compliance/email/useVariableInsert";
import { InsertVariableMenu } from "../../components/compliance/email/VariableMenu";

interface Draft {
  name: string;
  kind: TemplateKind;
  description: string;
  subject: string;
  body: string;
}

const BLANK: Draft = { name: "", kind: "custom", description: "", subject: "", body: "" };
const draftOf = (t: EmailTemplate): Draft => ({ name: t.name, kind: t.kind, description: t.description, subject: t.subject, body: t.body });
const sameDraft = (a: Draft, b: Draft) => a.name === b.name && a.kind === b.kind && a.description === b.description && a.subject === b.subject && a.body === b.body;

interface Rendered {
  subject: string;
  text: string;
  html: string;
  unknown: string[];
}

// -------------------------------------------------------------------- list

function TemplateList({
  templates,
  selected,
  onSelect,
}: {
  templates: EmailTemplate[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const sorted = useMemo(
    () => [...templates].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || Number(b.is_system) - Number(a.is_system) || a.name.localeCompare(b.name)),
    [templates]
  );
  return (
    <ul className="flex flex-col gap-1.5 p-2" aria-label="Templates">
      {sorted.map((t) => {
        const active = t.id === selected;
        return (
          <li key={t.id}>
            <button
              type="button"
              onClick={() => onSelect(t.id)}
              aria-current={active ? "true" : undefined}
              className={clsx(
                "w-full text-left rounded-lg border px-3 py-2.5 flex flex-col gap-1.5 transition-colors",
                active ? "border-accent bg-accent-soft" : "border-transparent hover:bg-panel2",
                !t.active && "opacity-70"
              )}
            >
              <span className="flex items-center gap-2 min-w-0">
                <span className="text-sm font-semibold text-ink truncate">{t.name}</span>
                <span className="ml-auto flex items-center gap-1.5 flex-none">
                  {!t.active && <Label size="sm">Off</Label>}
                  <KindChip kind={t.kind} size="sm" />
                </span>
              </span>
              <span className="text-xs text-ink2 truncate" title={t.subject}>
                {t.subject}
              </span>
              <span className="flex items-center gap-1.5 text-[11px] text-ink3">
                {t.is_system ? "Built-in" : "Custom"}
                {t.modified && <span aria-label="Edited from the default">· Edited</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ------------------------------------------------------------------ editor

function Editor({
  template,
  seed,
  vars,
  onSaved,
  onDeleted,
  onDuplicate,
  onBack,
}: {
  template: EmailTemplate | null;
  seed: Draft | null;
  vars: VariablesResponse | null;
  onSaved: (t: EmailTemplate) => void;
  onDeleted: () => void;
  onDuplicate: (d: Draft) => void;
  onBack: () => void;
}) {
  const confirm = useConfirm();
  const baseline = template ? draftOf(template) : (seed ?? BLANK);
  const [draft, setDraft] = useState<Draft>(baseline);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const dirty = !sameDraft(draft, baseline);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const { subjectRef, bodyRef, fieldProps, insert, refocus } = useVariableInsert(draft.subject, (v) => set("subject", v), draft.body, (v) => set("body", v));

  // live preview with sample data
  const key = useDebouncedValue(JSON.stringify([draft.subject, draft.body, draft.kind]), 300);
  useEffect(() => {
    let alive = true;
    api
      .post<Rendered>("/compliance/admin/email-templates/preview", { subject: draft.subject, body: draft.body, kind: draft.kind })
      .then((r) => {
        if (!alive) return;
        setRendered(r);
        setRenderError(null);
      })
      .catch((e) => alive && setRenderError(errText(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const unknown = rendered?.unknown ?? [];
  const invalid = !draft.name.trim() || !draft.subject.trim() || !draft.body.trim() || unknown.length > 0;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const body = { name: draft.name, kind: draft.kind, description: draft.description, subject: draft.subject, body: draft.body };
      const t = template ? await api.patch<EmailTemplate>(`/compliance/admin/email-templates/${template.id}`, body) : await api.post<EmailTemplate>("/compliance/admin/email-templates", body);
      toast.success(template ? "Template saved" : "Template created");
      onSaved(t);
    } catch (e) {
      setError(errText(e));
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive() {
    if (!template) return;
    setBusy("active");
    try {
      const t = await api.patch<EmailTemplate>(`/compliance/admin/email-templates/${template.id}`, { active: !template.active });
      toast.success(t.active ? "Template turned on" : "Template turned off", { description: t.active ? "Senders can pick it again." : "Senders can no longer pick it." });
      onSaved(t);
    } catch (e) {
      toastError("That didn't work", e);
    } finally {
      setBusy(null);
    }
  }

  async function sendTest() {
    setBusy("test");
    try {
      const r = await api.post<{ ok: boolean; to?: string; error?: string }>("/compliance/admin/email-templates/test", { subject: draft.subject, body: draft.body, kind: draft.kind });
      if (r.ok) toast.success(`Test sent to ${r.to}`, { description: "It uses sample data, so the name and dates are made up." });
      else toast.error("The test didn't send", { description: r.error });
    } catch (e) {
      toastError("The test didn't send", e);
    } finally {
      setBusy(null);
    }
  }

  function reset() {
    if (!template) return;
    confirm({
      title: `Reset "${template.name}" to its default?`,
      description: <p>Your edits to this built-in template are replaced by the original wording, and it is turned on again.</p>,
      confirm: "Reset to default",
      tone: "primary",
      onConfirm: async () => {
        const t = await api.post<EmailTemplate>(`/compliance/admin/email-templates/${template.id}/reset`);
        toast.success("Template reset");
        onSaved(t);
      },
    });
  }

  function remove() {
    if (!template) return;
    confirm({
      title: `Delete "${template.name}"?`,
      description: <p>It can't be picked any more. Messages already sent keep their text in the history.</p>,
      confirm: "Delete template",
      onConfirm: async () => {
        await api.delete(`/compliance/admin/email-templates/${template.id}`);
        toast.success("Template deleted");
        onDeleted();
      },
    });
  }

  return (
    <Card padding="none" className="overflow-hidden min-w-0">
      <div className="p-4 pb-3 flex flex-col gap-3">
        <button type="button" onClick={onBack} className="lg:hidden self-start inline-flex items-center gap-1.5 text-sm text-accent hover:underline">
          <ArrowLeft size={14} aria-hidden /> All templates
        </button>
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0 flex-1 basis-64">
            <h2 className="text-sm font-semibold text-ink leading-5 inline-flex flex-wrap items-center gap-2">
              {template ? template.name : "New template"}
              <KindChip kind={draft.kind} size="sm" />
              {template?.is_system && <Label size="sm">Built-in</Label>}
              {template && !template.active && <Label size="sm">Off</Label>}
            </h2>
            <p className="text-[13px] text-ink2 mt-0.5 leading-[18px]">
              {template ? (template.is_system ? "Built-in templates can be edited but not deleted. Reset to default undoes your edits." : "Custom template.") : "Write it once, then pick it whenever you e-mail someone."}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {template && (
              <Button size="sm" leadingIcon={Power} loading={busy === "active"} onClick={() => void toggleActive()}>
                {template.active ? "Turn off" : "Turn on"}
              </Button>
            )}
            <Button size="sm" leadingIcon={Copy} onClick={() => onDuplicate({ ...draft, name: `${draft.name} (copy)` })} disabled={!draft.subject}>
              Duplicate
            </Button>
          </div>
        </div>
      </div>

      <div className="border-t border-line p-4 grid 2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-6 gap-y-5">
        <div className="flex flex-col gap-4 min-w-0">
          <div className="grid sm:grid-cols-[minmax(0,1fr)_180px] gap-3">
            <Field label="Name" required>
              {(id) => <TextInput id={id} value={draft.name} maxLength={80} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Second reminder" />}
            </Field>
            <Field label="Kind" hint="Sets the colour of the label.">
              {(id) => (
                <Select id={id} value={draft.kind} onChange={(e) => set("kind", e.target.value as TemplateKind)} className="w-full">
                  {KIND_ORDER.map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABEL[k]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <Field label="Description" hint="Shown to people when they choose a template.">
            {(id) => <TextInput id={id} value={draft.description} onChange={(e) => set("description", e.target.value)} placeholder="When to use it" />}
          </Field>

          <div className="flex flex-col gap-2">
            <div className="flex items-end justify-between gap-2">
              <span className="text-[13px] font-semibold text-ink">Message</span>
              <InsertVariableMenu variables={vars?.variables ?? []} onInsert={insert} onClosed={refocus} />
            </div>
            <TextInput
              ref={subjectRef}
              aria-label="Subject"
              placeholder="Subject, e.g. Friendly reminder: {{compliance_name}}"
              value={draft.subject}
              onChange={(e) => set("subject", e.target.value.replace(/\n/g, " "))}
              {...fieldProps("subject")}
            />
            <textarea
              ref={bodyRef}
              aria-label="Message"
              rows={14}
              value={draft.body}
              placeholder={"Hi {{first_name}},\n\nWrite in plain text. Leave a blank line between paragraphs. Put each list item on its own line starting with a dash."}
              onChange={(e) => set("body", e.target.value)}
              {...fieldProps("body")}
              className="field px-3 py-2 text-sm leading-5 resize-y min-h-[200px] font-sans"
            />
            <p className="text-xs text-ink2">
              Plain text with {"{{variables}}"}; no code runs. The e-mail gets the Encop layout and an "Open in Encop" button automatically.
            </p>
            {unknown.length > 0 && (
              <Banner tone="warn" title="Unknown variables">
                {unknown.map((u) => `{{${u}}}`).join(", ")} can't be filled in, so this can't be saved. Use Insert variable to pick from the list.
              </Banner>
            )}
          </div>
          {error && <Banner tone="crit">{error}</Banner>}
        </div>

        <div className="flex flex-col gap-2 min-w-0">
          <h3 className="text-sm font-semibold text-ink">Preview</h3>
          <p className="text-xs text-ink2 -mt-1">With sample data: Alex Morgan, "Annual Security Training", 3 days overdue.</p>
          {renderError ? (
            <Banner tone="crit">{renderError}</Banner>
          ) : rendered ? (
            <PreviewFrame subject={rendered.subject} html={rendered.html} text={rendered.text} heightClass="h-[480px] 2xl:h-[560px]" />
          ) : (
            <Skeleton className="h-[520px] w-full" />
          )}
        </div>
      </div>

      <div className="border-t border-line bg-panel px-4 py-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" leadingIcon={Save} loading={saving} disabled={!dirty || invalid} onClick={() => void save()}>
          {template ? "Save changes" : "Create template"}
        </Button>
        {dirty && template && (
          <Button onClick={() => setDraft(baseline)} disabled={saving}>
            Discard changes
          </Button>
        )}
        <Button leadingIcon={Send} loading={busy === "test"} disabled={!draft.subject.trim() || !draft.body.trim() || unknown.length > 0} onClick={() => void sendTest()}>
          Send me a test
        </Button>
        <span className="ml-auto flex flex-wrap gap-2">
          {template?.is_system && template.modified && (
            <Button leadingIcon={RotateCcw} onClick={reset}>
              Reset to default
            </Button>
          )}
          {template && !template.is_system && (
            <Button variant="danger" leadingIcon={Trash2} onClick={remove}>
              Delete
            </Button>
          )}
        </span>
      </div>
    </Card>
  );
}

// -------------------------------------------------------------------- page

export function AdminEmailTemplates() {
  const { can, ready } = useCompliance();
  const allowed = can("compliance", "configure");
  const list = useApi<EmailTemplate[]>(allowed ? "/compliance/admin/email-templates" : null);
  const vars = useApi<VariablesResponse>(allowed ? "/compliance/email-variables" : null);
  const [sel, setSel] = useState<string | null>(null); // a template id, or "new"
  const [seed, setSeed] = useState<Draft | null>(null);
  const [counter, setCounter] = useState(0); // remounts the editor when a new draft starts

  const templates = list.data ?? [];
  const current = sel && sel !== "new" ? (templates.find((t) => t.id === sel) ?? null) : null;

  // On a wide screen show the first template at once; on a phone start with the list.
  useEffect(() => {
    if (sel === null && templates.length > 0 && window.matchMedia("(min-width: 1024px)").matches) setSel(templates[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templates.length]);

  if (!ready) return <div><PageHeader title="Email templates" /><Skeleton className="h-64 w-full" /></div>;
  if (!allowed) return <div><PageHeader title="Email templates" /><NoAccess what="manage e-mail templates" /></div>;

  function startNew(d: Draft | null) {
    setSeed(d);
    setSel("new");
    setCounter((c) => c + 1);
  }

  return (
    <div>
      <PageHeader
        title="Email templates"
        description="Reusable messages for e-mailing people about their compliance. Anyone who can e-mail people can pick the ones that are turned on."
      />

      {list.error && !list.data ? (
        <Card>
          <ErrorState message={list.error.message} onRetry={list.reload} />
        </Card>
      ) : list.initialLoading ? (
        <div className="grid lg:grid-cols-[320px_minmax(0,1fr)] gap-4" aria-busy="true">
          <Card><Skeleton className="h-72 w-full" /></Card>
          <Card className="hidden lg:block"><Skeleton className="h-72 w-full" /></Card>
        </div>
      ) : (
        <div className="grid lg:grid-cols-[320px_minmax(0,1fr)] gap-4 items-start">
          <Card padding="none" className={clsx("overflow-hidden", sel !== null && "hidden lg:block")}>
            <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-1">
              <h2 className="text-sm font-semibold text-ink">Templates</h2>
              <Button size="sm" variant="primary" leadingIcon={MailPlus} onClick={() => startNew(null)}>
                New template
              </Button>
            </div>
            <TemplateList templates={templates} selected={sel === "new" ? null : sel} onSelect={setSel} />
            {templates.length === 0 && <EmptyState compact icon={Mail} title="No templates yet" description="Create the first one." />}
          </Card>

          <div className={clsx("min-w-0", sel === null && "hidden lg:block")}>
            {sel === null ? (
              <Card>
                <EmptyState icon={Mail} title="Pick a template to edit" description="Or create a new one. The preview updates as you type." />
              </Card>
            ) : sel === "new" || current ? (
              <Editor
                key={`${sel}:${counter}:${current?.updated_at ?? ""}`}
                template={current}
                seed={seed}
                vars={vars.data ?? null}
                onSaved={(t) => {
                  list.reload();
                  setSel(t.id);
                  setSeed(null);
                }}
                onDeleted={() => {
                  list.reload();
                  setSel(null);
                }}
                onDuplicate={(d) => startNew(d)}
                onBack={() => setSel(null)}
              />
            ) : (
              <Card>
                <EmptyState icon={Mail} title="That template isn't there any more" action={<Button onClick={() => setSel(null)}>Back</Button>} />
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
