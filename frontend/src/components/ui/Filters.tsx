/**
 * The shared list filter system. A page declares fields and sorts with `useListFilters`
 * (lib/useListFilters.ts) and renders:
 *
 *   <FilterBar lf={lf} noun={["employee", "employees"]} total={all} shown={rows.length} quick={[...]} onExport={...} />
 *   ... the list, with <FilterEmpty> as its empty state ...
 *
 * The bar has the search box, quick-filter chips, an "Advanced filters" panel (an inline
 * glass panel on wide screens, a bottom sheet on a phone), a sort menu, saved views, a CSV
 * export, the result count and the active filters as removable chips.
 */
import { useEffect, useId, useRef, useState } from "react";
import clsx from "clsx";
import * as D from "@radix-ui/react-dialog";
import { toast } from "sonner";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Bookmark,
  Download,
  SearchX,
  SlidersHorizontal,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  DATE_PRESET_LABEL,
  presetRange,
  dayKey,
  type DatePreset,
  type DateValue,
  type FilterField,
  type ListFilters,
  type RangeValue,
  type SortDir,
} from "../../lib/useListFilters";
import { Button, IconButton } from "./Button";
import { EmptyState } from "./Feedback";
import { SearchInput, Select } from "./Inputs";
import { Menu } from "./Menu";

export type { DatePreset, DateValue, FilterField, ListFilters, RangeValue };

// -------------------------------------------------------------------- bits

function useMediaQuery(query: string): boolean {
  const get = () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false);
  const [match, setMatch] = useState(get);
  useEffect(() => {
    if (!window.matchMedia) return;
    const m = window.matchMedia(query);
    const on = () => setMatch(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return match;
}

/** Keyframes for the phone sheet; the wide layout reuses the app's dialog animation. */
const SHEET_CSS = `
@keyframes mc-fsheet-up { from { transform: translateY(100%); } to { transform: none; } }
@keyframes mc-fsheet-down { from { transform: none; } to { transform: translateY(100%); } }
.mc-fsheet[data-state="open"] { animation: mc-fsheet-up 220ms cubic-bezier(0, 0, 0, 1); }
.mc-fsheet[data-state="closed"] { animation: mc-fsheet-down 160ms cubic-bezier(0.3, 0, 1, 1) forwards; }
@media (min-width: 640px) {
  .mc-fsheet[data-state="open"] { animation: dialog-in 200ms cubic-bezier(0, 0, 0, 1); }
  .mc-fsheet[data-state="closed"] { animation: dialog-out 140ms cubic-bezier(0.3, 0, 1, 1) forwards; }
}
`;

function Sheet({
  open,
  onOpenChange,
  title,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="mc-scrim fixed inset-0 z-50" style={{ background: "var(--scrim)" }} />
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4 pointer-events-none">
          <D.Content
            aria-describedby={undefined}
            className="mc-fsheet pointer-events-auto flex flex-col w-full sm:max-w-[560px] max-h-[88vh] rounded-t-2xl sm:rounded-2xl bg-panel border border-line shadow-lg outline-none"
          >
            <div className="flex items-center justify-between gap-3 px-4 pt-4 pb-2">
              <D.Title className="text-base font-semibold text-ink">{title}</D.Title>
              <D.Close asChild>
                <IconButton icon={X} label="Close" tooltip={false} />
              </D.Close>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-2">{children}</div>
            {footer && <div className="flex items-center gap-2 px-4 py-3 border-t border-line">{footer}</div>}
          </D.Content>
        </div>
      </D.Portal>
    </D.Root>
  );
}

const PILL =
  "inline-flex items-center gap-1.5 h-7 px-3 rounded-full border text-[13px] font-medium whitespace-nowrap select-none transition-colors duration-100";
const PILL_ON = "bg-accent-soft text-accent-strong border-accent";
const PILL_OFF = "bg-[var(--glass)] text-ink2 border-line hover:text-ink hover:border-line-strong";

function Pill({
  on,
  onClick,
  children,
  icon: Icon,
  role,
  className,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
  icon?: LucideIcon;
  role?: "checkbox" | "radio";
  className?: string;
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={role ? on : undefined}
      aria-pressed={role ? undefined : on}
      onClick={onClick}
      className={clsx(PILL, on ? PILL_ON : PILL_OFF, className)}
    >
      {Icon && <Icon size={13} aria-hidden />}
      {children}
    </button>
  );
}

// ------------------------------------------------------------ field editors

function Legend({ f }: { f: FilterField<never> }) {
  const Icon = f.icon;
  return (
    <legend className="text-xs font-semibold text-ink2 mb-1.5 flex items-center gap-1.5 p-0">
      {Icon && <Icon size={13} aria-hidden />}
      {f.label}
    </legend>
  );
}

function Hint({ children }: { children?: React.ReactNode }) {
  return children ? <p className="text-xs text-ink3 mt-1.5">{children}</p> : null;
}

const NUM = "field h-8 text-sm tabular w-full";

function MultiEditor<T>({ f, lf }: { f: Extract<FilterField<T>, { type: "multi" }>; lf: ListFilters<T> }) {
  const [text, setText] = useState("");
  const sel = (lf.values[f.key] as string[] | undefined) ?? [];
  if (f.options.length === 0) {
    return (
      <fieldset className="min-w-0">
        <Legend f={f as never} />
        <p className="text-[13px] text-ink3">Nothing to choose from yet.</p>
      </fieldset>
    );
  }
  // Short lists of short labels read best as toggle pills; long ones as a scrollable checklist.
  const pills = f.options.length <= 9 && f.options.every((o) => o.label.length <= 26);
  const shown = !pills && text ? f.options.filter((o) => o.label.toLowerCase().includes(text.toLowerCase())) : f.options;
  return (
    <fieldset className="min-w-0">
      <Legend f={f as never} />
      {pills ? (
        <div className="flex flex-wrap gap-1.5">
          {f.options.map((o) => (
            <Pill key={o.value} role="checkbox" on={sel.includes(o.value)} onClick={() => lf.toggleOption(f.key, o.value)}>
              {o.label}
              {o.count != null && <span className="text-xs text-ink3 tabular">{o.count}</span>}
            </Pill>
          ))}
        </div>
      ) : (
        <>
          {f.options.length > 8 && (
            <input
              type="search"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={`Find ${f.label.toLowerCase()}…`}
              aria-label={`Find ${f.label.toLowerCase()}`}
              className="field h-8 text-[13px] mb-1.5"
            />
          )}
          <div className="max-h-44 overflow-y-auto -mx-1 px-1">
            {shown.length === 0 && <p className="text-[13px] text-ink3 py-1.5">No match.</p>}
            {shown.map((o) => (
              <label key={o.value} className="flex items-center gap-2 h-8 px-1.5 rounded-md hover:bg-panel2 cursor-pointer text-sm text-ink">
                <input
                  type="checkbox"
                  checked={sel.includes(o.value)}
                  onChange={() => lf.toggleOption(f.key, o.value)}
                  className="w-4 h-4 flex-none accent-[var(--accent)]"
                />
                <span className="truncate flex-1">{o.label}</span>
                {o.count != null && <span className="text-xs text-ink3 tabular">{o.count}</span>}
              </label>
            ))}
          </div>
        </>
      )}
      <Hint>{f.hint}</Hint>
    </fieldset>
  );
}

function SelectEditor<T>({ f, lf }: { f: Extract<FilterField<T>, { type: "select" }>; lf: ListFilters<T> }) {
  const v = (lf.values[f.key] as string | undefined) ?? "";
  return (
    <fieldset className="min-w-0">
      <Legend f={f as never} />
      <Select
        className="w-full"
        aria-label={f.label}
        value={v}
        onChange={(e) => lf.setValue(f.key, e.target.value || undefined)}
        options={[{ value: "", label: f.anyLabel ?? "Any" }, ...f.options.map((o) => ({ value: o.value, label: o.label }))]}
      />
      <Hint>{f.hint}</Hint>
    </fieldset>
  );
}

const DEFAULT_PRESETS: DatePreset[] = ["today", "last7", "last30", "month", "custom"];

function DateEditor<T>({ f, lf }: { f: Extract<FilterField<T>, { type: "date" }>; lf: ListFilters<T> }) {
  const v = lf.values[f.key] as DateValue | undefined;
  const [custom, setCustom] = useState(v?.preset === "custom");
  useEffect(() => {
    if (v?.preset === "custom") setCustom(true);
    else if (v) setCustom(false);
  }, [v]);
  const presets = (f.presets ?? DEFAULT_PRESETS).filter((p) => p !== "custom");
  const allowCustom = (f.presets ?? DEFAULT_PRESETS).includes("custom");
  const id = useId();
  return (
    <fieldset className="min-w-0">
      <Legend f={f as never} />
      <div className="flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <Pill
            key={p}
            role="radio"
            on={!custom && v?.preset === p}
            onClick={() => {
              setCustom(false);
              lf.setValue(f.key, v?.preset === p && !custom ? undefined : { preset: p });
            }}
          >
            {DATE_PRESET_LABEL[p]}
          </Pill>
        ))}
        {allowCustom && (
          <Pill
            role="radio"
            on={custom}
            onClick={() => {
              if (custom) {
                setCustom(false);
                lf.setValue(f.key, undefined);
                return;
              }
              setCustom(true);
              // Start the custom range from whatever the current preset covers.
              const r = v && v.preset !== "custom" ? presetRange(v.preset, dayKey(new Date())) : {};
              if (r.from || r.to) lf.setValue(f.key, { preset: "custom", ...r });
            }}
          >
            Custom
          </Pill>
        )}
      </div>
      {custom && (
        <div className="grid grid-cols-2 gap-2 mt-2">
          <div>
            <label htmlFor={`${id}-from`} className="block text-xs text-ink3 mb-1">From</label>
            <input
              id={`${id}-from`}
              type="date"
              className="field h-8 text-sm"
              value={v?.from ?? ""}
              max={v?.to || undefined}
              onChange={(e) => lf.setValue(f.key, { preset: "custom", from: e.target.value || undefined, to: v?.to })}
            />
          </div>
          <div>
            <label htmlFor={`${id}-to`} className="block text-xs text-ink3 mb-1">To</label>
            <input
              id={`${id}-to`}
              type="date"
              className="field h-8 text-sm"
              value={v?.to ?? ""}
              min={v?.from || undefined}
              onChange={(e) => lf.setValue(f.key, { preset: "custom", from: v?.from, to: e.target.value || undefined })}
            />
          </div>
        </div>
      )}
      <Hint>{f.hint}</Hint>
    </fieldset>
  );
}

function RangeEditor<T>({ f, lf }: { f: Extract<FilterField<T>, { type: "range" }>; lf: ListFilters<T> }) {
  const v = (lf.values[f.key] as RangeValue | undefined) ?? {};
  const id = useId();
  const set = (next: RangeValue) => lf.setValue(f.key, next);
  const parse = (s: string): number | undefined => {
    if (s === "") return undefined;
    const n = Number(s);
    if (!Number.isFinite(n)) return undefined;
    return Math.min(f.max ?? Infinity, Math.max(f.min ?? -Infinity, n));
  };
  // If the two ends cross, swap them when leaving the field.
  const settle = () => {
    if (v.min != null && v.max != null && v.min > v.max) set({ min: v.max, max: v.min });
  };
  return (
    <fieldset className="min-w-0">
      <Legend f={f as never} />
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <input
            id={`${id}-min`}
            type="number"
            inputMode="decimal"
            aria-label={`${f.label}, minimum`}
            placeholder="Min"
            min={f.min}
            max={f.max}
            step={f.step}
            className={clsx(NUM, f.suffix && "pr-9")}
            value={v.min ?? ""}
            onChange={(e) => set({ ...v, min: parse(e.target.value) })}
            onBlur={settle}
          />
          {f.suffix && <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-ink3 pointer-events-none">{f.suffix}</span>}
        </div>
        <span className="text-ink3 text-sm" aria-hidden>to</span>
        <div className="relative flex-1">
          <input
            id={`${id}-max`}
            type="number"
            inputMode="decimal"
            aria-label={`${f.label}, maximum`}
            placeholder="Max"
            min={f.min}
            max={f.max}
            step={f.step}
            className={clsx(NUM, f.suffix && "pr-9")}
            value={v.max ?? ""}
            onChange={(e) => set({ ...v, max: parse(e.target.value) })}
            onBlur={settle}
          />
          {f.suffix && <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-ink3 pointer-events-none">{f.suffix}</span>}
        </div>
      </div>
      <Hint>{f.hint}</Hint>
    </fieldset>
  );
}

function ToggleEditor<T>({ f, lf }: { f: Extract<FilterField<T>, { type: "toggle" }>; lf: ListFilters<T> }) {
  const on = lf.values[f.key] === true;
  return (
    <label className="flex items-start gap-3 cursor-pointer min-w-0">
      <span className="relative mt-0.5 inline-flex flex-none">
        <input
          type="checkbox"
          role="switch"
          className="peer sr-only"
          checked={on}
          onChange={(e) => lf.setValue(f.key, e.target.checked ? true : undefined)}
        />
        <span className="w-9 h-5 rounded-full bg-neutral-bg border border-line transition-colors peer-checked:bg-accent-emphasis peer-checked:border-transparent peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--focus)]" />
        <span className="absolute left-0.5 top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-150 peer-checked:translate-x-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink leading-5">{f.label}</span>
        {f.hint && <span className="block text-xs text-ink3 mt-0.5">{f.hint}</span>}
      </span>
    </label>
  );
}

function NumberEditor<T>({ f, lf }: { f: Extract<FilterField<T>, { type: "number" }>; lf: ListFilters<T> }) {
  const v = lf.values[f.key] as number | undefined;
  return (
    <fieldset className="min-w-0">
      <Legend f={f as never} />
      <div className="relative max-w-[10rem]">
        <input
          type="number"
          inputMode="numeric"
          aria-label={f.suffix ? `${f.label} (${f.suffix})` : f.label}
          placeholder="Any"
          min={f.min ?? 1}
          max={f.max}
          step={1}
          className={clsx(NUM, f.suffix && "pr-12")}
          value={v ?? ""}
          onChange={(e) => {
            const n = Math.floor(Number(e.target.value));
            lf.setValue(f.key, e.target.value !== "" && Number.isFinite(n) && n > 0 ? Math.min(n, f.max ?? n) : undefined);
          }}
        />
        {f.suffix && <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-ink3 pointer-events-none">{f.suffix}</span>}
      </div>
      <Hint>{f.hint}</Hint>
    </fieldset>
  );
}

function FieldEditor<T>({ f, lf }: { f: FilterField<T>; lf: ListFilters<T> }) {
  switch (f.type) {
    case "multi":
      return <MultiEditor f={f} lf={lf} />;
    case "select":
      return <SelectEditor f={f} lf={lf} />;
    case "date":
      return <DateEditor f={f} lf={lf} />;
    case "range":
      return <RangeEditor f={f} lf={lf} />;
    case "toggle":
      return <ToggleEditor f={f} lf={lf} />;
    case "number":
      return <NumberEditor f={f} lf={lf} />;
  }
}

function FilterFields<T>({ lf }: { lf: ListFilters<T> }) {
  const big = lf.fields.filter((f) => f.type !== "toggle");
  const small = lf.fields.filter((f) => f.type === "toggle");
  return (
    <div className="flex flex-col gap-5">
      {big.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-x-6 gap-y-5">
          {big.map((f) => (
            <FieldEditor key={f.key} f={f} lf={lf} />
          ))}
        </div>
      )}
      {small.length > 0 && (
        <div className={clsx(big.length > 0 && "pt-4 border-t border-line-soft")}>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-x-6 gap-y-4 items-start">
            {small.map((f) => (
              <FieldEditor key={f.key} f={f} lf={lf} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ saved views

function ViewsDialog<T>({ lf, open, onOpenChange }: { lf: ListFilters<T>; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [name, setName] = useState("");
  const nameId = useId();
  const save = () => {
    if (!name.trim()) return;
    lf.saveView(name);
    toast.success(`Saved view “${name.trim()}”`);
    setName("");
  };
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Saved views">
      <p className="text-[13px] text-ink2 mb-3">A saved view remembers the search, filters and sort. Views are stored in this browser.</p>
      {lf.views.length === 0 ? (
        <p className="text-[13px] text-ink3 py-2">No saved views yet.</p>
      ) : (
        <ul className="flex flex-col gap-1 mb-4">
          {lf.views.map((v) => (
            <li key={v.id} className="flex items-center gap-1 rounded-md border border-line bg-[var(--glass)] pl-1">
              <button
                type="button"
                className="flex-1 min-w-0 text-left h-9 px-2 rounded-md text-sm font-medium text-ink hover:text-accent truncate"
                onClick={() => {
                  lf.applyView(v);
                  onOpenChange(false);
                }}
              >
                {v.name}
              </button>
              <IconButton icon={Trash2} label={`Delete view ${v.name}`} size="sm" onClick={() => lf.deleteView(v.id)} />
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        className="flex flex-col gap-2"
      >
        <label htmlFor={nameId} className="text-xs font-semibold text-ink2">
          Save the current view as
        </label>
        <div className="flex gap-2">
          <input
            id={nameId}
            className="field h-8 text-sm flex-1"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Engineering, not seen this week"
          />
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            Save
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

// -------------------------------------------------------------------- bar

export interface QuickFilter {
  id: string;
  label: string;
  icon?: LucideIcon;
  /** The field this chip drives. */
  field: string;
  /**
   * Toggle field: omit. Multi: the option. Select: the value. Date: a preset.
   * Number: the number. Range: {min,max}.
   */
  value?: string | number | RangeValue;
}

function quickOn<T>(lf: ListFilters<T>, q: QuickFilter): boolean {
  const f = lf.fields.find((x) => x.key === q.field);
  const v = lf.values[q.field];
  if (!f || v === undefined) return false;
  switch (f.type) {
    case "toggle":
      return v === true;
    case "multi":
      return (v as string[]).includes(String(q.value));
    case "select":
      return v === q.value;
    case "date":
      return (v as DateValue).preset === q.value;
    case "number":
      return v === q.value;
    case "range": {
      const r = v as RangeValue;
      const w = q.value as RangeValue;
      return r.min === w.min && r.max === w.max;
    }
  }
}

function quickToggle<T>(lf: ListFilters<T>, q: QuickFilter) {
  const f = lf.fields.find((x) => x.key === q.field);
  if (!f) return;
  if (quickOn(lf, q)) {
    if (f.type === "multi") lf.toggleOption(f.key, String(q.value));
    else lf.setValue(f.key, undefined);
    return;
  }
  switch (f.type) {
    case "toggle":
      return lf.setValue(f.key, true);
    case "multi":
      return lf.toggleOption(f.key, String(q.value));
    case "select":
      return lf.setValue(f.key, String(q.value));
    case "date":
      return lf.setValue(f.key, { preset: q.value as DatePreset });
    case "number":
      return lf.setValue(f.key, Number(q.value));
    case "range":
      return lf.setValue(f.key, q.value as RangeValue);
  }
}

export function FilterBar<T>({
  lf,
  noun,
  total,
  shown,
  quick,
  searchPlaceholder,
  onExport,
  trailing,
  className,
}: {
  lf: ListFilters<T>;
  /** [singular, plural] of what the list holds. */
  noun: [string, string];
  /** All rows before filtering; undefined while loading. */
  total?: number;
  /** Rows after filtering; undefined while loading. */
  shown?: number;
  quick?: QuickFilter[];
  searchPlaceholder?: string;
  /**
   * Export the rows the page is showing (it may fetch them all first). Return how many rows were written to
   * name them in the confirmation. Omit to hide the button.
   */
  onExport?: () => number | void | Promise<number | void>;
  /** Extra controls placed after the sort menu (e.g. a view switch). */
  trailing?: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [viewsOpen, setViewsOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const wide = useMediaQuery("(min-width: 768px)");
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  const closePanel = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  // Move focus into the inline panel when it opens (the sheet manages its own focus).
  useEffect(() => {
    if (open && wide) panelRef.current?.querySelector<HTMLElement>("[data-filter-fields] :is(input, button, select):not(:disabled)")?.focus();
  }, [open, wide]);

  const sortDef = lf.sorts.find((s) => s.key === lf.sort.key);
  const DirIcon = lf.sort.dir === "asc" ? ArrowUp : ArrowDown;
  const count =
    shown == null
      ? null
      : lf.hasFilters && total != null && total !== shown
        ? `${shown} of ${total} ${total === 1 ? noun[0] : noun[1]}`
        : `${shown} ${shown === 1 ? noun[0] : noun[1]}`;
  const hasFields = lf.fields.length > 0;
  const canClear = lf.hasFilters;

  const body = (
    <div data-filter-fields>
      <FilterFields lf={lf} />
    </div>
  );

  return (
    <div className={clsx("mb-4", className)}>
      <style>{SHEET_CSS}</style>
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={lf.search}
          onChange={lf.setSearch}
          placeholder={searchPlaceholder ?? `Search ${noun[1]}…`}
          aria-label={searchPlaceholder ?? `Search ${noun[1]}`}
          className="w-full sm:w-72 lg:w-80"
        />
        {hasFields && (
          <Button
            ref={triggerRef}
            leadingIcon={SlidersHorizontal}
            aria-expanded={open}
            aria-controls={wide ? panelId : undefined}
            aria-haspopup={wide ? undefined : "dialog"}
            onClick={() => setOpen((o) => !o)}
            className={clsx(open && "border-accent")}
          >
            <span className="hidden min-[400px]:inline">Advanced filters</span>
            <span className="min-[400px]:hidden">Filters</span>
            {lf.activeCount > 0 && (
              <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-accent-emphasis text-white text-[11px] font-semibold flex items-center justify-center tabular">
                {lf.activeCount}
              </span>
            )}
          </Button>
        )}

        <Menu.Root>
          <Menu.Trigger asChild>
            <Button leadingIcon={ArrowUpDown} aria-label={`Sort: ${sortDef?.label ?? ""}, ${lf.sort.dir === "asc" ? "ascending" : "descending"}`}>
              <span className="hidden sm:inline text-ink2 font-medium">Sort:</span>
              <span className="truncate max-w-[9rem]">{sortDef?.label ?? "Sort"}</span>
              <DirIcon size={14} aria-hidden className="text-ink2" />
            </Button>
          </Menu.Trigger>
          <Menu.Content align="start">
            <Menu.Label>Sort by</Menu.Label>
            <Menu.RadioGroup
              value={lf.sort.key}
              onValueChange={(k) => lf.setSort({ key: k, dir: lf.sorts.find((s) => s.key === k)?.firstDir ?? "asc" })}
            >
              {lf.sorts.map((s) => (
                <Menu.RadioItem key={s.key} value={s.key}>
                  {s.label}
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
            <Menu.Separator />
            <Menu.Label>Direction</Menu.Label>
            <Menu.RadioGroup value={lf.sort.dir} onValueChange={(d) => lf.setSort({ key: lf.sort.key, dir: d as SortDir })}>
              <Menu.RadioItem value="asc">Ascending</Menu.RadioItem>
              <Menu.RadioItem value="desc">Descending</Menu.RadioItem>
            </Menu.RadioGroup>
          </Menu.Content>
        </Menu.Root>

        {trailing}

        <Button leadingIcon={Bookmark} onClick={() => setViewsOpen(true)} aria-haspopup="dialog">
          <span className="hidden sm:inline">Views</span>
          <span className="sm:hidden sr-only">Saved views</span>
          {lf.views.length > 0 && <span className="text-xs text-ink3 tabular">{lf.views.length}</span>}
        </Button>
        {onExport && (
          <Button
            leadingIcon={Download}
            disabled={shown === 0}
            loading={exporting}
            onClick={async () => {
              setExporting(true);
              try {
                const n = (await onExport()) ?? shown;
                toast.success(`Exported ${n == null ? "" : `${n} `}${n === 1 ? noun[0] : noun[1]} to CSV`);
              } catch (e) {
                toast.error("Couldn't export", { description: e instanceof Error ? e.message : String(e) });
              } finally {
                setExporting(false);
              }
            }}
          >
            <span className="hidden sm:inline">Export CSV</span>
            <span className="sm:hidden sr-only">Export CSV</span>
          </Button>
        )}
        {count && (
          <span className="ml-auto text-[13px] text-ink2 tabular" role="status" aria-live="polite">
            {count}
          </span>
        )}
      </div>

      {quick && quick.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2.5" role="group" aria-label="Quick filters">
          {quick.map((q) => (
            <Pill key={q.id} on={quickOn(lf, q)} icon={q.icon} onClick={() => quickToggle(lf, q)}>
              {q.label}
            </Pill>
          ))}
        </div>
      )}

      {hasFields && open && wide && (
        <section
          id={panelId}
          ref={panelRef}
          aria-label="Advanced filters"
          className="glass rounded-2xl p-4 mt-3"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              closePanel();
            }
          }}
        >
          <div className="flex items-center justify-between gap-3 mb-3">
            <h2 className="text-sm font-semibold text-ink">Advanced filters</h2>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={lf.clearAll} disabled={!canClear}>
                Clear all
              </Button>
              <Button variant="primary" size="sm" onClick={closePanel}>
                Done
              </Button>
            </div>
          </div>
          {body}
        </section>
      )}
      {hasFields && !wide && (
        <Sheet
          open={open}
          onOpenChange={setOpen}
          title="Advanced filters"
          footer={
            <>
              <Button variant="ghost" onClick={lf.clearAll} disabled={!canClear}>
                Clear all
              </Button>
              <Button variant="primary" className="ml-auto" onClick={() => setOpen(false)}>
                {shown != null ? `Show ${shown} ${shown === 1 ? noun[0] : noun[1]}` : "Done"}
              </Button>
            </>
          }
        >
          {body}
        </Sheet>
      )}

      {lf.active.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mt-3" role="group" aria-label="Active filters">
          {lf.active.map((a) => (
            <span
              key={a.id}
              className="inline-flex items-center gap-1 h-7 pl-2.5 pr-1 rounded-full bg-accent-soft text-accent-strong text-[13px] font-medium max-w-full"
            >
              <span className="truncate">{a.text}</span>
              <button
                type="button"
                onClick={() => lf.removeActive(a)}
                aria-label={`Remove filter: ${a.text}`}
                className="w-5 h-5 rounded-full flex items-center justify-center hover:bg-[var(--glass-strong)] flex-none"
              >
                <X size={12} aria-hidden />
              </button>
            </span>
          ))}
          <button type="button" onClick={lf.clearAll} className="h-7 px-2 rounded-md text-[13px] font-medium text-accent hover:underline">
            Clear all
          </button>
        </div>
      )}

      <ViewsDialog lf={lf} open={viewsOpen} onOpenChange={setViewsOpen} />
    </div>
  );
}

// ------------------------------------------------------------ list helpers

/** The empty state for a filtered list: a reset button when filters hide everything, else the page's own message. */
export function FilterEmpty<T>({
  lf,
  icon,
  emptyTitle,
  emptyDescription,
  emptyAction,
}: {
  lf: ListFilters<T>;
  icon?: LucideIcon;
  /** Shown when there is simply nothing in the list (no filters applied). */
  emptyTitle: string;
  emptyDescription?: React.ReactNode;
  emptyAction?: React.ReactNode;
}) {
  if (lf.hasFilters) {
    return (
      <EmptyState
        icon={SearchX}
        title="No results match these filters"
        description="Try removing a filter, widening a range or searching for something else."
        action={
          <Button variant="primary" onClick={lf.clearAll}>
            Reset filters
          </Button>
        }
      />
    );
  }
  return <EmptyState icon={icon} title={emptyTitle} description={emptyDescription} action={emptyAction} />;
}

/** aria-sort value for a header cell of a hand-built table. */
export function ariaSortFor<T>(lf: ListFilters<T>, key: string): "ascending" | "descending" | undefined {
  return lf.sort.key === key ? (lf.sort.dir === "asc" ? "ascending" : "descending") : undefined;
}

/** A clickable column header for a hand-built table (DataTable has its own). Put it inside the <th>. */
export function SortHeader<T>({
  lf,
  sortKey,
  children,
  align = "left",
}: {
  lf: ListFilters<T>;
  sortKey: string;
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  const on = lf.sort.key === sortKey;
  const Icon = on ? (lf.sort.dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <button
      type="button"
      onClick={() => lf.toggleSort(sortKey)}
      className={clsx("group inline-flex items-center gap-1 rounded hover:text-ink", align === "right" && "flex-row-reverse", on && "text-ink")}
    >
      {children}
      <Icon size={13} aria-hidden className={clsx("transition-opacity", on ? "opacity-100" : "opacity-0 group-hover:opacity-60 group-focus-visible:opacity-60")} />
    </button>
  );
}
