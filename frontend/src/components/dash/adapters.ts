import { fmtWeek } from "../../lib/format";
import { bucketRange, type PeriodInfo, type RateTrend } from "../../lib/dashboards";
import type { CountPoint, RatePoint } from "../charts";

const range = (a: string, b: string, daily: boolean) => (daily || a === b ? fmtWeek(a) : `${fmtWeek(a)} – ${fmtWeek(b)}`);

/** A server rate trend (buckets + the previous period's buckets) as chart points, with readable labels. */
export function rateTrendPoints(trend: RateTrend, period: PeriodInfo, note?: (p: RateTrend["points"][number]) => string | undefined): RatePoint[] {
  const starts = trend.points.map((p) => p.start);
  const pstarts = trend.points.map((p) => p.previous_start);
  return trend.points.map((p, i) => {
    const [a, b] = bucketRange(starts, i, trend.daily, period.end);
    const [pa, pb] = bucketRange(pstarts, i, trend.daily, period.previous_end);
    return {
      label: fmtWeek(a),
      fullLabel: range(a, b, trend.daily),
      value: p.rate,
      previous: p.previous_rate,
      previousLabel: range(pa, pb, trend.daily),
      note: note?.(p),
    };
  });
}

/** Counts per bucket (completions) with the previous period's counts, as chart points. */
export function countTrendPoints(
  points: { start: string; previous_start: string; completed: number; previous_completed: number }[],
  daily: boolean,
  period: PeriodInfo
): CountPoint[] {
  const starts = points.map((p) => p.start);
  const pstarts = points.map((p) => p.previous_start);
  return points.map((p, i) => {
    const [a, b] = bucketRange(starts, i, daily, period.end);
    const [pa, pb] = bucketRange(pstarts, i, daily, period.previous_end);
    return { label: fmtWeek(a), fullLabel: range(a, b, daily), value: p.completed, previous: p.previous_completed, previousLabel: range(pa, pb, daily) };
  });
}
