/**
 * Small building blocks shared by the compliance administration pages: the people / department lookup,
 * a confirmation dialog, a searchable multi-person picker, a person select, removable chips and a
 * checkbox row. Everything here is presentational; the pages own the API calls.
 */
import { useMemo, useState } from "react";
import clsx from "clsx";
import { ShieldOff, X } from "lucide-react";
import { useApi } from "../../../lib/useApi";
import type { Lookup } from "../../../lib/compliance";
import { Avatar, Button, EmptyState, SearchInput, Select } from "../../ui";
import { useOverlay } from "../../Modal";
import { errText } from "../common";

// ----------------------------------------------------------------- lookup

/** People, teams, departments and roles for pickers (only active people in the viewer's scope). */
export function useLookup(enabled = true) {
  return useApi<Lookup>(enabled ? "/compliance/lookup" : null);
}

// ------------------------------------------------------------------ labels

/** Short scope names for dense grids; the long wording (meta.scopes) goes in legends and tooltips. */
export const SCOPE_SHORT: Record<string, string> = {
  self: "Own records",
  created_by_me: "Created by me",
  direct_reports: "Direct reports",
  team: "My teams",
  subtree: "Reporting line",
  department: "Department",
  org: "Everyone",
};

export const SCOPE_ORDER = ["self", "created_by_me", "direct_reports", "team", "subtree", "department", "org"];

export function scopeShort(key: string): string {
  return SCOPE_SHORT[key] ?? key;
}

/** Display order for permission columns. */
export const ACTION_ORDER = ["view", "create", "edit", "delete", "assign", "approve", "reject", "submit", "export", "configure", "waive", "import"];

export function actionLabel(a: string): string {
  return a.charAt(0).toUpperCase() + a.slice(1);
}

/** "record_rule.created" -> "Record rule created"; "audit_log" -> "Audit log". */
export function humanize(key: string): string {
  const s = key.replace(/[._]+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : key;
}

export function NoAccess({ what }: { what: string }) {
  return (
    <div className="bg-panel border border-line rounded-lg shadow-xs">
      <EmptyState icon={ShieldOff} title="You don't have access to this page" description={`Ask a Super Admin if you need to ${what}.`} />
    </div>
  );
}

// ----------------------------------------------------------------- confirm

function ConfirmDialog({
  title,
  description,
  confirm,
  tone,
  onConfirm,
}: {
  title: string;
  description?: React.ReactNode;
  confirm: string;
  tone: "primary" | "danger";
  onConfirm: () => Promise<unknown>;
}) {
  const { close } = useOverlay();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      close();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  }

  return (
    <div role="alertdialog" aria-label={title} className="flex flex-col gap-4 pr-6">
      <div>
        <h2 className="text-lg font-semibold text-ink">{title}</h2>
        {description && <div className="text-sm text-ink2 mt-1.5 flex flex-col gap-2">{description}</div>}
      </div>
      {error && (
        <p role="alert" className="text-sm text-crit">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={close} disabled={busy}>
          Cancel
        </Button>
        <Button variant={tone === "danger" ? "danger" : "primary"} loading={busy} onClick={() => void go()} autoFocus>
          {confirm}
        </Button>
      </div>
    </div>
  );
}

/**
 * Opens a confirmation dialog, then runs `onConfirm`. The dialog stays open showing the server's message
 * if it throws, and closes if it succeeds.
 */
export function useConfirm() {
  const { openModal } = useOverlay();
  return (opts: { title: string; description?: React.ReactNode; confirm: string; tone?: "primary" | "danger"; onConfirm: () => Promise<unknown> }) =>
    openModal(<ConfirmDialog title={opts.title} description={opts.description} confirm={opts.confirm} tone={opts.tone ?? "danger"} onConfirm={opts.onConfirm} />);
}

// ------------------------------------------------------------------- chips

export function Chip({ children, onRemove, removeLabel, className }: { children: React.ReactNode; onRemove?: () => void; removeLabel?: string; className?: string }) {
  return (
    <span className={clsx("inline-flex items-center gap-1 h-6 pl-2.5 rounded-full bg-panel2 border border-line text-xs text-ink max-w-full", onRemove ? "pr-1" : "pr-2.5", className)}>
      <span className="truncate">{children}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel ?? "Remove"}
          className="w-4 h-4 rounded-full flex items-center justify-center text-ink3 hover:text-ink hover:bg-panel3 flex-none"
        >
          <X size={12} aria-hidden />
        </button>
      )}
    </span>
  );
}

/** Type a value and press Enter or comma to add it as a chip; pasting "a, b, c" adds three. */
export function ChipInput({
  id,
  value,
  onChange,
  placeholder,
  invalid,
  disabled,
  describedBy,
}: {
  id?: string;
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  invalid?: boolean;
  disabled?: boolean;
  describedBy?: string;
}) {
  const [text, setText] = useState("");

  function commit(raw: string) {
    const parts = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length === 0) return;
    const next = [...value];
    for (const p of parts) if (!next.includes(p)) next.push(p);
    onChange(next);
    setText("");
  }

  return (
    <div
      aria-invalid={invalid || undefined}
      className={clsx(
        "field flex flex-wrap items-center gap-1.5 px-2 py-1.5 min-h-8 focus-within:border-accent",
        invalid && "border-crit",
        disabled && "opacity-60"
      )}
    >
      {value.map((v) => (
        <Chip key={v} onRemove={disabled ? undefined : () => onChange(value.filter((x) => x !== v))} removeLabel={`Remove ${v}`}>
          {v}
        </Chip>
      ))}
      <input
        id={id}
        value={text}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={(e) => {
          const v = e.target.value;
          if (v.includes(",")) commit(v);
          else setText(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(text);
          } else if (e.key === "Backspace" && !text && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => commit(text)}
        placeholder={value.length ? "" : placeholder}
        className="flex-1 min-w-[8rem] bg-transparent outline-none text-sm text-ink placeholder:text-ink3"
      />
    </div>
  );
}

// ------------------------------------------------------------------ people

type PersonLite = { email: string; name: string; title?: string };

/** Single-person select. The current value is kept as an option even if the lookup no longer lists them. */
export function PersonSelect({
  id,
  value,
  onChange,
  users,
  none = "No one",
  exclude,
  disabled,
  invalid,
}: {
  id?: string;
  value: string;
  onChange: (email: string) => void;
  users: PersonLite[];
  none?: string;
  exclude?: string;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const options = useMemo(() => {
    const list = users.filter((u) => u.email !== exclude);
    const opts = [{ value: "", label: none }];
    if (value && !list.some((u) => u.email === value)) opts.push({ value, label: value });
    for (const u of list) opts.push({ value: u.email, label: `${u.name} · ${u.email}` });
    return opts;
  }, [users, value, none, exclude]);
  return <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} options={options} disabled={disabled} aria-invalid={invalid || undefined} className="w-full" />;
}

const PICKER_LIMIT = 200;

/**
 * Searchable multi-select of people. Selected people the lookup doesn't list (deactivated, or outside the
 * viewer's scope) stay selected and show by e-mail, so saving never silently drops them.
 */
export function PeoplePicker({
  people,
  value,
  onChange,
  disabled,
  label,
}: {
  people: PersonLite[];
  value: string[];
  onChange: (v: string[]) => void;
  disabled?: boolean;
  label: string;
}) {
  const [q, setQ] = useState("");
  const selected = useMemo(() => new Set(value), [value]);
  const byEmail = useMemo(() => new Map(people.map((p) => [p.email, p])), [people]);
  const needle = q.trim().toLowerCase();
  const matches = useMemo(
    () => (needle ? people.filter((p) => `${p.name} ${p.email} ${p.title ?? ""}`.toLowerCase().includes(needle)) : people),
    [people, needle]
  );
  const shown = matches.slice(0, PICKER_LIMIT);

  function toggle(email: string) {
    onChange(selected.has(email) ? value.filter((v) => v !== email) : [...value, email]);
  }

  return (
    <div className="flex flex-col gap-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto" aria-label={`Selected: ${value.length}`}>
          {value.map((e) => (
            <Chip key={e} onRemove={disabled ? undefined : () => toggle(e)} removeLabel={`Remove ${byEmail.get(e)?.name ?? e}`}>
              {byEmail.get(e)?.name ?? e}
            </Chip>
          ))}
        </div>
      )}
      <SearchInput value={q} onChange={setQ} placeholder="Search people…" aria-label={`Search ${label}`} />
      <div role="group" aria-label={label} className="border border-line rounded-md max-h-56 overflow-y-auto divide-y divide-line-soft">
        {shown.length === 0 ? (
          <p className="text-[13px] text-ink2 px-3 py-4 text-center">{people.length === 0 ? "No people to choose from." : "No one matches that search."}</p>
        ) : (
          shown.map((p) => (
            <label key={p.email} className={clsx("flex items-center gap-3 px-3 py-2", disabled ? "opacity-60" : "cursor-pointer hover:bg-panel2")}>
              <input
                type="checkbox"
                checked={selected.has(p.email)}
                disabled={disabled}
                onChange={() => toggle(p.email)}
                className="w-4 h-4 accent-[var(--accent)] flex-none"
              />
              <Avatar name={p.name} size={24} />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink truncate">{p.name}</span>
                <span className="block text-xs text-ink2 truncate">{p.title ? `${p.title} · ${p.email}` : p.email}</span>
              </span>
            </label>
          ))
        )}
      </div>
      <p className="text-xs text-ink2" aria-live="polite">
        {value.length} selected{matches.length > PICKER_LIMIT ? ` · showing the first ${PICKER_LIMIT} matches, search to narrow down` : ""}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- checkbox

export function CheckRow({
  checked,
  onChange,
  disabled,
  title,
  description,
  badge,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  title: React.ReactNode;
  description?: React.ReactNode;
  badge?: React.ReactNode;
}) {
  return (
    <label className={clsx("flex items-start gap-3 px-3 py-2.5 rounded-md border", checked ? "border-accent bg-accent-soft" : "border-line", disabled ? "opacity-60" : "cursor-pointer hover:border-line-strong")}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 w-4 h-4 accent-[var(--accent)] flex-none" />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink">
          {title}
          {badge}
        </span>
        {description && <span className="block text-xs text-ink2 mt-0.5">{description}</span>}
      </span>
    </label>
  );
}

/** A roles checklist: explicit roles only (automatic ones are held without being assigned). */
export function RoleChecklist({
  roles,
  value,
  onChange,
  disabled,
  lockedKeys,
}: {
  roles: { key: string; name: string; description: string; is_super?: boolean }[];
  value: string[];
  onChange: (v: string[]) => void;
  disabled?: boolean;
  /** Keys that can't be newly ticked (e.g. Super Admin for a non-super viewer). */
  lockedKeys?: string[];
}) {
  const set = new Set(value);
  return (
    <div className="flex flex-col gap-2">
      {roles.map((r) => (
        <CheckRow
          key={r.key}
          checked={set.has(r.key)}
          disabled={disabled || (Boolean(lockedKeys?.includes(r.key)) && !set.has(r.key))}
          onChange={(on) => onChange(on ? [...value, r.key] : value.filter((k) => k !== r.key))}
          title={r.name}
          description={r.description}
        />
      ))}
    </div>
  );
}
