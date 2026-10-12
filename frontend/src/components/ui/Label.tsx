import clsx from "clsx";
import type { LucideIcon } from "lucide-react";
import { pct, rateTone, type Tone } from "../../lib/format";

export type { Tone };

const SUBTLE: Record<Tone, string> = {
  neutral: "bg-neutral-bg text-ink2 border-line",
  accent: "bg-info-bg text-info border-transparent",
  good: "bg-good-bg text-good border-transparent",
  warn: "bg-warn-bg text-warn border-transparent",
  crit: "bg-crit-bg text-crit border-transparent",
};
const OUTLINE: Record<Tone, string> = {
  neutral: "text-ink2 border-line",
  accent: "text-info border-info",
  good: "text-good border-good",
  warn: "text-warn border-warn",
  crit: "text-crit border-crit",
};
const SOLID: Record<Tone, string> = {
  neutral: "bg-neutral text-white border-transparent",
  accent: "bg-info text-white border-transparent",
  good: "bg-good text-white border-transparent",
  warn: "bg-warn text-white border-transparent",
  crit: "bg-crit text-white border-transparent",
};
const DOT: Record<Tone, string> = {
  neutral: "bg-neutral",
  accent: "bg-info",
  good: "bg-good",
  warn: "bg-warn",
  crit: "bg-crit",
};

export function Label({
  tone = "neutral",
  variant = "subtle",
  size = "md",
  dot,
  icon: Icon,
  children,
  className,
}: {
  tone?: Tone;
  variant?: "subtle" | "outline" | "solid";
  size?: "sm" | "md";
  dot?: boolean;
  icon?: LucideIcon;
  children: React.ReactNode;
  className?: string;
}) {
  const map = variant === "outline" ? OUTLINE : variant === "solid" ? SOLID : SUBTLE;
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full border font-medium whitespace-nowrap",
        size === "sm" ? "h-5 px-2 text-[11px]" : "h-[22px] px-2.5 text-xs",
        map[tone],
        className
      )}
    >
      {dot && <span className={clsx("w-1.5 h-1.5 rounded-full flex-none", DOT[tone])} aria-hidden />}
      {Icon && <Icon size={12} aria-hidden />}
      {children}
    </span>
  );
}

/** Rate-coloured pill; tone from the 90/75 thresholds, neutral when there's no data. */
export function Badge({ rate, children }: { rate: number | null | undefined; children: React.ReactNode }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center h-[22px] px-2 rounded-full text-xs font-semibold tabular border",
        SUBTLE[rateTone(rate)]
      )}
    >
      {children}
    </span>
  );
}

export function RateBadge({ rate }: { rate: number | null | undefined }) {
  return <Badge rate={rate}>{pct(rate)}</Badge>;
}
