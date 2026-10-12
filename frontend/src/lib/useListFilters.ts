/**
 * Filter + sort state for a list page, kept in the URL query string so a view can be
 * shared, survives a refresh and the back button, and (for the sort) is remembered per page.
 *
 * The page declares its filter `fields` and `sorts`; <FilterBar> (components/ui/Filters.tsx)
 * renders them. Rows are filtered client-side with `lf.apply(rows)`, or the same state is
 * turned into backend query parameters with `lf.serverParams()` where the endpoint filters.
 *
 * URL scheme (every key is the field's `key`; other params on the page, e.g. `view`, are left alone):
 *   q=text                      search
 *   dept=Eng&dept=Ops           multi-select: repeat the param
 *   status=open                 single select
 *   due=last7 | due=2026-01-01..2026-02-01 | due=..2026-02-01
 *                               date range: a preset, or from..to (either end may be empty)
 *   rate=50..90 | rate=..40     numeric range: min..max
 *   overdue=1                   toggle
 *   waiting=3                   number ("longer than N days")
 *   sort=last_seen:desc         sort key and direction
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { useDebouncedValue } from "./useDebouncedValue";
import { getDisplayTimeZone, parseInstant } from "./format";

// ------------------------------------------------------------------- types

export type SortDir = "asc" | "desc";
export interface SortState {
  key: string;
  dir: SortDir;
}
export interface SortDef<T> {
  key: string;
  label: string;
  value: (row: T) => string | number | null | undefined;
  /** Direction the first click on this key uses (default asc). */
  firstDir?: SortDir;
  /** Backend `sort` value if it differs from `key`; null = the backend can't sort by this. */
  serverKey?: string | null;
}

export interface Option {
  value: string;
  label: string;
  count?: number;
}

export type DatePreset = "today" | "last7" | "last30" | "month" | "thisweek" | "next7" | "next30" | "overdue" | "custom";
export interface DateValue {
  preset: DatePreset;
  from?: string;
  to?: string;
}
export interface RangeValue {
  min?: number;
  max?: number;
}

interface FieldBase {
  key: string;
  label: string;
  icon?: LucideIcon;
  /** One line of help under the control. */
  hint?: string;
  /** Replace the active-filter chip text. */
  chip?: (value: never) => string;
  /** false = never sent to the backend (client-only filter). */
  server?: boolean;
  /** Backend parameter name when it isn't the key (date -> `<name>_from`/`<name>_to`, range -> `<name>_min`/`<name>_max`). */
  param?: string;
}

export interface MultiField<T> extends FieldBase {
  type: "multi";
  options: Option[];
  get?: (row: T) => string | string[] | null | undefined;
  test?: (row: T, value: string[]) => boolean;
}
export interface SelectField<T> extends FieldBase {
  type: "select";
  options: Option[];
  anyLabel?: string;
  get?: (row: T) => string | null | undefined;
  test?: (row: T, value: string) => boolean;
}
export interface DateField<T> extends FieldBase {
  type: "date";
  presets?: DatePreset[];
  /** An ISO date or date-time; instants are read as days in the organization time zone. */
  get?: (row: T) => string | null | undefined;
  test?: (row: T, value: DateValue) => boolean;
}
export interface RangeField<T> extends FieldBase {
  type: "range";
  /** Shown after the numbers, e.g. "%" or "days". */
  suffix?: string;
  /** Bounds the inputs accept. */
  min?: number;
  max?: number;
  step?: number;
  /** Multiply by this when sending to the backend (e.g. 0.01 for a percent). */
  paramScale?: number;
  get?: (row: T) => number | null | undefined;
  test?: (row: T, value: RangeValue) => boolean;
}
export interface ToggleField<T> extends FieldBase {
  type: "toggle";
  test?: (row: T) => boolean;
}
export interface NumberField<T> extends FieldBase {
  type: "number";
  /** e.g. "days" for "waiting longer than [3] days". */
  suffix?: string;
  min?: number;
  max?: number;
  test?: (row: T, value: number) => boolean;
}
export type FilterField<T> = MultiField<T> | SelectField<T> | DateField<T> | RangeField<T> | ToggleField<T> | NumberField<T>;

export type FilterValue = string[] | string | DateValue | RangeValue | boolean | number;
export type FilterValues = Record<string, FilterValue>;

export interface ActiveFilter {
  id: string;
  fieldKey: string;
  /** Present for one value of a multi-select, so the chip removes just that value. */
  optionValue?: string;
  text: string;
}

export interface SavedView {
  id: string;
  name: string;
  /** The filter/sort part of the query string. */
  query: string;
}

export interface ListFilterOptions<T> {
  /** Stable page id: the key for the remembered sort and the saved views. */
  id: string;
  fields: FilterField<T>[];
  sorts: SortDef<T>[];
  defaultSort: SortState;
  /** Further sort keys that break ties after the chosen one. */
  tieBreak?: SortState[];
  /** What the search box looks at (client-side filtering). */
  searchText?: (row: T) => string;
  /** Query-string key of the search text in the page URL (default "q"). */
  searchParam?: string;
  /** Backend parameter for the search text when it differs from the URL key. */
  serverSearchParam?: string;
}

export interface ListFilters<T> {
  id: string;
  fields: FilterField<T>[];
  sorts: SortDef<T>[];
  /** What is in the search box right now. */
  search: string;
  setSearch: (v: string) => void;
  /** The search text that is applied (debounced, trimmed). */
  query: string;
  values: FilterValues;
  setValue: (key: string, value: FilterValue | undefined) => void;
  toggleOption: (key: string, option: string) => void;
  removeActive: (a: ActiveFilter) => void;
  clearAll: () => void;
  active: ActiveFilter[];
  /** Fields with a value (not counting the search text). */
  activeCount: number;
  /** Any filter or search text applied. */
  hasFilters: boolean;
  sort: SortState;
  setSort: (s: SortState) => void;
  toggleSort: (key: string) => void;
  filterRows: (rows: T[]) => T[];
  sortRows: (rows: T[]) => T[];
  /** filterRows then sortRows. */
  apply: (rows: T[]) => T[];
  /** The current state as backend query parameters (see each field's `param`). */
  serverParams: (opts?: { sort?: boolean }) => URLSearchParams;
  views: SavedView[];
  saveView: (name: string) => void;
  applyView: (v: SavedView) => void;
  deleteView: (id: string) => void;
}

// ------------------------------------------------------------------- dates

export const DATE_PRESET_LABEL: Record<DatePreset, string> = {
  today: "Today",
  last7: "Last 7 days",
  last30: "Last 30 days",
  month: "This month",
  thisweek: "This week",
  next7: "Next 7 days",
  next30: "Next 30 days",
  overdue: "Overdue",
  custom: "Custom",
};
const ALL_PRESETS = new Set<string>(Object.keys(DATE_PRESET_LABEL));
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const dayFormats = new Map<string, Intl.DateTimeFormat>();
/** "YYYY-MM-DD" of an instant as seen in the organization time zone; a date-only string is already a day. */
export function dayKey(value: string | Date): string {
  if (typeof value === "string" && DAY.test(value)) return value;
  const d = typeof value === "string" ? parseInstant(value) : value;
  if (Number.isNaN(d.getTime())) return "";
  const tz = getDisplayTimeZone();
  let f = dayFormats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    dayFormats.set(tz, f);
  }
  return f.format(d);
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The first and last day a preset stands for, counted from `today` (a day key). */
export function presetRange(preset: DatePreset, today: string): { from?: string; to?: string } {
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "last7":
      return { from: addDays(today, -6), to: today };
    case "last30":
      return { from: addDays(today, -29), to: today };
    case "month": {
      const first = `${today.slice(0, 7)}-01`;
      const next = new Date(`${first}T00:00:00Z`);
      next.setUTCMonth(next.getUTCMonth() + 1);
      return { from: first, to: addDays(next.toISOString().slice(0, 10), -1) };
    }
    case "thisweek": {
      const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
      return { from: addDays(today, -dow), to: addDays(today, 6 - dow) };
    }
    case "next7":
      return { from: today, to: addDays(today, 6) };
    case "next30":
      return { from: today, to: addDays(today, 29) };
    case "overdue":
      return { to: addDays(today, -1) };
    default:
      return {};
  }
}

export function resolveDate(v: DateValue, today = dayKey(new Date())): { from?: string; to?: string } {
  return v.preset === "custom" ? { from: v.from, to: v.to } : presetRange(v.preset, today);
}

function fmtShortDay(day: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
}

export function describeDate(v: DateValue): string {
  if (v.preset !== "custom") return DATE_PRESET_LABEL[v.preset];
  if (v.from && v.to) return v.from === v.to ? fmtShortDay(v.from) : `${fmtShortDay(v.from)} – ${fmtShortDay(v.to)}`;
  if (v.from) return `from ${fmtShortDay(v.from)}`;
  if (v.to) return `until ${fmtShortDay(v.to)}`;
  return "Custom";
}

export function describeRange(f: { suffix?: string }, v: RangeValue): string {
  const s = f.suffix ? (f.suffix === "%" ? "%" : ` ${f.suffix}`) : "";
  if (v.min != null && v.max != null) return v.min === v.max ? `${v.min}${s}` : `${v.min}–${v.max}${s}`;
  if (v.min != null) return `at least ${v.min}${s}`;
  return `at most ${v.max}${s}`;
}

// --------------------------------------------------------------- URL coding

const RANGE_RE = /^(-?\d+(?:\.\d+)?)?\.\.(-?\d+(?:\.\d+)?)?$/;
const CUSTOM_DATE_RE = /^(\d{4}-\d{2}-\d{2})?\.\.(\d{4}-\d{2}-\d{2})?$/;

function decode<T>(f: FilterField<T>, raw: string[]): FilterValue | undefined {
  const first = raw[0];
  switch (f.type) {
    case "multi": {
      const vals = Array.from(new Set(raw.filter(Boolean)));
      return vals.length ? vals : undefined;
    }
    case "select":
      return first ? first : undefined;
    case "date": {
      if (!first) return undefined;
      if (first !== "custom" && ALL_PRESETS.has(first)) return { preset: first as DatePreset };
      const m = CUSTOM_DATE_RE.exec(first);
      if (m && (m[1] || m[2])) return { preset: "custom", from: m[1], to: m[2] };
      return undefined;
    }
    case "range": {
      const m = first ? RANGE_RE.exec(first) : null;
      if (!m || (m[1] === undefined && m[2] === undefined)) return undefined;
      return { min: m[1] !== undefined ? Number(m[1]) : undefined, max: m[2] !== undefined ? Number(m[2]) : undefined };
    }
    case "toggle":
      return first === "1" ? true : undefined;
    case "number": {
      const n = Number(first);
      return first && Number.isFinite(n) && n > 0 ? n : undefined;
    }
  }
}

function encode<T>(f: FilterField<T>, value: FilterValue): string[] {
  switch (f.type) {
    case "multi":
      return value as string[];
    case "select":
      return [value as string];
    case "date": {
      const v = value as DateValue;
      return [v.preset === "custom" ? `${v.from ?? ""}..${v.to ?? ""}` : v.preset];
    }
    case "range": {
      const v = value as RangeValue;
      return [`${v.min ?? ""}..${v.max ?? ""}`];
    }
    case "toggle":
      return ["1"];
    case "number":
      return [String(value)];
  }
}

function isEmpty(f: FilterField<never>, v: FilterValue | undefined): boolean {
  if (v === undefined || v === null) return true;
  switch (f.type) {
    case "multi":
      return (v as string[]).length === 0;
    case "select":
      return v === "";
    case "date": {
      const d = v as DateValue;
      return d.preset === "custom" && !d.from && !d.to;
    }
    case "range": {
      const r = v as RangeValue;
      return r.min == null && r.max == null;
    }
    case "toggle":
      return v !== true;
    case "number":
      return !(typeof v === "number" && v > 0);
  }
}

// ---------------------------------------------------------------- storage

function readJson<V>(key: string, fallback: V): V {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as V) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private window or blocked storage: the remembered state just doesn't persist */
  }
}

function parseSort(raw: string | null, valid: Set<string>): SortState | null {
  if (!raw) return null;
  const [key, dir] = raw.split(":");
  if (!valid.has(key)) return null;
  return { key, dir: dir === "desc" ? "desc" : "asc" };
}

function compare(a: string | number | null | undefined, b: string | number | null | undefined, dir: SortDir): number {
  // Missing values sink to the bottom whichever way the list is sorted.
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  const c = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  return dir === "asc" ? c : -c;
}

// -------------------------------------------------------------------- hook

export function useListFilters<T>(opts: ListFilterOptions<T>): ListFilters<T> {
  const { id, fields, sorts, defaultSort, searchParam = "q", serverSearchParam = searchParam } = opts;
  const [params, setParams] = useSearchParams();
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  /** Apply `mutate` to the current query string and replace the URL entry (no history spam while filtering). */
  const write = useCallback(
    (mutate: (p: URLSearchParams) => void) => {
      const next = new URLSearchParams(paramsRef.current);
      mutate(next);
      if (next.toString() === paramsRef.current.toString()) return;
      paramsRef.current = next;
      setParams(next, { replace: true });
    },
    [setParams]
  );

  // ----- filter values, decoded from the URL
  const paramsKey = params.toString();
  const values = useMemo(() => {
    const out: FilterValues = {};
    for (const f of optsRef.current.fields) {
      const v = decode(f, params.getAll(f.key));
      if (v !== undefined) out[f.key] = v;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramsKey]);

  // ----- search: typed text is local, the debounced text goes to the URL
  const urlQ = params.get(searchParam) ?? "";
  const [search, setSearch] = useState(urlQ);
  const debounced = useDebouncedValue(search.trim(), 250);
  const lastWritten = useRef(urlQ);
  useEffect(() => {
    // The URL changed by something other than us (back button, saved view): show it.
    if (urlQ !== lastWritten.current) {
      lastWritten.current = urlQ;
      setSearch(urlQ);
    }
  }, [urlQ]);
  useEffect(() => {
    if (debounced === lastWritten.current) return;
    lastWritten.current = debounced;
    write((p) => (debounced ? p.set(searchParam, debounced) : p.delete(searchParam)));
  }, [debounced, searchParam, write]);

  // ----- sort: URL, else the page's remembered choice, else the default
  const sortKeys = useMemo(() => new Set(sorts.map((s) => s.key)), [sorts]);
  const [remembered, setRemembered] = useState<SortState | null>(() => parseSort(readJson<string | null>(`mc-sort:${id}`, null), sortKeys));
  const picked = parseSort(params.get("sort"), sortKeys) ?? remembered ?? defaultSort;
  const sort = useMemo<SortState>(() => ({ key: picked.key, dir: picked.dir }), [picked.key, picked.dir]);
  const setSort = useCallback(
    (s: SortState) => {
      write((p) => p.set("sort", `${s.key}:${s.dir}`));
      setRemembered(s);
      writeJson(`mc-sort:${id}`, `${s.key}:${s.dir}`);
    },
    [write, id]
  );
  const toggleSort = useCallback(
    (key: string) => {
      const def = optsRef.current.sorts.find((s) => s.key === key);
      const cur = parseSort(paramsRef.current.get("sort"), sortKeys) ?? remembered ?? optsRef.current.defaultSort;
      setSort(cur.key === key ? { key, dir: cur.dir === "asc" ? "desc" : "asc" } : { key, dir: def?.firstDir ?? "asc" });
    },
    [setSort, sortKeys, remembered]
  );

  // ----- changing filters
  const setValue = useCallback(
    (key: string, value: FilterValue | undefined) => {
      const f = optsRef.current.fields.find((x) => x.key === key);
      if (!f) return;
      write((p) => {
        p.delete(key);
        if (value !== undefined && !isEmpty(f as FilterField<never>, value)) for (const s of encode(f, value)) p.append(key, s);
      });
    },
    [write]
  );
  const toggleOption = useCallback(
    (key: string, option: string) => {
      const cur = (decode(optsRef.current.fields.find((x) => x.key === key)!, paramsRef.current.getAll(key)) as string[] | undefined) ?? [];
      setValue(key, cur.includes(option) ? cur.filter((v) => v !== option) : [...cur, option]);
    },
    [setValue]
  );
  const clearAll = useCallback(() => {
    setSearch("");
    lastWritten.current = "";
    write((p) => {
      p.delete(searchParam);
      for (const f of optsRef.current.fields) p.delete(f.key);
    });
  }, [write, searchParam]);

  // ----- active filters as chips
  const active = useMemo(() => {
    const list: ActiveFilter[] = [];
    if (urlQ) list.push({ id: "q", fieldKey: searchParam, text: `Search: “${urlQ}”` });
    for (const f of fields) {
      const v = values[f.key];
      if (v === undefined) continue;
      const custom = (f.chip as ((v: FilterValue) => string) | undefined)?.(v);
      switch (f.type) {
        case "multi":
          for (const o of v as string[]) list.push({ id: `${f.key}:${o}`, fieldKey: f.key, optionValue: o, text: `${f.label}: ${f.options.find((x) => x.value === o)?.label ?? o}` });
          break;
        case "select":
          list.push({ id: f.key, fieldKey: f.key, text: custom ?? `${f.label}: ${f.options.find((x) => x.value === v)?.label ?? v}` });
          break;
        case "date":
          list.push({ id: f.key, fieldKey: f.key, text: custom ?? `${f.label}: ${describeDate(v as DateValue)}` });
          break;
        case "range":
          list.push({ id: f.key, fieldKey: f.key, text: custom ?? `${f.label}: ${describeRange(f, v as RangeValue)}` });
          break;
        case "toggle":
          list.push({ id: f.key, fieldKey: f.key, text: custom ?? f.label });
          break;
        case "number":
          list.push({ id: f.key, fieldKey: f.key, text: custom ?? `${f.label}: ${v}${f.suffix ? ` ${f.suffix}` : ""}` });
          break;
      }
    }
    return list;
  }, [fields, values, urlQ, searchParam]);

  const removeActive = useCallback(
    (a: ActiveFilter) => {
      if (a.id === "q") {
        setSearch("");
        lastWritten.current = "";
        write((p) => p.delete(searchParam));
      } else if (a.optionValue !== undefined) toggleOption(a.fieldKey, a.optionValue);
      else setValue(a.fieldKey, undefined);
    },
    [write, searchParam, toggleOption, setValue]
  );

  // ----- applying to rows
  const filterRows = useCallback(
    (rows: T[]): T[] => {
      const needle = urlQ.trim().toLowerCase();
      const today = dayKey(new Date());
      const tests: ((row: T) => boolean)[] = [];
      const searchText = optsRef.current.searchText;
      if (needle && searchText) tests.push((r) => searchText(r).toLowerCase().includes(needle));
      for (const f of fields) {
        const v = values[f.key];
        if (v === undefined) continue;
        switch (f.type) {
          case "multi": {
            const sel = v as string[];
            if (f.test) tests.push((r) => f.test!(r, sel));
            else if (f.get) tests.push((r) => [f.get!(r)].flat().some((x) => x != null && sel.includes(x)));
            break;
          }
          case "select":
            if (f.test) tests.push((r) => f.test!(r, v as string));
            else if (f.get) tests.push((r) => f.get!(r) === v);
            break;
          case "date": {
            const dv = v as DateValue;
            if (f.test) tests.push((r) => f.test!(r, dv));
            else if (f.get) {
              const { from, to } = resolveDate(dv, today);
              tests.push((r) => {
                const raw = f.get!(r);
                if (!raw) return false;
                const day = dayKey(raw);
                return (!from || day >= from) && (!to || day <= to);
              });
            }
            break;
          }
          case "range": {
            const rv = v as RangeValue;
            if (f.test) tests.push((r) => f.test!(r, rv));
            else if (f.get)
              tests.push((r) => {
                const n = f.get!(r);
                return n != null && (rv.min == null || n >= rv.min) && (rv.max == null || n <= rv.max);
              });
            break;
          }
          case "toggle":
            if (f.test) tests.push((r) => f.test!(r));
            break;
          case "number":
            if (f.test) tests.push((r) => f.test!(r, v as number));
            break;
        }
      }
      return tests.length ? rows.filter((r) => tests.every((t) => t(r))) : rows;
    },
    [fields, values, urlQ]
  );

  const sortRows = useCallback(
    (rows: T[]): T[] => {
      const chain = [sort, ...(optsRef.current.tieBreak ?? [])]
        .map((s) => ({ def: sorts.find((d) => d.key === s.key), dir: s.dir }))
        .filter((c): c is { def: SortDef<T>; dir: SortDir } => c.def !== undefined);
      if (!chain.length) return rows;
      return [...rows].sort((a, b) => {
        for (const { def, dir } of chain) {
          const c = compare(def.value(a), def.value(b), dir);
          if (c !== 0) return c;
        }
        return 0;
      });
    },
    [sort, sorts]
  );

  const apply = useCallback((rows: T[]) => sortRows(filterRows(rows)), [sortRows, filterRows]);

  // ----- backend parameters
  const serverParams = useCallback(
    (o?: { sort?: boolean }): URLSearchParams => {
      const out = new URLSearchParams();
      if (urlQ) out.set(serverSearchParam, urlQ);
      const today = dayKey(new Date());
      for (const f of fields) {
        const v = values[f.key];
        if (v === undefined || f.server === false) continue;
        const name = f.param ?? f.key;
        switch (f.type) {
          case "multi":
            for (const s of v as string[]) out.append(name, s);
            break;
          case "select":
            out.set(name, v as string);
            break;
          case "date": {
            const { from, to } = resolveDate(v as DateValue, today);
            if (from) out.set(`${name}_from`, from);
            if (to) out.set(`${name}_to`, to);
            break;
          }
          case "range": {
            const r = v as RangeValue;
            const k = f.paramScale ?? 1;
            if (r.min != null) out.set(`${name}_min`, String(+(r.min * k).toFixed(6)));
            if (r.max != null) out.set(`${name}_max`, String(+(r.max * k).toFixed(6)));
            break;
          }
          case "toggle":
            out.set(name, "true");
            break;
          case "number":
            out.set(name, String(v));
            break;
        }
      }
      if (o?.sort !== false) {
        const def = sorts.find((s) => s.key === sort.key);
        const key = def?.serverKey === undefined ? def?.key : def.serverKey;
        if (key) {
          out.set("sort", key);
          out.set("dir", sort.dir);
        }
      }
      return out;
    },
    [fields, values, urlQ, serverSearchParam, sorts, sort]
  );

  // ----- saved views
  const [views, setViews] = useState<SavedView[]>(() => readJson<SavedView[]>(`mc-views:${id}`, []));
  const persist = (next: SavedView[]) => {
    setViews(next);
    writeJson(`mc-views:${id}`, next);
  };
  const ownKeys = () => [searchParam, "sort", ...optsRef.current.fields.map((f) => f.key)];
  const saveView = (name: string) => {
    const q = new URLSearchParams();
    for (const k of ownKeys()) for (const v of paramsRef.current.getAll(k)) q.append(k, v);
    // The sort in effect is part of the view even when it came from the remembered default.
    q.set("sort", `${sort.key}:${sort.dir}`);
    const clean = name.trim().slice(0, 60);
    if (!clean) return;
    persist([...views.filter((v) => v.name.toLowerCase() !== clean.toLowerCase()), { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: clean, query: q.toString() }]);
  };
  const applyView = (v: SavedView) => {
    const saved = new URLSearchParams(v.query);
    const nextQ = saved.get(searchParam) ?? "";
    lastWritten.current = nextQ;
    setSearch(nextQ);
    write((p) => {
      for (const k of ownKeys()) p.delete(k);
      saved.forEach((val, k) => p.append(k, val));
    });
    const s = parseSort(saved.get("sort"), sortKeys);
    if (s) {
      setRemembered(s);
      writeJson(`mc-sort:${id}`, `${s.key}:${s.dir}`);
    }
  };
  const deleteView = (viewId: string) => persist(views.filter((v) => v.id !== viewId));

  return {
    id,
    fields,
    sorts,
    search,
    setSearch,
    query: urlQ,
    values,
    setValue,
    toggleOption,
    removeActive,
    clearAll,
    active,
    activeCount: Object.keys(values).length,
    hasFilters: Boolean(urlQ) || Object.keys(values).length > 0,
    sort,
    setSort,
    toggleSort,
    filterRows,
    sortRows,
    apply,
    serverParams,
    views,
    saveView,
    applyView,
    deleteView,
  };
}
