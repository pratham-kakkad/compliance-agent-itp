import { useEffect, useId, useRef, useState } from "react";
import clsx from "clsx";
import { animate, motion } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import { initials, rateTone, type Tone } from "../../lib/format";
import { duration, ease, prefersReducedMotion } from "../../lib/motion";
import { Skeleton } from "./Feedback";

const AVATAR_COLORS = ["#1a73e8", "#188038", "#e37400", "#d93025", "#9334e6", "#0f9d9a", "#c5221f", "#3f51b5"];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function Avatar({ name, size = 28, self = false, className }: { name: string; size?: number; self?: boolean; className?: string }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center justify-center rounded-full text-white font-semibold flex-none select-none",
        self && "ring-2 ring-accent ring-offset-2 ring-offset-[var(--surface)]",
        className
      )}
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.4)), background: AVATAR_COLORS[hash(name || "?") % AVATAR_COLORS.length] }}
      title={self ? `${name} (you)` : name}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}

const TONE_VAR: Record<Tone, string> = {
  neutral: "var(--neutral)",
  accent: "var(--accent)",
  good: "var(--good)",
  warn: "var(--warn)",
  crit: "var(--crit)",
};

export function RateBar({ rate, width = 80, size = "md" }: { rate: number | null | undefined; width?: number | string; size?: "sm" | "md" }) {
  const value = Math.max(0, Math.min(100, Math.round((rate ?? 0) * 100)));
  return (
    <div
      className={clsx("rounded-full bg-neutral-bg overflow-hidden flex-none", size === "sm" ? "h-1" : "h-1.5")}
      style={{ width }}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={rate == null ? undefined : value}
      aria-label="Rate"
    >
      <motion.div
        className="h-full rounded-full"
        style={{ background: TONE_VAR[rateTone(rate)] }}
        initial={{ width: 0 }}
        animate={{ width: `${value}%` }}
        transition={{ duration: duration.chart, ease: ease.decelerate }}
      />
    </div>
  );
}

export function ProgressBar({ value, indeterminate, tone = "accent", className }: { value?: number; indeterminate?: boolean; tone?: Tone; className?: string }) {
  return (
    <div className={clsx("relative h-1 rounded-full bg-neutral-bg overflow-hidden", className)} role="progressbar" aria-valuenow={indeterminate ? undefined : value}>
      {indeterminate ? (
        <div className="absolute inset-y-0 w-2/5 rounded-full" style={{ background: TONE_VAR[tone], animation: "indeterminate 1.2s cubic-bezier(0.4,0,0.2,1) infinite" }} />
      ) : (
        <div className="h-full rounded-full transition-[width] duration-200" style={{ width: `${value ?? 0}%`, background: TONE_VAR[tone] }} />
      )}
    </div>
  );
}

/** Counts up from 0 on first mount, then tweens from the previous value. */
export function AnimatedNumber({ value, format = (n) => String(Math.round(n)), duration: dur = duration.chart }: { value: number; format?: (n: number) => string; duration?: number }) {
  const reduce = prefersReducedMotion();
  const [display, setDisplay] = useState(reduce ? value : 0);
  const prev = useRef(reduce ? value : 0);

  useEffect(() => {
    if (reduce) {
      setDisplay(value);
      prev.current = value;
      return;
    }
    const controls = animate(prev.current, value, {
      duration: dur,
      ease: ease.decelerate as unknown as [number, number, number, number],
      onUpdate: (v) => setDisplay(v),
    });
    prev.current = value;
    return () => controls.stop();
  }, [value, dur, reduce]);

  return <>{format(display)}</>;
}

export function Sparkline({ data, tone = "accent", width = 96, height = 28, className }: { data: (number | null)[]; tone?: Tone; width?: number; height?: number; className?: string }) {
  const id = useId().replace(/:/g, "");
  const pts = data.map((v, i) => ({ v, i })).filter((p): p is { v: number; i: number } => p.v != null);
  if (pts.length < 2) return null;
  const min = Math.min(...pts.map((p) => p.v));
  const max = Math.max(...pts.map((p) => p.v));
  const span = max - min || 1;
  const x = (i: number) => (i / (data.length - 1)) * (width - 2) + 1;
  const y = (v: number) => height - 2 - ((v - min) / span) * (height - 4);
  const line = pts.map((p, k) => `${k ? "L" : "M"}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const area = `${line} L${x(pts[pts.length - 1].i).toFixed(1)},${height} L${x(pts[0].i).toFixed(1)},${height} Z`;
  const color = TONE_VAR[tone];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} aria-hidden>
      <defs>
        <linearGradient id={`sg${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: color, stopOpacity: 0.18 }} />
          <stop offset="100%" style={{ stopColor: color, stopOpacity: 0 }} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#sg${id})`} />
      <motion.path
        d={line}
        fill="none"
        style={{ stroke: color }}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.8, ease: ease.decelerate }}
      />
    </svg>
  );
}

const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-ink",
  accent: "text-accent",
  good: "text-good",
  warn: "text-warn",
  crit: "text-crit",
};

export function StatCard({
  label,
  value,
  valueColor,
  foot,
  animateValue,
  formatValue,
  icon: Icon,
  trend,
  tone,
  onClick,
  loading,
  className,
}: {
  label: string;
  value: string;
  valueColor?: string;
  foot?: React.ReactNode;
  animateValue?: number | null;
  formatValue?: (n: number) => string;
  icon?: LucideIcon;
  trend?: (number | null)[];
  tone?: Tone;
  onClick?: () => void;
  loading?: boolean;
  className?: string;
}) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      onClick={onClick}
      className={clsx(
        "bg-panel border border-line rounded-lg shadow-xs p-4 sm:p-5 flex flex-col items-stretch text-left min-w-0 w-full",
        onClick && "transition-[border-color,box-shadow] duration-100 hover:border-line-strong hover:shadow-md",
        className
      )}
    >
      <div className="w-full flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-ink2 truncate">{label}</span>
        {Icon && <Icon size={16} className="text-ink3 flex-none" aria-hidden />}
      </div>
      {loading ? (
        <>
          <Skeleton className="h-8 w-20 mt-2" />
          <Skeleton className="h-3 w-32 mt-2.5" />
        </>
      ) : (
        <>
          <div className="w-full flex items-end justify-between gap-2 mt-1.5">
            <span
              className={clsx("text-[28px] leading-9 font-semibold tabular tracking-[-0.01em]", !valueColor && TONE_TEXT[tone ?? "neutral"])}
              style={valueColor ? { color: valueColor } : undefined}
            >
              {animateValue != null ? <AnimatedNumber value={animateValue} format={formatValue} /> : value}
            </span>
            {trend && <Sparkline data={trend} tone={tone === "neutral" || !tone ? "accent" : tone} className="mb-1.5 flex-none" />}
          </div>
          {foot && <div className="text-xs text-ink3 mt-1 truncate">{foot}</div>}
        </>
      )}
    </Comp>
  );
}

const METER_TEXT: Record<Tone, string> = {
  neutral: "text-ink3",
  accent: "text-accent",
  good: "text-good",
  warn: "text-warn",
  crit: "text-crit",
};

/** Bar + percentage, the standard way to show a rate in tables and lists. */
export function RateMeter({ rate, width = 64, align = "end" }: { rate: number | null | undefined; width?: number | string; align?: "start" | "end" }) {
  const value = rate == null ? "—" : `${Math.round(rate * 100)}%`;
  return (
    <div className={clsx("flex items-center gap-2.5", align === "end" ? "justify-end" : "justify-start")}>
      <RateBar rate={rate} width={width} />
      <span className={clsx("w-10 text-right text-[13px] font-semibold tabular", METER_TEXT[rateTone(rate)])}>{value}</span>
    </div>
  );
}
