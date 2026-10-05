import { useMemo } from "react";
import { BellRing, Plus, Trash2 } from "lucide-react";
import type { Meta } from "../../../lib/compliance";
import { Button, EmptyState, IconButton, Select, TextInput } from "../../ui";
import { Field } from "../common";
import { MultiCombobox, type ComboOption } from "./Combobox";
import { useConfirm } from "./confirm";
import { ACTION_LABEL, TRIGGER_LABEL, ruleSentence } from "./describe";
import { escalationPayload, newAction, ruleFromServer, slugify, stable, uid, type ActionDraft, type Issue, type RuleDraft } from "./formModel";

function ActionRow({
  action,
  actionTypes,
  people,
  nameOf,
  error,
  disabled,
  onChange,
  onRemove,
  canRemove,
}: {
  action: ActionDraft;
  actionTypes: string[];
  people: ComboOption[];
  nameOf: (email: string) => string;
  error?: string;
  disabled?: boolean;
  onChange: (p: Partial<ActionDraft>) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  return (
    <li className="flex flex-col gap-2 sm:flex-row sm:items-start">
      <Select
        aria-label="Action"
        value={action.type}
        disabled={disabled}
        onChange={(e) => onChange({ type: e.target.value })}
        className="sm:w-64"
      >
        {actionTypes.map((t) => (
          <option key={t} value={t}>
            {ACTION_LABEL[t] ?? t}
          </option>
        ))}
      </Select>
      {action.type === "notify_manager_chain" && (
        <label className="inline-flex items-center gap-2 text-[13px] text-ink2 h-8">
          Up
          <TextInput
            aria-label="Levels up the management chain"
            type="number"
            min={1}
            max={6}
            value={String(action.levels)}
            disabled={disabled}
            onChange={(e) => onChange({ levels: Math.max(1, Math.min(6, Number(e.target.value) || 1)) })}
            className="w-16"
          />
          levels
        </label>
      )}
      {action.type === "notify_users" && (
        <div className="min-w-0 sm:flex-1">
          <MultiCombobox
            values={action.emails}
            onChange={(emails) => onChange({ emails })}
            options={people}
            label={nameOf}
            placeholder="Add a person to notify…"
            disabled={disabled}
            invalid={Boolean(error)}
          />
          {error && <p className="text-xs text-crit mt-1">{error}</p>}
        </div>
      )}
      <div className="sm:ml-auto">
        <IconButton icon={Trash2} label="Remove action" size="sm" onClick={onRemove} disabled={disabled || !canRemove} />
      </div>
    </li>
  );
}

export function EscalationBuilder({
  rules,
  onChange,
  meta,
  people,
  nameOf,
  issues,
  showErrors,
  readOnly,
}: {
  rules: RuleDraft[];
  onChange: (rules: RuleDraft[]) => void;
  meta: Meta;
  people: ComboOption[];
  nameOf: (email: string) => string;
  issues: Issue[];
  showErrors: boolean;
  readOnly?: boolean;
}) {
  const confirm = useConfirm();
  const triggers = meta.triggers.length ? meta.triggers : Object.keys(TRIGGER_LABEL);
  const actionTypes = meta.actions.length ? meta.actions : Object.keys(ACTION_LABEL);
  const err = (field: string) => (showErrors ? issues.find((i) => i.field === field)?.message : undefined);

  const current = useMemo(() => stable(escalationPayload(rules)), [rules]);
  const presetKey = meta.escalation_presets.find((p) => stable(escalationPayload(p.rules.map((r) => ruleFromServer(r, false)))) === current)?.key ?? "custom";

  const applyPreset = (key: string) => {
    const p = meta.escalation_presets.find((x) => x.key === key);
    if (!p) return;
    const replace = () => onChange(p.rules.map((r) => ruleFromServer(r, false)));
    if (presetKey === "custom" && rules.length > 0) {
      confirm({
        title: `Replace your rules with “${p.label}”?`,
        description: "The rules below were changed from a preset. Choosing another preset throws those changes away.",
        confirm: "Replace rules",
        onConfirm: replace,
      });
    } else replace();
  };

  const patchRule = (u: string, p: Partial<RuleDraft>) => onChange(rules.map((r) => (r.uid === u ? { ...r, ...p } : r)));
  const addRule = () => {
    const name = "";
    onChange([
      ...rules,
      { uid: uid(), id: slugify(name, rules.map((r) => r.id), "rule"), idLocked: false, name, trigger: "before_due", days: "3", actions: [newAction("notify_assignee")] },
    ]);
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-ink2 leading-[19px]">
        Reminders and follow-ups are sent automatically for people who must act and haven't finished. Pick a preset to start, then change anything.
      </p>
      <Field label="Start from" className="max-w-md">
        {(id) => (
          <Select id={id} value={presetKey} disabled={readOnly} onChange={(e) => applyPreset(e.target.value)} className="w-full">
            {presetKey === "custom" && <option value="custom">Custom rules</option>}
            {meta.escalation_presets.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </Select>
        )}
      </Field>

      {rules.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line-strong">
          <EmptyState
            compact
            icon={BellRing}
            title="No automatic follow-up"
            description="Nobody will be reminded, and nobody is marked non-compliant, unless you add a rule."
            action={!readOnly && <Button leadingIcon={Plus} onClick={addRule}>Add a rule</Button>}
          />
        </div>
      ) : (
        <ol className="flex flex-col gap-3" aria-label="Escalation rules">
          {rules.map((r, i) => (
            <li key={r.uid} className="rounded-lg border border-line bg-panel p-3.5 flex flex-col gap-3">
              <div className="flex items-start gap-2">
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] flex-1 min-w-0">
                  <Field label="Rule name" error={err(`esc-name-${r.uid}`)} required>
                    {(id) => (
                      <TextInput
                        id={id}
                        value={r.name}
                        disabled={readOnly}
                        invalid={Boolean(err(`esc-name-${r.uid}`))}
                        placeholder="e.g. Reminder 3 days before"
                        onChange={(e) => {
                          const name = e.target.value;
                          patchRule(r.uid, r.idLocked ? { name } : { name, id: slugify(name, rules.filter((x) => x.uid !== r.uid).map((x) => x.id), "rule") });
                        }}
                      />
                    )}
                  </Field>
                  <Field label="When">
                    {(id) => (
                      <Select
                        id={id}
                        value={r.trigger}
                        disabled={readOnly}
                        className="w-full"
                        onChange={(e) => patchRule(r.uid, { trigger: e.target.value, days: e.target.value === "on_due" ? "0" : r.days })}
                      >
                        {triggers.map((t) => (
                          <option key={t} value={t}>
                            {TRIGGER_LABEL[t] ?? t}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  {r.trigger !== "on_due" && (
                    <Field label="Days" error={err(`esc-days-${r.uid}`)} className="w-24">
                      {(id) => (
                        <TextInput
                          id={id}
                          type="number"
                          min={0}
                          max={365}
                          value={r.days}
                          disabled={readOnly}
                          invalid={Boolean(err(`esc-days-${r.uid}`))}
                          onChange={(e) => patchRule(r.uid, { days: e.target.value })}
                        />
                      )}
                    </Field>
                  )}
                </div>
                <IconButton icon={Trash2} label={`Remove rule ${r.name || i + 1}`} size="sm" className="mt-6" disabled={readOnly} onClick={() => onChange(rules.filter((x) => x.uid !== r.uid))} />
              </div>

              <div>
                <h4 className="text-[13px] font-semibold text-ink mb-1.5">Then</h4>
                <ul className="flex flex-col gap-2" aria-label={`Actions for ${r.name || `rule ${i + 1}`}`}>
                  {r.actions.map((a) => (
                    <ActionRow
                      key={a.uid}
                      action={a}
                      actionTypes={actionTypes}
                      people={people}
                      nameOf={nameOf}
                      error={err(`esc-act-${a.uid}`)}
                      disabled={readOnly}
                      canRemove={r.actions.length > 1}
                      onChange={(p) => patchRule(r.uid, { actions: r.actions.map((x) => (x.uid === a.uid ? { ...x, ...p } : x)) })}
                      onRemove={() => patchRule(r.uid, { actions: r.actions.filter((x) => x.uid !== a.uid) })}
                    />
                  ))}
                </ul>
                {!readOnly && (
                  <Button size="sm" variant="ghost" leadingIcon={Plus} className="mt-2" onClick={() => patchRule(r.uid, { actions: [...r.actions, newAction("notify_manager")] })}>
                    Add an action
                  </Button>
                )}
              </div>

              <p className="text-[13px] text-ink rounded-md bg-panel2 border border-line px-3 py-2">
                <span className="text-ink2">In words: </span>
                {ruleSentence({ trigger: { type: r.trigger, days: r.trigger === "on_due" ? 0 : Number(r.days) || 0 }, actions: escalationPayload([r])[0].actions }, nameOf)}
              </p>

              <details className="text-[13px]">
                <summary className="cursor-pointer text-ink2 hover:text-ink w-fit select-none">Advanced: rule id</summary>
                <div className="mt-2 max-w-xs">
                  <Field label="Rule id" hint="Used to record that the rule already fired. Lowercase letters, digits, - or _." error={err(`esc-id-${r.uid}`)}>
                    {(id) => (
                      <TextInput id={id} value={r.id} disabled={readOnly} invalid={Boolean(err(`esc-id-${r.uid}`))} className="font-mono" onChange={(e) => patchRule(r.uid, { id: e.target.value, idLocked: true })} />
                    )}
                  </Field>
                </div>
              </details>
            </li>
          ))}
        </ol>
      )}
      {rules.length > 0 && !readOnly && (
        <div>
          <Button leadingIcon={Plus} onClick={addRule}>Add a rule</Button>
        </div>
      )}
    </div>
  );
}
