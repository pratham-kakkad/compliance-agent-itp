/**
 * Record rules: row-level conditions layered on top of role scopes. This file holds the list, the
 * create / edit dialog and the condition builder. Condition grammar (see app/compliance/policy.py):
 * a leaf {field, op, value} (value is a list for in / not_in) or {all: [...]} / {any: [...]};
 * the value "$my_department" stands for the viewer's own department.
 */
import { useMemo, useState } from "react";
import clsx from "clsx";
import { toast } from "sonner";
import { Filter, Pencil, Plus, Trash2, X } from "lucide-react";
import { useApi } from "../../../lib/useApi";
import { api } from "../../../lib/api";
import { useCompliance } from "../../../lib/ComplianceContext";
import { DEFINITION_STATUS_LABEL, PARTICIPATION_LABEL, PRIORITY_LABEL } from "../../../lib/compliance";
import type { AdminRole, Meta, RecordRule } from "../../../lib/compliance";
import { Banner, Button, Card, EmptyState, ErrorState, IconButton, Label, SegmentedControl, Select, Skeleton, TextInput } from "../../ui";
import { useOverlay } from "../../Modal";
import { Field, Textarea, errText, toastError } from "../common";
import { CheckRow, ChipInput, humanize, useConfirm, useLookup } from "./parts";

type RulesResponse = { rules: RecordRule[]; fields: Record<string, string[]>; ops: string[] };
type Leaf = { field: string; op: string; values: string[] };
type Mode = "all" | "any";

const MY_DEPT = "$my_department";

const RESOURCE_LABEL: Record<string, string> = {
  compliance: "Compliance definitions",
  obligation: "Assigned items (one person's duty)",
};
const FIELD_LABEL: Record<string, string> = {
  category: "Category",
  priority: "Priority",
  type: "Compliance type",
  status: "Compliance status",
  participation: "Participation",
  department: "Person's department",
};
const OP_LABEL: Record<string, string> = { in: "is one of", not_in: "is none of", eq: "is", ne: "is not" };
const isMulti = (op: string) => op === "in" || op === "not_in";

type Option = { value: string; label: string };

/** Known values for a field, or null when it is free text. */
function fieldOptions(field: string, meta: Meta | null, departments: { id: string; name: string }[]): Option[] | null {
  if (!meta) return null;
  switch (field) {
    case "priority":
      return meta.priorities.map((p) => ({ value: p, label: PRIORITY_LABEL[p] ?? humanize(p) }));
    case "status":
      return meta.definition_statuses.map((s) => ({ value: s, label: DEFINITION_STATUS_LABEL[s] ?? humanize(s) }));
    case "participation":
      return meta.participation.map((p) => ({ value: p, label: PARTICIPATION_LABEL[p] ?? humanize(p) }));
    case "type":
      return meta.types.map((t) => ({ value: t.key, label: t.name }));
    case "department":
      return [{ value: MY_DEPT, label: "The viewer's own department" }, ...departments.map((d) => ({ value: d.id, label: d.name }))];
    default:
      return null;
  }
}

// ------------------------------------------------------------- conversion

function toLeaf(x: unknown): Leaf | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (typeof o.field !== "string") return null;
  const op = typeof o.op === "string" ? o.op : "in";
  const v = o.value;
  const values = Array.isArray(v) ? v.map(String) : v == null || v === "" ? [] : [String(v)];
  return { field: o.field, op, values };
}

/** Builder state for a stored condition, or null if it uses nesting the builder can't show. */
function parseCondition(c: unknown): { mode: Mode; items: Leaf[] } | null {
  if (!c || typeof c !== "object") return null;
  const o = c as Record<string, unknown>;
  const mode: Mode | null = Array.isArray(o.all) ? "all" : Array.isArray(o.any) ? "any" : null;
  if (mode) {
    const items = (o[mode] as unknown[]).map(toLeaf);
    return items.every(Boolean) ? { mode, items: items as Leaf[] } : null;
  }
  const leaf = toLeaf(o);
  return leaf ? { mode: "all", items: [leaf] } : null;
}

function buildCondition(mode: Mode, items: Leaf[]): Record<string, unknown> {
  const leaves = items.map((i) => ({ field: i.field, op: i.op, value: isMulti(i.op) ? i.values : i.values[0] ?? "" }));
  return leaves.length === 1 ? leaves[0] : { [mode]: leaves };
}

// ---------------------------------------------------------------- sentence

function describeCondition(c: unknown, meta: Meta | null, departments: { id: string; name: string }[], top = true): string {
  if (!c || typeof c !== "object") return "?";
  const o = c as Record<string, unknown>;
  const group: Mode | null = Array.isArray(o.all) ? "all" : Array.isArray(o.any) ? "any" : null;
  if (group) {
    const parts = (o[group] as unknown[]).map((x) => describeCondition(x, meta, departments, false));
    const text = parts.join(group === "all" ? " and " : " or ");
    return top || parts.length < 2 ? text : `(${text})`;
  }
  const leaf = toLeaf(o);
  if (!leaf) return "?";
  const opts = fieldOptions(leaf.field, meta, departments);
  const names = leaf.values.map((v) => opts?.find((x) => x.value === v)?.label ?? v);
  const op = leaf.op === "in" && names.length <= 1 ? "is" : leaf.op === "not_in" && names.length <= 1 ? "is not" : OP_LABEL[leaf.op] ?? leaf.op;
  const value = names.length === 0 ? "…" : names.length === 1 ? names[0] : names.slice(0, -1).join(", ") + " or " + names[names.length - 1];
  return `${(FIELD_LABEL[leaf.field] ?? humanize(leaf.field)).toLowerCase()} ${op} ${value}`;
}

function ruleSentence(r: RecordRule, meta: Meta | null, departments: { id: string; name: string }[]) {
  const text = describeCondition(r.condition, meta, departments);
  return r.kind === "restrictive" ? `Only shows records where ${text}.` : `Also shows records where ${text}.`;
}

// ------------------------------------------------------------ small pieces

function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx("relative w-9 h-5 rounded-full flex-none transition-colors duration-150 disabled:opacity-50", checked ? "bg-accent-emphasis" : "bg-line-strong")}
    >
      <span className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-150" style={{ transform: checked ? "translateX(16px)" : "translateX(0)" }} />
    </button>
  );
}

function ChoicePills({ options, value, onChange, label }: { options: Option[]; value: string[]; onChange: (v: string[]) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = value.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((v) => v !== o.value) : [...value, o.value])}
            className={clsx(
              "h-7 px-2.5 rounded-full border text-[13px] transition-colors",
              on ? "bg-accent-soft border-accent text-accent-strong font-semibold" : "bg-panel border-line text-ink2 hover:text-ink hover:border-line-strong"
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------ rule dialog

function RuleDialog({ rule, roles, fields, onSaved }: { rule?: RecordRule; roles: AdminRole[]; fields: Record<string, string[]>; onSaved: () => void }) {
  const { close } = useOverlay();
  const { meta } = useCompliance();
  const lookup = useLookup();
  const departments = lookup.data?.departments ?? [];

  const parsed = useMemo(() => (rule ? parseCondition(rule.condition) : { mode: "all" as Mode, items: [] as Leaf[] }), [rule]);
  const [name, setName] = useState(rule?.name ?? "");
  const [resource, setResource] = useState<string>(rule?.resource ?? "obligation");
  const [kind, setKind] = useState<"restrictive" | "allow">(rule?.kind ?? "restrictive");
  const [roleKey, setRoleKey] = useState(rule?.role_key ?? "");
  const [active, setActive] = useState(rule?.active ?? true);
  const [mode, setMode] = useState<Mode>(parsed?.mode ?? "all");
  const [items, setItems] = useState<Leaf[]>(parsed?.items ?? []);
  const [raw, setRaw] = useState(() => (parsed ? "" : JSON.stringify(rule?.condition ?? {}, null, 2)));
  const advanced = parsed === null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validFields = fields[resource] ?? [];

  function changeResource(next: string) {
    setResource(next);
    const ok = new Set(fields[next] ?? []);
    setItems((its) => its.filter((i) => ok.has(i.field)));
  }

  function patch(i: number, change: Partial<Leaf>) {
    setError(null);
    setItems((its) => its.map((it, idx) => (idx === i ? { ...it, ...change } : it)));
  }

  function addCondition() {
    const field = validFields[0];
    if (!field) return;
    setItems((its) => [...its, { field, op: "in", values: [] }]);
  }

  const condition: Record<string, unknown> | null = (() => {
    if (advanced) {
      try {
        const v = JSON.parse(raw);
        return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    }
    return items.length ? buildCondition(mode, items) : null;
  })();
  const incomplete = !advanced && items.some((i) => i.values.length === 0);
  const ready = name.trim().length > 0 && condition !== null && !incomplete;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || !condition) return;
    setBusy(true);
    setError(null);
    const body = { name: name.trim(), resource, kind, role_key: roleKey || null, condition, active };
    try {
      if (rule) await api.put(`/compliance/admin/record-rules/${rule.id}`, body);
      else await api.post("/compliance/admin/record-rules", body);
      toast.success(rule ? "Rule updated" : "Rule created");
      onSaved();
      close();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      <div className="pr-6">
        <h2 className="text-lg font-semibold text-ink">{rule ? "Edit record rule" : "New record rule"}</h2>
        <p className="text-sm text-ink2 mt-1">A rule filters which records people can see, on top of what their role's scope already allows.</p>
      </div>

      <Field label="Rule name" required>
        {(id) => <TextInput id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Managers don't see security items" />}
      </Field>

      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Applies to records of">
          {(id) => (
            <Select
              id={id}
              value={resource}
              onChange={(e) => changeResource(e.target.value)}
              className="w-full"
              options={Object.keys(fields).map((r) => ({ value: r, label: RESOURCE_LABEL[r] ?? humanize(r) }))}
            />
          )}
        </Field>
        <Field label="Who it applies to" hint="Leave on Everyone to apply it to all roles.">
          {(id) => <Select id={id} value={roleKey} onChange={(e) => setRoleKey(e.target.value)} className="w-full" options={[{ value: "", label: "Everyone" }, ...roles.map((r) => ({ value: r.key, label: r.name }))]} />}
        </Field>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-semibold text-ink" id="rule-kind-label">
          What it does
        </span>
        <SegmentedControl
          aria-label="Rule kind"
          value={kind}
          onChange={setKind}
          options={[
            { value: "restrictive", label: "Restrict" },
            { value: "allow", label: "Allow" },
          ]}
        />
        <p className="text-xs text-ink2">
          {kind === "restrictive"
            ? "Restrict narrows what people can see: they only see records that match the conditions below."
            : "Allow widens what people can see: records that match the conditions are shown in addition to what their role already reaches."}
        </p>
      </div>

      <fieldset className="flex flex-col gap-3 border border-line rounded-lg p-3">
        <legend className="px-1 text-[13px] font-semibold text-ink">Conditions</legend>
        {advanced ? (
          <>
            <Banner tone="info">This rule uses nested conditions the builder can't show, so it is edited as JSON.</Banner>
            <Field label="Condition (JSON)" hint='Leaf: {"field": "priority", "op": "in", "value": ["high"]}. Combine with {"all": [...]} or {"any": [...]}.'>
              {(id) => <Textarea id={id} rows={8} value={raw} onChange={(e) => setRaw(e.target.value)} className="font-mono text-xs" invalid={condition === null} spellCheck={false} />}
            </Field>
          </>
        ) : (
          <>
            {items.length > 1 && (
              <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink2">
                <span>Match</span>
                <SegmentedControl
                  size="sm"
                  aria-label="Combine conditions"
                  value={mode}
                  onChange={setMode}
                  options={[
                    { value: "all", label: "all" },
                    { value: "any", label: "any" },
                  ]}
                />
                <span>of these conditions</span>
              </div>
            )}
            {items.length === 0 && <p className="text-[13px] text-ink2">No conditions yet. A rule needs at least one.</p>}
            {items.map((it, i) => {
              const opts = fieldOptions(it.field, meta, departments);
              const label = `Condition ${i + 1}`;
              return (
                <div key={i} className="flex flex-col gap-2">
                  {i > 0 && <div className="text-[11px] font-semibold uppercase tracking-wide text-ink3">{mode === "all" ? "and" : "or"}</div>}
                  <div className="rounded-md border border-line bg-panel2 p-2.5 flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <Select
                        aria-label={`${label} field`}
                        value={it.field}
                        onChange={(e) => patch(i, { field: e.target.value, values: [] })}
                        className="flex-1 min-w-0"
                        options={validFields.map((f) => ({ value: f, label: FIELD_LABEL[f] ?? humanize(f) }))}
                      />
                      <Select
                        aria-label={`${label} operator`}
                        value={it.op}
                        onChange={(e) => patch(i, { op: e.target.value, values: isMulti(e.target.value) ? it.values : it.values.slice(0, 1) })}
                        className="flex-1 min-w-0"
                        options={["in", "not_in", "eq", "ne"].map((o) => ({ value: o, label: OP_LABEL[o] }))}
                      />
                      <IconButton icon={X} label={`Remove ${label.toLowerCase()}`} size="sm" onClick={() => setItems((its) => its.filter((_, idx) => idx !== i))} />
                    </div>
                    {opts ? (
                      isMulti(it.op) ? (
                        <ChoicePills label={`${label} values`} options={opts} value={it.values} onChange={(v) => patch(i, { values: v })} />
                      ) : (
                        <Select
                          aria-label={`${label} value`}
                          value={it.values[0] ?? ""}
                          onChange={(e) => patch(i, { values: e.target.value ? [e.target.value] : [] })}
                          className="w-full"
                          options={[{ value: "", label: "Choose…" }, ...opts]}
                        />
                      )
                    ) : isMulti(it.op) ? (
                      <ChipInput value={it.values} onChange={(v) => patch(i, { values: v })} placeholder="Type a value and press Enter or comma" />
                    ) : (
                      <TextInput aria-label={`${label} value`} value={it.values[0] ?? ""} onChange={(e) => patch(i, { values: e.target.value ? [e.target.value] : [] })} placeholder="Value" />
                    )}
                  </div>
                </div>
              );
            })}
            <div>
              <Button size="sm" leadingIcon={Plus} onClick={addCondition} disabled={validFields.length === 0}>
                Add condition
              </Button>
            </div>
          </>
        )}
        {condition && !incomplete && (
          <p className="text-[13px] text-ink2" aria-live="polite">
            <span className="font-semibold text-ink">In plain words: </span>
            {kind === "restrictive" ? "only shows records where " : "also shows records where "}
            {describeCondition(condition, meta, departments)}.
          </p>
        )}
        {incomplete && <p className="text-xs text-warn">Every condition needs at least one value.</p>}
      </fieldset>

      <CheckRow checked={active} onChange={setActive} title="Active" description="Inactive rules are kept but have no effect." />

      {error && (
        <p role="alert" className="text-sm text-crit">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={close} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={busy} disabled={!ready}>
          {rule ? "Save rule" : "Create rule"}
        </Button>
      </div>
    </form>
  );
}

// -------------------------------------------------------------------- list

export function RecordRulesPanel({ roles }: { roles: AdminRole[] }) {
  const { can, meta } = useCompliance();
  const canEdit = can("role", "configure");
  const { openModal } = useOverlay();
  const confirm = useConfirm();
  const { data, error, initialLoading, reload } = useApi<RulesResponse>("/compliance/admin/record-rules");
  const lookup = useLookup();
  const departments = lookup.data?.departments ?? [];
  const [toggling, setToggling] = useState<string | null>(null);

  function openRule(rule?: RecordRule) {
    if (!data) return;
    openModal(<RuleDialog rule={rule} roles={roles} fields={data.fields} onSaved={reload} />);
  }

  async function setActive(r: RecordRule, active: boolean) {
    setToggling(r.id);
    try {
      await api.put(`/compliance/admin/record-rules/${r.id}`, { name: r.name, resource: r.resource, kind: r.kind, role_key: r.role_key, condition: r.condition, active });
      toast.success(active ? `"${r.name}" is now active` : `"${r.name}" is now inactive`);
      reload();
    } catch (err) {
      toastError("Couldn't change the rule", err);
    } finally {
      setToggling(null);
    }
  }

  function remove(r: RecordRule) {
    confirm({
      title: `Delete "${r.name}"?`,
      description: <p>People will immediately see records as if this rule had never existed. This can't be undone; switch it off instead if you may want it back.</p>,
      confirm: "Delete rule",
      onConfirm: async () => {
        await api.delete(`/compliance/admin/record-rules/${r.id}`);
        toast.success(`Rule "${r.name}" deleted`);
        reload();
      },
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Banner title="How record rules work">
        A <strong className="text-ink">Restrict</strong> rule narrows what people can see: only matching records stay visible. An <strong className="text-ink">Allow</strong> rule widens it: matching
        records are shown on top of what the role's scope reaches. Super Admins are never affected.
      </Banner>

      <Card padding="none" className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 p-4 border-b border-line">
          <div>
            <h2 className="text-sm font-semibold text-ink">Record rules</h2>
            <p className="text-[13px] text-ink2">{data ? `${data.rules.length} ${data.rules.length === 1 ? "rule" : "rules"}` : "Row-level conditions"}</p>
          </div>
          {canEdit && (
            <Button variant="primary" leadingIcon={Plus} onClick={() => openRule()} disabled={!data}>
              New rule
            </Button>
          )}
        </div>

        {error && !data ? (
          <ErrorState message={error.message} onRetry={reload} />
        ) : initialLoading || !data ? (
          <div className="p-4 flex flex-col gap-3" aria-busy="true">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : data.rules.length === 0 ? (
          <EmptyState
            icon={Filter}
            title="No record rules"
            description="Without rules, people see exactly what their role's scope allows."
            action={canEdit ? <Button variant="primary" size="sm" leadingIcon={Plus} onClick={() => openRule()}>New rule</Button> : undefined}
          />
        ) : (
          <ul className="divide-y divide-line-soft">
            {data.rules.map((r) => (
              <li key={r.id} className={clsx("p-4 flex flex-col sm:flex-row sm:items-start gap-3", !r.active && "opacity-70")}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-ink">{r.name}</span>
                    {r.kind === "restrictive" ? (
                      <Label tone="warn" size="sm">
                        Restrict
                      </Label>
                    ) : (
                      <Label tone="good" size="sm">
                        Allow
                      </Label>
                    )}
                    <Label size="sm" variant="outline">
                      {RESOURCE_LABEL[r.resource] ?? humanize(r.resource)}
                    </Label>
                    <Label size="sm" variant="outline" tone={r.role_key ? "accent" : "neutral"}>
                      {r.role_key ? r.role_name : "Everyone"}
                    </Label>
                  </div>
                  <p className="text-[13px] text-ink2 mt-1.5">{ruleSentence(r, meta, departments)}</p>
                </div>
                <div className="flex items-center gap-2 flex-none">
                  <span className="text-xs text-ink2">{r.active ? "Active" : "Inactive"}</span>
                  <Toggle checked={r.active} label={`${r.name} is ${r.active ? "active" : "inactive"}`} disabled={!canEdit || toggling === r.id} onChange={(v) => void setActive(r, v)} />
                  {canEdit && (
                    <>
                      <IconButton icon={Pencil} label={`Edit ${r.name}`} size="sm" onClick={() => openRule(r)} />
                      <IconButton icon={Trash2} label={`Delete ${r.name}`} size="sm" onClick={() => remove(r)} />
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {!canEdit && <p className="text-xs text-ink2">You need the Roles &amp; access "configure" permission to change record rules.</p>}
    </div>
  );
}
