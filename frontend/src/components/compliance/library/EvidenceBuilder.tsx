import { useState } from "react";
import { ArrowDown, ArrowUp, FileCheck2, Plus, Trash2, X } from "lucide-react";
import { EVIDENCE_KIND_LABEL, type EvidenceKind } from "../../../lib/compliance";
import { Button, EmptyState, IconButton, Select, TextInput } from "../../ui";
import { Field } from "../common";
import { requirementSummary } from "./describe";
import { evidencePayload, slugify, uid, type EvDraft, type Issue } from "./formModel";

const KINDS: EvidenceKind[] = ["text", "file", "url", "attestation", "choice"];

/** Chips with a text box: Enter, comma or leaving the box adds one; `normalize` cleans each (return "" to refuse). */
function TagInput({
  id,
  values,
  onChange,
  normalize,
  placeholder,
  ariaLabel,
  invalid,
  disabled,
}: {
  id?: string;
  values: string[];
  onChange: (v: string[]) => void;
  normalize: (raw: string) => string;
  placeholder: string;
  ariaLabel: string;
  invalid?: boolean;
  disabled?: boolean;
}) {
  const [text, setText] = useState("");
  const commit = (raw: string) => {
    const v = normalize(raw);
    if (v && !values.includes(v)) onChange([...values, v]);
    setText("");
  };
  return (
    <div className="flex flex-col gap-2">
      {values.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={ariaLabel}>
          {values.map((v) => (
            <li key={v} className="inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded-full bg-panel2 border border-line text-xs text-ink">
              <span className="truncate max-w-[220px]">{v}</span>
              {!disabled && (
                <button
                  type="button"
                  aria-label={`Remove ${v}`}
                  onClick={() => onChange(values.filter((x) => x !== v))}
                  className="w-4 h-4 rounded-full flex items-center justify-center text-ink3 hover:text-ink hover:bg-panel3"
                >
                  <X size={12} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <TextInput
        id={id}
        value={text}
        placeholder={placeholder}
        invalid={invalid}
        disabled={disabled}
        onChange={(e) => {
          const v = e.target.value;
          if (v.endsWith(",")) commit(v.slice(0, -1));
          else setText(v);
        }}
        onBlur={() => text.trim() && commit(text)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(text);
          } else if (e.key === "Backspace" && !text && values.length) {
            onChange(values.slice(0, -1));
          }
        }}
      />
    </div>
  );
}

const normalizeExt = (raw: string) => {
  const v = raw.trim().toLowerCase().replace(/^\.+/, "").replace(/[^a-z0-9]/g, "");
  return v ? `.${v}` : "";
};

function ItemCard({
  item,
  index,
  count,
  issues,
  showErrors,
  disabled,
  onChange,
  onMove,
  onRemove,
  siblingKeys,
}: {
  item: EvDraft;
  index: number;
  count: number;
  issues: Issue[];
  showErrors: boolean;
  disabled?: boolean;
  onChange: (p: Partial<EvDraft>) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  siblingKeys: string[];
}) {
  const err = (field: string) => (showErrors ? issues.find((i) => i.field === `${field}-${item.uid}`)?.message : undefined);
  return (
    <li className="rounded-lg border border-line bg-panel p-3.5 flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <span className="mt-1.5 w-5 h-5 rounded-full bg-panel2 border border-line text-[11px] font-semibold text-ink2 flex items-center justify-center flex-none" aria-hidden>
          {index + 1}
        </span>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_200px] flex-1 min-w-0">
          <Field label="What people provide" error={err("ev-label")} required>
            {(id) => (
              <TextInput
                id={id}
                value={item.label}
                invalid={Boolean(err("ev-label"))}
                disabled={disabled}
                placeholder="e.g. Screenshot of the repost"
                onChange={(e) => {
                  const label = e.target.value;
                  onChange(item.keyLocked ? { label } : { label, key: slugify(label, siblingKeys, "item") });
                }}
              />
            )}
          </Field>
          <Field label="Type of proof">
            {(id) => (
              <Select
                id={id}
                value={item.kind}
                disabled={disabled}
                className="w-full"
                onChange={(e) => {
                  const kind = e.target.value as EvidenceKind;
                  onChange({ kind, options: kind === "choice" && item.options.length === 0 ? ["Yes", "No"] : item.options });
                }}
              >
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {EVIDENCE_KIND_LABEL[k]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <div className="flex items-center flex-none">
          <IconButton icon={ArrowUp} label={`Move item ${index + 1} up`} size="sm" disabled={disabled || index === 0} onClick={() => onMove(-1)} />
          <IconButton icon={ArrowDown} label={`Move item ${index + 1} down`} size="sm" disabled={disabled || index === count - 1} onClick={() => onMove(1)} />
          <IconButton icon={Trash2} label={`Remove item ${index + 1}`} size="sm" disabled={disabled} onClick={onRemove} />
        </div>
      </div>

      <div className="pl-7 flex flex-col gap-3">
        <label className="inline-flex items-center gap-2 text-sm cursor-pointer w-fit">
          <input type="checkbox" checked={item.mandatory} disabled={disabled} onChange={(e) => onChange({ mandatory: e.target.checked })} className="accent-[var(--accent)]" />
          <span className="text-ink">Required</span>
          <span className="text-ink2 text-[13px]">(people can't submit without it)</span>
        </label>

        {item.kind === "text" && (
          <div className="grid grid-cols-2 gap-3 max-w-sm">
            <Field label="Fewest characters" error={err("ev-len")}>
              {(id) => (
                <TextInput id={id} inputMode="numeric" value={item.minLength} disabled={disabled} invalid={Boolean(err("ev-len"))} placeholder="No minimum" onChange={(e) => onChange({ minLength: e.target.value })} />
              )}
            </Field>
            <Field label="Most characters">
              {(id) => <TextInput id={id} inputMode="numeric" value={item.maxLength} disabled={disabled} placeholder="No maximum" onChange={(e) => onChange({ maxLength: e.target.value })} />}
            </Field>
          </div>
        )}

        {item.kind === "file" && (
          <Field label="Allowed file types" hint="Press Enter after each one, for example .png or .pdf. Leave empty to allow any type the system accepts.">
            {(id) => (
              <TagInput id={id} values={item.extensions} onChange={(extensions) => onChange({ extensions })} normalize={normalizeExt} placeholder="Add a file type, e.g. .pdf" ariaLabel="Allowed file types" disabled={disabled} />
            )}
          </Field>
        )}

        {item.kind === "choice" && (
          <Field label="Options to pick from" hint="Press Enter after each option. At least two." error={err("ev-options")}>
            {(id) => (
              <TagInput
                id={id}
                values={item.options}
                onChange={(options) => onChange({ options })}
                normalize={(s) => s.trim()}
                placeholder="Add an option"
                ariaLabel="Options"
                invalid={Boolean(err("ev-options"))}
                disabled={disabled}
              />
            )}
          </Field>
        )}

        <details className="text-[13px]">
          <summary className="cursor-pointer text-ink2 hover:text-ink w-fit select-none">Advanced: internal key</summary>
          <div className="mt-2 max-w-xs">
            <Field label="Key" hint={item.keyLocked ? "Saved submissions refer to this key, so change it with care." : "Made from the label. Lowercase letters, digits, - or _."} error={err("ev-key")}>
              {(id) => (
                <TextInput id={id} value={item.key} disabled={disabled} invalid={Boolean(err("ev-key"))} className="font-mono" onChange={(e) => onChange({ key: e.target.value, keyLocked: true })} />
              )}
            </Field>
          </div>
        </details>
      </div>
    </li>
  );
}

export function EvidenceBuilder({
  items,
  onChange,
  issues,
  showErrors,
  readOnly,
}: {
  items: EvDraft[];
  onChange: (items: EvDraft[]) => void;
  issues: Issue[];
  showErrors: boolean;
  readOnly?: boolean;
}) {
  const move = (i: number, dir: -1 | 1) => {
    const next = [...items];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const add = () =>
    onChange([...items, { uid: uid(), key: slugify("", items.map((i) => i.key), "item"), keyLocked: false, kind: "text", label: "", mandatory: true, minLength: "", maxLength: "", extensions: [], options: [] }]);
  const summary = evidencePayload(items).filter((r) => r.label);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-ink2 leading-[19px]">
        List what each person has to hand in. They see these as a form and can only submit once every required item is filled in.
      </p>
      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line-strong">
          <EmptyState
            compact
            icon={FileCheck2}
            title="No proof is asked for"
            description="People will simply confirm they have done it. Add an item if you need a file, a link or a written description."
            action={!readOnly && <Button leadingIcon={Plus} onClick={add}>Add proof</Button>}
          />
        </div>
      ) : (
        <ol className="flex flex-col gap-2.5" aria-label="Proof items">
          {items.map((it, i) => (
            <ItemCard
              key={it.uid}
              item={it}
              index={i}
              count={items.length}
              issues={issues}
              showErrors={showErrors}
              disabled={readOnly}
              siblingKeys={items.filter((x) => x.uid !== it.uid).map((x) => x.key)}
              onChange={(p) => onChange(items.map((x) => (x.uid === it.uid ? { ...x, ...p } : x)))}
              onMove={(d) => move(i, d)}
              onRemove={() => onChange(items.filter((x) => x.uid !== it.uid))}
            />
          ))}
        </ol>
      )}
      {items.length > 0 && !readOnly && (
        <div>
          <Button leadingIcon={Plus} onClick={add}>Add proof</Button>
        </div>
      )}
      {summary.length > 0 && (
        <div className="rounded-lg bg-panel2 border border-line px-4 py-3">
          <h4 className="text-xs font-semibold text-ink2 mb-1.5">In plain words, people will provide</h4>
          <ul className="text-sm text-ink list-disc pl-5 space-y-0.5">
            {summary.map((r, i) => (
              <li key={`${r.key}-${i}`}>{requirementSummary(r)}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
