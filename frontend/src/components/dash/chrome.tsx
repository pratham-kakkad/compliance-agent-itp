import { useCallback, useState } from "react";
import clsx from "clsx";
import { RefreshCw, type LucideIcon } from "lucide-react";
import { useApi } from "../../lib/useApi";
import { fmtDateTime } from "../../lib/format";
import { PERIODS, type Hue, type PeriodDays } from "../../lib/dashboards";
import { Card, ErrorState, IconButton, PageHeader, SegmentedControl, Skeleton } from "../ui";

/* ---------------------------------------------------------------- the period */

const PERIOD_KEY = "ic-dash-days";

function readDays(): PeriodDays {
  try {
    const v = Number(window.localStorage.getItem(PERIOD_KEY));
    if ((PERIODS as readonly number[]).includes(v)) return v as PeriodDays;
  } catch {
    /* storage unavailable */
  }
  return 30;
}

/** The selected period (7, 30 or 90 days), shared by every dashboard and remembered. */
export function usePeriod(): [PeriodDays, (d: PeriodDays) => void] {
  const [days, setDays] = useState<PeriodDays>(readDays);
  const set = useCallback((d: PeriodDays) => {
    setDays(d);
    try {
      window.localStorage.setItem(PERIOD_KEY, String(d));
    } catch {
      /* kept for this visit only */
    }
  }, []);
  return [days, set];
}

export function PeriodPicker({ days, onChange }: { days: PeriodDays; onChange: (d: PeriodDays) => void }) {
  return (
    <SegmentedControl
      aria-label="Period"
      size="md"
      value={String(days) as "7" | "30" | "90"}
      onChange={(v) => onChange(Number(v) as PeriodDays)}
      options={PERIODS.map((p) => ({ value: String(p) as "7" | "30" | "90", label: `${p} days` }))}
    />
  );
}

/** GET /dashboards/<area>?days=N. Changing the period refetches and keeps the old numbers on screen meanwhile. */
export function useDashboard<T>(area: string, days: number, enabled = true) {
  return useApi<T>(enabled ? `/dashboards/${area}?days=${days}` : null);
}

/* ------------------------------------------------------------------- header */

/** Title, a one-line description, the period selector, "as of" and refresh. */
export function DashboardHeader({
  title,
  description,
  days,
  onDays,
  asOf,
  loading,
  onRefresh,
  actions,
}: {
  title: string;
  description: React.ReactNode;
  days: PeriodDays;
  onDays: (d: PeriodDays) => void;
  asOf?: string | null;
  loading?: boolean;
  onRefresh: () => void;
  actions?: React.ReactNode;
}) {
  return (
    <PageHeader
      title={title}
      description={
        <>
          {description}
          {asOf && <span className="text-ink3"> · As of {fmtDateTime(asOf)}</span>}
        </>
      }
      actions={
        <>
          {actions}
          <PeriodPicker days={days} onChange={onDays} />
          <IconButton icon={RefreshCw} label="Refresh data" variant="secondary" onClick={onRefresh} className={clsx(loading && "[&_svg]:animate-spin")} />
        </>
      }
    />
  );
}

/* ------------------------------------------------------------- panel states */

/** Placeholder card shown in a panel's place while its data loads. */
export function PanelSkeleton({ tall }: { tall?: boolean }) {
  return (
    <Card className="h-full">
      <Skeleton className="h-4 w-40 mb-4" />
      <Skeleton className={tall ? "h-[200px] w-full" : "h-[150px] w-full"} />
    </Card>
  );
}

export function PanelError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card className="h-full">
      <ErrorState message={message} onRetry={onRetry} />
    </Card>
  );
}

/** Wraps a panel body: error, loading, or the content once data is there. */
export function panelOf<T>(state: { data: T | null; error: Error | null; initialLoading: boolean; reload: () => void }, render: (d: T) => React.ReactNode, tall = false): React.ReactNode {
  if (state.error && !state.data) return <PanelError message={state.error.message} onRetry={state.reload} />;
  if (!state.data) return <PanelSkeleton tall={tall} />;
  return render(state.data);
}

/* -------------------------------------------------------------- grid heading */

/** The heading above a group of panels in the grid: a hued icon chip, a title and what the group answers. */
export function AreaHeading({ title, description, icon: Icon, hue, action }: { title: string; description?: string; icon: LucideIcon; hue: Hue; action?: React.ReactNode }) {
  return (
    <div className={clsx("flex items-end justify-between gap-3 mt-3 mb-0.5", `hue-${hue}`)}>
      <div className="flex items-center gap-2.5 min-w-0">
        <span className="nav-chip-on w-8 h-8 rounded-[10px] flex items-center justify-center flex-none">
          <Icon size={16} aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-ink leading-5">{title}</h2>
          {description && <p className="text-[13px] text-ink2 truncate">{description}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}
