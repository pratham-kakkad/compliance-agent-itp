import { useId } from "react";
import clsx from "clsx";
import { motion } from "framer-motion";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import type { Tone } from "../../lib/format";
import { duration, ease, prefersReducedMotion } from "../../lib/motion";
import { fmtDelta, isFlat, isSevere, type Kpi } from "../../lib/dashboards";
import { Tooltip } from "../ui";

/* Reusable dashboard visuals. Colours come from the CSS tokens (--chart-1..6, --good, --warn, --crit), so they follow
   the theme; red (--crit) only ever marks a value that is itself critical. Everything animates in, and honours
   prefers-reduced-motion. */

const BAR_CLASS: Record<Tone, string> = {
  neutral: "bar-neutral",
  accent: "bar-accent",
  good: "bar-good",
  warn: "bar-warn",
  crit: "bar-crit",
};

export const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-ink",
  accent: "text-info",
  good: "text-good",
  warn: "text-warn",
  crit: "text-crit",
};

/** Gradient pairs for categorical series, in --chart-N order (indigo, cyan, emerald, amber, pink, violet). */
export const SERIES = [1, 2, 3, 4, 5, 6].map((n) => `var(--chart-${n})`);
export function seriesGradient(i: number): string {
  const a = SERIES[i % SERIES.length];
  const b = SERIES[(i + 1) % SERIES.length];
  return `linear-gradient(90deg, ${a}, ${b})`;
}

const dur = () => (prefersReducedMotion() ? 0 : duration.chart + 0.2);

/* ----------------------------------------------------------------- delta chip */

/**
 * "+4.2 pts vs previous 30 days": an arrow, the change, coloured by whether it is an improvement. A worsening is amber,
 * and red only when it is large. With no `good` direction the chip is neutral. No previous value: a muted note.
 */
export function DeltaChip({
  kpi,
  days,
  compact,
  className,
}: {
  kpi: Pick<Kpi, "unit" | "delta" | "previous" | "good_direction" | "compare_label">;
  days: number;
  compact?: boolean;
  className?: string;
}) {
  const what = kpi.compare_label ?? `vs previous ${days} days`;
  if (kpi.delta == null) {
    return <span className={clsx("text-[11.5px] text-ink3", className)}>{kpi.compare_label === "snapshot" ? "Current snapshot" : "No earlier period to compare"}</span>;
  }
  const flat = isFlat(kpi.unit, kpi.delta);
  const up = kpi.delta > 0;
  const improved = kpi.good_direction ? (kpi.good_direction === "up") === up : null;
  const tone = flat || improved === null ? "neutral" : improved ? "good" : isSevere(kpi, kpi.delta) ? "crit" : "warn";
  const Icon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={clsx("inline-flex items-center gap-1.5 min-w-0", className)}>
      <span
        className={clsx(
          "inline-flex items-center gap-0.5 rounded-full px-1.5 py-px text-[11.5px] font-semibold tabular whitespace-nowrap",
          tone === "good" && "bg-good-bg text-good",
          tone === "warn" && "bg-warn-bg text-warn",
          tone === "crit" && "bg-crit-bg text-crit",
          tone === "neutral" && "bg-neutral-bg text-ink2"
        )}
      >
        <Icon size={12} aria-hidden />
        {flat ? "No change" : fmtDelta(kpi.unit, kpi.delta)}
      </span>
      {!compact && <span className="text-[11.5px] text-ink3 truncate">{what}</span>}
    </span>
  );
}

/** A small delta in a list row (points or a count), without the sentence. */
export function MiniDelta({ delta, unit = "percent", goodUp = true }: { delta: number | null | undefined; unit?: Kpi["unit"]; goodUp?: boolean }) {
  if (delta == null || isFlat(unit, delta)) return null;
  const up = delta > 0;
  const good = goodUp === up;
  return (
    <span className={clsx("inline-flex items-center text-[11px] font-semibold tabular whitespace-nowrap", good ? "text-good" : "text-warn")}>
      {up ? <ArrowUpRight size={11} aria-hidden /> : <ArrowDownRight size={11} aria-hidden />}
      {fmtDelta(unit, delta).replace(" pts", "")}
    </span>
  );
}

/* ----------------------------------------------------------------- target bar */

/** A progress bar with an optional tick for the target. `value` and `target` are fractions of the track (0..1). */
export function TargetBar({ value, target, tone = "accent", height = 6, className }: { value: number | null; target?: number | null; tone?: Tone; height?: number; className?: string }) {
  const v = value == null ? 0 : Math.max(0, Math.min(1, value));
  return (
    <div className={clsx("relative rounded-full bg-neutral-bg", className)} style={{ height }} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value == null ? undefined : Math.round(v * 100)}>
      <div className="absolute inset-0 overflow-hidden rounded-full">
        <motion.div
          className={clsx("h-full rounded-full bar-fill", BAR_CLASS[tone])}
          initial={{ width: 0 }}
          animate={{ width: `${v * 100}%` }}
          transition={{ duration: dur(), ease: ease.decelerate }}
        />
      </div>
      {target != null && (
        <span
          className="absolute -top-[3px] -bottom-[3px] w-[2px] rounded-full bg-ink opacity-60"
          style={{ left: `calc(${Math.max(0, Math.min(1, target)) * 100}% - 1px)` }}
          title={`Target ${Math.round(target * 100)}%`}
          aria-hidden
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------- radial gauge */

const RING_GRAD: Record<string, [string, string]> = {
  good: ["var(--chart-3)", "var(--chart-2)"],
  warn: ["var(--chart-4)", "#f97316"],
  crit: ["#f43f5e", "var(--crit)"],
  accent: ["var(--chart-1)", "var(--chart-2)"],
  neutral: ["var(--chart-1)", "var(--chart-6)"],
};

/** A circular progress gauge (a ring that fills to `value`, 0..1) with a tick at `target` and content in the middle. */
export function ProgressRing({
  value,
  target,
  tone = "accent",
  size = 132,
  stroke = 12,
  children,
  label,
}: {
  value: number | null;
  target?: number | null;
  tone?: Tone;
  size?: number;
  stroke?: number;
  children?: React.ReactNode;
  label?: string;
}) {
  const id = useId().replace(/:/g, "");
  const r = (size - stroke) / 2;
  const c = size / 2;
  const v = value == null ? 0 : Math.max(0, Math.min(1, value));
  const [a, b] = RING_GRAD[tone] ?? RING_GRAD.accent;
  const tick = target != null ? target * 2 * Math.PI - Math.PI / 2 : null;
  return (
    <div className="relative flex-none" style={{ width: size, height: size }} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value == null ? undefined : Math.round(v * 100)}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="block" aria-hidden>
        <defs>
          <linearGradient id={`rg${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" style={{ stopColor: a }} />
            <stop offset="100%" style={{ stopColor: b }} />
          </linearGradient>
        </defs>
        <circle cx={c} cy={c} r={r} fill="none" strokeWidth={stroke} style={{ stroke: "var(--neutral-bg)" }} />
        {value != null && (
          <motion.circle
            cx={c}
            cy={c}
            r={r}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            stroke={`url(#rg${id})`}
            pathLength={1}
            strokeDasharray="1 1"
            transform={`rotate(-90 ${c} ${c})`}
            initial={{ strokeDashoffset: 1 }}
            animate={{ strokeDashoffset: 1 - v }}
            transition={{ duration: dur() + 0.2, ease: ease.decelerate }}
          />
        )}
        {tick != null && (
          <line
            x1={c + (r - stroke * 0.8) * Math.cos(tick)}
            y1={c + (r - stroke * 0.8) * Math.sin(tick)}
            x2={c + (r + stroke * 0.8) * Math.cos(tick)}
            y2={c + (r + stroke * 0.8) * Math.sin(tick)}
            strokeWidth={2.5}
            strokeLinecap="round"
            style={{ stroke: "var(--text)" }}
            opacity={0.55}
          />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none">{children}</div>
    </div>
  );
}

/* ---------------------------------------------------------------- ranked bars */

export interface RankedRow {
  key: string;
  label: string;
  sub?: React.ReactNode;
  /** The bar length as a fraction (0..1). null draws an empty track. */
  value: number | null;
  /** Text at the right end; defaults to the value as a percentage. */
  display?: string;
  /** Colours the bar and the value by status; without it the bar takes a categorical colour by position. */
  tone?: Tone;
  delta?: number | null;
  /** Which way is better for `delta` (default: up). */
  goodUp?: boolean;
  badge?: React.ReactNode;
  onClick?: () => void;
  leading?: React.ReactNode;
}

/** Horizontal ranked bars: a label, a gradient bar (staggered entrance), the value and its change, an optional target tick. */
export function RankedBars({ rows, target, empty, dense }: { rows: RankedRow[]; target?: number | null; empty?: React.ReactNode; dense?: boolean }) {
  if (!rows.length) return <>{empty}</>;
  return (
    <ul className={clsx("flex flex-col", dense ? "gap-2.5" : "gap-3.5")}>
      {rows.map((r, i) => {
        const Comp = r.onClick ? "button" : "div";
        const shown = r.display ?? (r.value == null ? "—" : `${Math.round(r.value * 100)}%`);
        return (
          <li key={r.key} className="-mx-1.5">
            <Comp
              type={r.onClick ? "button" : undefined}
              onClick={r.onClick}
              className={clsx("w-full text-left block rounded-md px-1.5 py-1", r.onClick && "hover:bg-panel2/70 transition-colors focus-ring")}
            >
              <div className="flex items-center gap-2 mb-1.5">
                {r.leading}
                <span className="text-[13.5px] font-semibold text-ink truncate min-w-0 flex-1" title={r.label}>
                  {r.label}
                </span>
                {r.badge}
                <MiniDelta delta={r.delta} goodUp={r.goodUp} />
                <span className={clsx("text-[13.5px] font-semibold tabular whitespace-nowrap", r.tone ? TONE_TEXT[r.tone] : "text-ink")}>{shown}</span>
              </div>
              <div className="relative h-[9px] rounded-full bg-neutral-bg">
                <div className="absolute inset-0 overflow-hidden rounded-full">
                  <motion.div
                    className={clsx("h-full rounded-full bar-fill", r.tone && BAR_CLASS[r.tone])}
                    style={r.tone ? undefined : ({ ["--bar-grad" as string]: seriesGradient(i) } as React.CSSProperties)}
                    initial={{ width: 0 }}
                    animate={{ width: `${Math.max(0, Math.min(1, r.value ?? 0)) * 100}%` }}
                    transition={{ duration: dur(), ease: ease.decelerate, delay: prefersReducedMotion() ? 0 : i * 0.06 }}
                  />
                </div>
                {target != null && (
                  <span className="absolute -top-[3px] -bottom-[3px] w-[2px] rounded-full bg-ink opacity-50" style={{ left: `calc(${target * 100}% - 1px)` }} aria-hidden />
                )}
              </div>
              {r.sub && <div className="text-[12px] text-ink3 mt-1 truncate">{r.sub}</div>}
            </Comp>
          </li>
        );
      })}
    </ul>
  );
}

/* --------------------------------------------------------------- stacked bar */

export interface Segment {
  key: string;
  label: string;
  value: number;
  /** A CSS colour or gradient. */
  color: string;
  hint?: string;
}

/** One bar split into parts (status mix) with a legend. Parts are drawn in order; zero parts are skipped in the bar but kept in the legend. */
export function StackedBar({ segments, height = 14, legend = true, unit = "" }: { segments: Segment[]; height?: number; legend?: boolean; unit?: string }) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  return (
    <div>
      <div className="flex w-full gap-[3px] rounded-full overflow-hidden" style={{ height }} role="img" aria-label={segments.map((s) => `${s.label} ${s.value}`).join(", ")}>
        {total === 0 ? (
          <div className="h-full w-full rounded-full bg-neutral-bg" />
        ) : (
          segments
            .filter((s) => s.value > 0)
            .map((s, i) => (
              <Tooltip key={s.key} content={`${s.label}: ${s.value}${unit} (${Math.round((s.value / total) * 100)}%)`}>
                <motion.div
                  className="h-full first:rounded-l-full last:rounded-r-full cursor-default"
                  style={{ background: s.color, minWidth: 6 }}
                  initial={{ flexGrow: 0, opacity: 0.4 }}
                  animate={{ flexGrow: s.value, opacity: 1 }}
                  transition={{ duration: dur(), ease: ease.decelerate, delay: prefersReducedMotion() ? 0 : i * 0.08 }}
                />
              </Tooltip>
            ))
        )}
      </div>
      {legend && (
        <ul className="mt-3 grid gap-x-4 gap-y-1.5" style={{ gridTemplateColumns: `repeat(${Math.min(segments.length, 3)}, minmax(0, 1fr))` }}>
          {segments.map((s) => (
            <li key={s.key} className="min-w-0">
              <div className="flex items-center gap-1.5 text-[12.5px] text-ink2">
                <span className="w-2.5 h-2.5 rounded-full flex-none" style={{ background: s.color }} aria-hidden />
                <span className="truncate">{s.label}</span>
              </div>
              <div className="text-[18px] font-semibold text-ink tabular leading-6">
                {s.value}
                {total > 0 && <span className="ml-1.5 text-[12px] font-medium text-ink3">{Math.round((s.value / total) * 100)}%</span>}
              </div>
              {s.hint && <div className="text-[11.5px] text-ink3 truncate">{s.hint}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ weekday strip */

export interface WeekdayCell {
  day: string;
  /** 0..1, or null when nothing happened that weekday. */
  rate: number | null;
  /** Small text under the rate ("12 slots"). */
  note?: string;
}

/**
 * Seven tiles Monday to Sunday, shaded by the rate (darker = higher) in the dashboard's hue, so a weak weekday shows at a
 * glance. The lowest weekday with data gets an amber ring. Days with no data stay empty.
 */
export function WeekdayStrip({ cells, hue = "sky" }: { cells: WeekdayCell[]; hue?: "sky" | "teal" | "indigo" | "violet" }) {
  const withData = cells.filter((c) => c.rate != null);
  const lowest = withData.length > 1 ? withData.reduce((a, b) => (b.rate! < a.rate! ? b : a)) : null;
  return (
    <div className={clsx("grid grid-cols-7 gap-1.5 sm:gap-2", `hue-${hue}`)}>
      {cells.map((c, i) => {
        const has = c.rate != null;
        const alpha = has ? 0.1 + 0.45 * (c.rate as number) : 0;
        return (
          <motion.div
            key={c.day}
            className={clsx("rounded-xl px-1 py-2.5 text-center min-w-0 border", lowest?.day === c.day ? "border-warn" : "border-transparent")}
            style={{ background: has ? `rgba(var(--hue), ${alpha})` : "var(--neutral-bg)" }}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: prefersReducedMotion() ? 0 : i * 0.05, ease: ease.decelerate }}
            title={has ? `${c.day}: ${Math.round((c.rate as number) * 100)}%${c.note ? ` (${c.note})` : ""}` : `${c.day}: no data`}
          >
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink2">{c.day}</div>
            <div className="text-[18px] font-semibold tabular leading-6 mt-0.5 text-ink">{has ? `${Math.round((c.rate as number) * 100)}%` : "—"}</div>
            <div className="text-[10.5px] truncate text-ink3">{c.note ?? ""}</div>
          </motion.div>
        );
      })}
    </div>
  );
}
