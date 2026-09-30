export function initials(name: string): string {
  return (name || "?")
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function pct(rate: number | null | undefined): string {
  return rate == null ? "—" : `${Math.round(rate * 100)}%`;
}

export type RateClass = "good" | "warn" | "crit";

export function rateClass(rate: number | null | undefined): RateClass {
  if (rate == null) return "warn";
  if (rate >= 0.9) return "good";
  if (rate >= 0.75) return "warn";
  return "crit";
}

export type Tone = "neutral" | "accent" | "good" | "warn" | "crit";

/** Like rateClass, but a missing rate is neutral rather than a warning. */
export function rateTone(rate: number | null | undefined): Tone {
  return rate == null ? "neutral" : rateClass(rate);
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function rateColorVar(rate: number | null | undefined): string {
  const cls = rate == null ? "neutral" : rateClass(rate);
  return `var(--${cls})`;
}

// --- Time zones -------------------------------------------------------------
//
// Every instant from the API is a UTC timestamp. It is shown in the
// organization's time zone (Settings → Time zone), not the viewer's browser
// zone, so everyone sees the same punch times and the same attendance days.
// SettingsProvider calls setDisplayTimeZone() before the app renders.
//
// Date-only values ("2026-09-22": work dates, week starts) are calendar dates,
// not instants: they are never shifted by any zone.

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** A date-time with no offset or "Z" — the backend stores UTC, so read it as UTC. */
const NAIVE_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

let displayTimeZone = "UTC";

/** True when this browser's Intl data knows `timeZone`. */
export function isSupportedTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Set the zone every fmt* helper formats instants in. Unknown zones fall back to UTC. Returns the zone applied. */
export function setDisplayTimeZone(timeZone: string | null | undefined): string {
  displayTimeZone = timeZone && isSupportedTimeZone(timeZone) ? timeZone : "UTC";
  return displayTimeZone;
}

export function getDisplayTimeZone(): string {
  return displayTimeZone;
}

/** The viewer's own browser time zone, or null if the browser won't say. */
export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Cached Intl formatter (tables format hundreds of cells) in the viewer's locale. */
function formatter(timeZone: string, opts: Intl.DateTimeFormatOptions, locale?: string): Intl.DateTimeFormat {
  const key = `${locale ?? ""}|${timeZone}|${JSON.stringify(opts)}`;
  let f = formatters.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(locale, { ...opts, timeZone });
    } catch {
      f = new Intl.DateTimeFormat(locale, { ...opts, timeZone: "UTC" });
    }
    formatters.set(key, f);
  }
  return f;
}

export function isDateOnly(value: string): boolean {
  return DATE_ONLY.test(value);
}

/**
 * Parse an API timestamp. "YYYY-MM-DD" becomes UTC midnight of that calendar
 * date; a date-time without an offset is read as UTC; anything else (offset or
 * "Z") is parsed as-is.
 */
export function parseInstant(value: string): Date {
  if (DATE_ONLY.test(value)) return new Date(`${value}T00:00:00Z`);
  if (NAIVE_DATETIME.test(value)) return new Date(`${value.replace(" ", "T")}Z`);
  return new Date(value);
}

/** Format an instant in `timeZone`; date-only strings are formatted as plain calendar dates. */
function format(value: string, opts: Intl.DateTimeFormatOptions, timeZone = displayTimeZone): string {
  const d = parseInstant(value);
  if (Number.isNaN(d.getTime())) return "—";
  return formatter(DATE_ONLY.test(value) ? "UTC" : timeZone, opts).format(d);
}

/** "Sep 22, 9:02 AM" in the organization's time zone. */
export function fmtDate(iso: string): string {
  return format(iso, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** "9:02 AM" in the organization's time zone. */
export function fmtTime(iso: string): string {
  return format(iso, { hour: "numeric", minute: "2-digit" });
}

/** "Sep 22" — a week-start date. */
export function fmtWeek(iso: string): string {
  return format(iso, { month: "short", day: "numeric" });
}

/** "Tue, Sep 22" — a work date. */
export function fmtDay(iso: string): string {
  return format(iso, { weekday: "short", month: "short", day: "numeric" });
}

/** "Sep 22, 2026, 9:02 AM" in the organization's time zone — for audit lines like "last changed on …". */
export function fmtDateTime(iso: string): string {
  return format(iso, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** "Tue, Sep 29, 2026" — the date of `at` as seen in `timeZone`. */
export function fmtZonedDate(at: Date, timeZone: string): string {
  return formatter(timeZone, { weekday: "short", year: "numeric", month: "short", day: "numeric" }).format(at);
}

/** "3:04 PM" — the wall-clock time of `at` in `timeZone`. */
export function fmtZonedTime(at: Date, timeZone: string): string {
  return formatter(timeZone, { hour: "numeric", minute: "2-digit" }).format(at);
}

/** Minutes `timeZone` is ahead of UTC at instant `at` (DST-aware; negative west of UTC). */
export function zoneOffsetMinutes(timeZone: string, at: Date = new Date()): number {
  const parts = formatter(
    timeZone,
    { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false },
    "en-US"
  ).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const hour = get("hour") % 24; // some engines render midnight as "24" with hour12: false
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  const instant = Math.floor(at.getTime() / 1000) * 1000;
  return Math.round((wall - instant) / 60000);
}

/** "+05:30" / "-04:00" / "+00:00" for an offset in minutes. */
export function fmtOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** "UTC+05:30" — the current offset of `timeZone`. */
export function utcOffsetLabel(timeZone: string, at: Date = new Date()): string {
  return `UTC${fmtOffset(zoneOffsetMinutes(timeZone, at))}`;
}

export function fmtMinutes(minutes: number | null | undefined): string {
  if (minutes == null) return "—";
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
