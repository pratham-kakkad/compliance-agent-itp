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

export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function fmtWeek(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export function fmtMinutes(minutes: number | null | undefined): string {
  if (minutes == null) return "—";
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
