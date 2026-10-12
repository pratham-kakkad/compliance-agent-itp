import clsx from "clsx";
import { Info, type LucideIcon } from "lucide-react";
import { AnimatedNumber, Skeleton, Tooltip } from "../ui";
import { fmtKpiValue, type Hue, type Kpi } from "../../lib/dashboards";
import { DeltaChip, TargetBar, TONE_TEXT } from "./viz";

/** The "i" next to a label: hover or focus shows what the number means. */
export function InfoTip({ text, label }: { text: string; label: string }) {
  return (
    <Tooltip content={text} side="top" delay={150}>
      <button
        type="button"
        aria-label={`What is ${label}?`}
        className="flex-none inline-flex items-center justify-center w-4 h-4 rounded-full text-ink3 hover:text-accent focus-visible:text-accent transition-colors"
        onClick={(e) => e.stopPropagation()}
      >
        <Info size={13} aria-hidden />
      </button>
    </Tooltip>
  );
}

const TONE_TILE: Record<Kpi["tone"], "neutral" | "good" | "warn" | "crit"> = { neutral: "neutral", good: "good", warn: "warn", crit: "crit" };

/**
 * One KPI: the name with an info tooltip (its precise definition), the value (counts up; a dash and the reason when there
 * is nothing to measure, never 0%), the change against the previous equal period, and for rates a bar with the target
 * marked. The tile is tinted by area (`hue`); the value keeps its status colour (red only when it is critical).
 */
export function KpiCard({
  kpi,
  days,
  hue,
  icon: Icon,
  onClick,
  className,
  hideBar,
  extra,
}: {
  kpi: Kpi;
  days: number;
  hue: Hue;
  icon?: LucideIcon;
  onClick?: () => void;
  className?: string;
  hideBar?: boolean;
  /** Extra line at the bottom (e.g. a link). */
  extra?: React.ReactNode;
}) {
  const Comp = onClick ? "button" : "div";
  const has = kpi.value != null;
  const showBar = !hideBar && has && kpi.unit === "percent";
  const tone = kpi.tone === "neutral" ? "neutral" : kpi.tone;
  return (
    <Comp
      type={onClick ? "button" : undefined}
      onClick={onClick}
      data-tone={TONE_TILE[kpi.tone]}
      data-hue={hue}
      className={clsx(
        "spot glass tile rounded-2xl p-4 flex flex-col items-stretch text-left min-w-0 w-full h-full",
        onClick && "transition-transform duration-200 hover:-translate-y-0.5 focus-ring",
        className
      )}
    >
      <div className="w-full flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="text-[13px] font-medium text-ink2 truncate">{kpi.label}</span>
          <InfoTip text={kpi.definition} label={kpi.label} />
        </span>
        {Icon && (
          <span className="tile-chip flex-none">
            <Icon size={15} aria-hidden />
          </span>
        )}
      </div>

      <div className="mt-1.5 flex items-end gap-2 min-h-9">
        {has ? (
          <span className={clsx("text-[30px] leading-9 font-semibold tabular tracking-[-0.01em]", TONE_TEXT[tone === "neutral" ? "neutral" : tone])}>
            <AnimatedNumber value={kpi.value as number} format={(n) => fmtKpiValue(kpi.unit, n)} />
          </span>
        ) : (
          <span className="text-[30px] leading-9 font-semibold text-ink3" aria-label="No data">
            {"—"}
          </span>
        )}
        {has && kpi.target != null && kpi.unit !== "percent" && <span className="mb-1 text-[11.5px] text-ink3 whitespace-nowrap">target {fmtKpiValue(kpi.unit, kpi.target)}</span>}
      </div>

      {has ? (
        <div className="mt-1.5 min-h-[20px]">
          <DeltaChip kpi={kpi} days={days} />
        </div>
      ) : (
        <p className="mt-1.5 text-[12px] leading-4 text-ink3 min-h-[20px]">{kpi.no_data}</p>
      )}

      {showBar && (
        <div className="mt-2.5">
          <TargetBar value={kpi.value} target={kpi.target} tone={tone === "neutral" ? "accent" : tone} height={6} />
          {kpi.target != null && <div className="mt-1 text-[11px] text-ink3 tabular">Target {Math.round(kpi.target * 100)}%</div>}
        </div>
      )}

      {has && kpi.detail && <div className={clsx("text-[12px] leading-4 text-ink3 line-clamp-2", showBar ? "mt-0.5" : "mt-2")}>{kpi.detail}</div>}
      {extra}
    </Comp>
  );
}

/** A row of KPI cards (two across on narrow screens, four on wide; the orbit ring folds it to two). */
export function KpiGrid({ children, cols = 4 }: { children: React.ReactNode; cols?: 3 | 4 }) {
  return <div className={clsx("grid grid-cols-2 gap-3", cols === 4 ? "lg:grid-cols-4" : "sm:grid-cols-3")}>{children}</div>;
}

export function KpiGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" aria-busy="true">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="glass rounded-2xl p-4">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-8 w-20 mt-3" />
          <Skeleton className="h-3 w-36 mt-3" />
          <Skeleton className="h-1.5 w-full mt-4" />
        </div>
      ))}
    </div>
  );
}
