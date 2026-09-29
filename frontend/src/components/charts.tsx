import { useId, useMemo } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { LineChart as LineChartIcon } from "lucide-react";
import { AnimatedNumber, EmptyState } from "./ui";
import { fmtWeek, rateTone } from "../lib/format";
import { useCssVars } from "../lib/useCssVar";

const VARS = ["accent", "good", "warn", "crit", "neutral", "neutral-bg", "border-soft", "text-faint", "text-soft", "surface"] as const;

function useChartColors() {
  return useCssVars([...VARS]);
}

function ChartTooltip({
  active,
  payload,
  label,
  name,
  formatValue = (v) => `${v}%`,
}: {
  active?: boolean;
  payload?: { value: number | null }[];
  label?: string;
  name: string;
  formatValue?: (v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  const v = payload[0].value;
  return (
    <div className="rounded-lg border border-line bg-panel shadow-md px-3 py-2 text-[13px]">
      <div className="text-ink2 text-xs mb-0.5">{label}</div>
      <div className="flex items-center gap-2">
        <span className="text-ink2">{name}</span>
        <span className="font-semibold text-ink tabular">{v == null ? "—" : formatValue(v)}</span>
      </div>
    </div>
  );
}

export interface TrendRatePoint {
  week_start: string;
  rate: number | null;
}

/**
 * Weekly rate-over-time area chart, generic over any {week_start, rate}[] —
 * callers map their domain field (attendance_rate, compliance_rate, …) onto
 * `rate`. Missing weeks are drawn as gaps, never as 0%.
 */
export function TrendChart({ data, label = "Rate", height = 220 }: { data: TrendRatePoint[]; label?: string; height?: number }) {
  const c = useChartColors();
  const gid = useId().replace(/:/g, "");
  const points = useMemo(
    () => data.map((t) => ({ week: fmtWeek(t.week_start), rate: t.rate == null ? null : Math.round(t.rate * 100) })),
    [data]
  );

  if (!points.some((p) => p.rate != null)) {
    return <EmptyState icon={LineChartIcon} title="No trend data yet" description="Rates will appear once there's at least one tracked week." compact />;
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={`tf${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={c.accent} stopOpacity={0.16} />
            <stop offset="100%" stopColor={c.accent} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke={c["border-soft"]} />
        <XAxis dataKey="week" tick={{ fontSize: 12, fill: c["text-faint"] }} axisLine={false} tickLine={false} tickMargin={8} minTickGap={16} />
        <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 12, fill: c["text-faint"] }} axisLine={false} tickLine={false} width={44} />
        <Tooltip content={<ChartTooltip name={label} />} cursor={{ stroke: c["text-faint"], strokeDasharray: "3 3" }} />
        <Area
          type="monotone"
          dataKey="rate"
          connectNulls={false}
          stroke={c.accent}
          strokeWidth={2}
          fill={`url(#tf${gid})`}
          dot={false}
          activeDot={{ r: 4, fill: c.accent, stroke: c.surface, strokeWidth: 2 }}
          animationDuration={600}
          animationEasing="ease-out"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function AttendanceDonut({ attended, total, height = 180 }: { attended: number; total: number; height?: number }) {
  const c = useChartColors();
  const missed = Math.max(total - attended, 0);
  const empty = total === 0;
  const rate = empty ? 0 : Math.round((attended / total) * 100);
  const data = empty
    ? [{ name: "None", value: 1 }]
    : [
        { name: "Attended", value: attended },
        { name: "Missed", value: missed },
      ];
  const colors = empty ? [c["neutral-bg"]] : [c.good, c.crit];

  return (
    <div>
      <div className="relative" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              innerRadius="74%"
              outerRadius="96%"
              paddingAngle={!empty && missed && attended ? 2 : 0}
              cornerRadius={!empty && missed && attended ? 4 : 0}
              stroke="none"
              startAngle={90}
              endAngle={-270}
              isAnimationActive={!empty}
              animationDuration={600}
              animationEasing="ease-out"
            >
              {data.map((_, i) => (
                <Cell key={i} fill={colors[i]} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <div className="text-2xl font-semibold text-ink tabular">
            {empty ? "—" : <AnimatedNumber value={rate} format={(n) => `${Math.round(n)}%`} />}
          </div>
          <div className="text-xs text-ink2 mt-0.5">{empty ? "No required meetings" : "attended"}</div>
        </div>
      </div>
      {!empty && (
        <div className="flex items-center justify-center gap-5 mt-3 text-[13px] text-ink2">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-good" aria-hidden />
            Attended <span className="font-semibold text-ink tabular">{attended}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-crit" aria-hidden />
            Missed <span className="font-semibold text-ink tabular">{missed}</span>
          </span>
        </div>
      )}
    </div>
  );
}

export interface RatedBar {
  label: string;
  rate: number | null;
}

export function RatedBarChart({ data, name = "Rate" }: { data: RatedBar[]; name?: string }) {
  const c = useChartColors();
  const rows = useMemo(
    () => data.map((d) => ({ label: d.label, pct: d.rate == null ? 0 : Math.round(d.rate * 100), shown: d.rate == null ? "—" : `${Math.round(d.rate * 100)}%`, tone: rateTone(d.rate) })),
    [data]
  );
  const toneColor = { good: c.good, warn: c.warn, crit: c.crit, neutral: c.neutral, accent: c.accent };
  const height = Math.max(rows.length * 36 + 28, 100);

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 44, left: 0, bottom: 0 }} barCategoryGap={12}>
        <CartesianGrid horizontal={false} stroke={c["border-soft"]} />
        <XAxis type="number" domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 12, fill: c["text-faint"] }} axisLine={false} tickLine={false} />
        <YAxis
          type="category"
          dataKey="label"
          width={128}
          interval={0}
          tickLine={false}
          axisLine={false}
          tick={({ x, y, payload }: { x: number; y: number; payload: { value: string } }) => (
            <text x={x - 8} y={y} dy={4} textAnchor="end" fontSize={13} fill={c["text-soft"]}>
              <title>{payload.value}</title>
              {payload.value.length > 16 ? `${payload.value.slice(0, 15)}…` : payload.value}
            </text>
          )}
        />
        <Tooltip
          cursor={{ fill: c["neutral-bg"], opacity: 0.5 }}
          content={({ active, payload, label }) =>
            active && payload?.length ? (
              <div className="rounded-lg border border-line bg-panel shadow-md px-3 py-2 text-[13px]">
                <div className="text-ink2 text-xs mb-0.5">{label}</div>
                <div className="flex items-center gap-2">
                  <span className="text-ink2">{name}</span>
                  <span className="font-semibold text-ink tabular">{(payload[0].payload as { shown: string }).shown}</span>
                </div>
              </div>
            ) : null
          }
        />
        <Bar dataKey="pct" radius={6} maxBarSize={12} animationDuration={600} animationEasing="ease-out" background={{ fill: c["neutral-bg"], radius: 6 }}>
          {rows.map((r, i) => (
            <Cell key={i} fill={toneColor[r.tone]} />
          ))}
          <LabelList dataKey="shown" position="right" offset={8} style={{ fontSize: 12, fontWeight: 600, fill: c["text-soft"] }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export interface TrendCountPoint {
  week_start: string;
  count: number;
}

/** Weekly count-over-time area chart — same visual language as TrendChart,
 * but for a raw count rather than a 0-100% rate (the y-axis scales to the
 * data instead of being pinned to 100). */
export function CountTrendChart({ data, label = "Count", height = 220 }: { data: TrendCountPoint[]; label?: string; height?: number }) {
  const c = useChartColors();
  const gid = useId().replace(/:/g, "");
  const points = useMemo(() => data.map((t) => ({ week: fmtWeek(t.week_start), count: t.count })), [data]);
  const max = Math.max(1, ...points.map((p) => p.count));

  if (!points.length) {
    return <EmptyState icon={LineChartIcon} title="No trend data yet" description="Counts will appear once there's at least one tracked week." compact />;
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={`ct${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={c.accent} stopOpacity={0.16} />
            <stop offset="100%" stopColor={c.accent} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke={c["border-soft"]} />
        <XAxis dataKey="week" tick={{ fontSize: 12, fill: c["text-faint"] }} axisLine={false} tickLine={false} tickMargin={8} minTickGap={16} />
        <YAxis domain={[0, max]} allowDecimals={false} tick={{ fontSize: 12, fill: c["text-faint"] }} axisLine={false} tickLine={false} width={32} />
        <Tooltip content={<ChartTooltip name={label} formatValue={(v) => String(v)} />} cursor={{ stroke: c["text-faint"], strokeDasharray: "3 3" }} />
        <Area
          type="monotone"
          dataKey="count"
          connectNulls={false}
          stroke={c.accent}
          strokeWidth={2}
          fill={`url(#ct${gid})`}
          dot={false}
          activeDot={{ r: 4, fill: c.accent, stroke: c.surface, strokeWidth: 2 }}
          animationDuration={600}
          animationEasing="ease-out"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export interface CountBar {
  label: string;
  count: number;
}

/** Horizontal bar breakdown for a raw count per category — same shape as
 * RatedBarChart, but sized relative to the largest count in the data
 * instead of a fixed 0-100% domain, and drawn in a single accent tone since
 * there's no good/warn/crit meaning for a plain count. */
export function CountBarChart({ data, name = "Count" }: { data: CountBar[]; name?: string }) {
  const c = useChartColors();
  const max = Math.max(1, ...data.map((d) => d.count));
  const rows = useMemo(() => data.map((d) => ({ label: d.label, count: d.count, pct: Math.round((d.count / max) * 100) })), [data, max]);
  const height = Math.max(rows.length * 36 + 28, 100);

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 44, left: 0, bottom: 0 }} barCategoryGap={12}>
        <CartesianGrid horizontal={false} stroke={c["border-soft"]} />
        <XAxis type="number" domain={[0, 100]} hide />
        <YAxis
          type="category"
          dataKey="label"
          width={128}
          interval={0}
          tickLine={false}
          axisLine={false}
          tick={({ x, y, payload }: { x: number; y: number; payload: { value: string } }) => (
            <text x={x - 8} y={y} dy={4} textAnchor="end" fontSize={13} fill={c["text-soft"]}>
              <title>{payload.value}</title>
              {payload.value.length > 16 ? `${payload.value.slice(0, 15)}…` : payload.value}
            </text>
          )}
        />
        <Tooltip
          cursor={{ fill: c["neutral-bg"], opacity: 0.5 }}
          content={({ active, payload, label }) =>
            active && payload?.length ? (
              <div className="rounded-lg border border-line bg-panel shadow-md px-3 py-2 text-[13px]">
                <div className="text-ink2 text-xs mb-0.5">{label}</div>
                <div className="flex items-center gap-2">
                  <span className="text-ink2">{name}</span>
                  <span className="font-semibold text-ink tabular">{(payload[0].payload as { count: number }).count}</span>
                </div>
              </div>
            ) : null
          }
        />
        <Bar dataKey="pct" radius={6} maxBarSize={12} animationDuration={600} animationEasing="ease-out" fill={c.accent} background={{ fill: c["neutral-bg"], radius: 6 }}>
          <LabelList dataKey="count" position="right" offset={8} style={{ fontSize: 12, fontWeight: 600, fill: c["text-soft"] }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
