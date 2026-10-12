import { useId, useMemo } from "react";
import { Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, Pie, PieChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { BarChart3, LineChart as LineChartIcon } from "lucide-react";
import { AnimatedNumber, EmptyState } from "./ui";
import { useCssVars } from "../lib/useCssVar";
import { prefersReducedMotion } from "../lib/motion";

/* Charts draw from the multi-colour palette tokens --chart-1..6 (indigo, cyan, emerald, amber, pink, violet; light and
   dark values live in index.css). Red (--crit) is never decoration: it only appears where a value is itself critical.
   Every chart animates in (recharts animationDuration) and has hover tooltips; with prefers-reduced-motion the
   animations are off. */

const VARS = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5", "chart-6", "good", "warn", "crit", "neutral", "neutral-bg", "border-soft", "text-faint", "text-soft", "surface", "text"] as const;

function useChartColors() {
  return useCssVars([...VARS]);
}

const anim = () => !prefersReducedMotion();

function TipBox({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-panel shadow-md px-3 py-2 text-[13px] min-w-[150px]">
      {title && <div className="text-ink2 text-xs mb-1">{title}</div>}
      {children}
    </div>
  );
}

function TipLine({ color, dashed, name, value }: { color: string; dashed?: boolean; name: string; value: string }) {
  return (
    <div className="flex items-center gap-2 py-px">
      <span className="w-2.5 h-0.5 rounded-full flex-none" style={dashed ? { borderTop: `2px dashed ${color}`, height: 0 } : { background: color }} aria-hidden />
      <span className="text-ink2">{name}</span>
      <span className="ml-auto pl-3 font-semibold text-ink tabular">{value}</span>
    </div>
  );
}

export function ChartLegend({ items }: { items: { label: string; color: string; dashed?: boolean }[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink2">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span className="w-4 flex-none" style={i.dashed ? { borderTop: `2px dashed ${i.color}` } : { height: 3, borderRadius: 2, background: i.color }} aria-hidden />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------- rate over time */

export interface RatePoint {
  /** The x-axis label ("Sep 22"). */
  label: string;
  /** 0..1, or null for "nothing measured" (drawn as a gap, never as 0%). */
  value: number | null;
  /** The same position in the previous equal period (0..1). */
  previous?: number | null;
  previousLabel?: string;
  /** Extra tooltip line, e.g. "171 of 262". */
  note?: string;
  /** Tooltip heading when the axis label is short ("Sep 12 - Sep 18"). */
  fullLabel?: string;
}

/**
 * A rate (0-100%) over time as a gradient area, with the previous period as a dashed line and the target as a reference
 * line. Missing readings are gaps, never 0%.
 */
export function RateTrendChart({
  points,
  target,
  name = "This period",
  previousName = "Previous period",
  height = 230,
  colorIndex = 1,
}: {
  points: RatePoint[];
  target?: number | null;
  name?: string;
  previousName?: string;
  height?: number;
  colorIndex?: 1 | 2 | 3 | 6;
}) {
  const c = useChartColors();
  const gid = useId().replace(/:/g, "");
  const data = useMemo(
    () =>
      points.map((p) => ({
        label: p.label,
        value: p.value == null ? null : Math.round(p.value * 1000) / 10,
        previous: p.previous == null ? null : Math.round(p.previous * 1000) / 10,
        previousLabel: p.previousLabel,
        note: p.note,
        fullLabel: p.fullLabel,
      })),
    [points]
  );
  const hasPrev = data.some((d) => d.previous != null);
  const main = c[`chart-${colorIndex}` as "chart-1"];
  const second = c["chart-2"];

  if (!data.some((d) => d.value != null)) {
    return <EmptyState icon={LineChartIcon} title="Nothing to chart yet" description="This period has no readings, so there is no trend to draw." compact />;
  }
  const dots = data.length <= 14;
  return (
    <div>
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={data} margin={{ top: 14, right: 12, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={`rf${gid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={main} stopOpacity={0.38} />
              <stop offset="100%" stopColor={second} stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id={`rs${gid}`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor={main} />
              <stop offset="100%" stopColor={second} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke={c["border-soft"]} />
          <XAxis dataKey="label" tick={{ fontSize: 12, fill: c["text-faint"] }} axisLine={false} tickLine={false} tickMargin={8} minTickGap={18} />
          <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 12, fill: c["text-faint"] }} axisLine={false} tickLine={false} width={42} />
          {target != null && (
            <ReferenceLine
              y={target * 100}
              stroke={c["chart-3"]}
              strokeDasharray="5 4"
              strokeWidth={1.5}
              label={{ value: `Target ${Math.round(target * 100)}%`, position: "insideTopRight", fill: c["chart-3"], fontSize: 11, fontWeight: 600 }}
            />
          )}
          <Tooltip
            cursor={{ stroke: c["text-faint"], strokeDasharray: "3 3" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0].payload as (typeof data)[number];
              const delta = d.value != null && d.previous != null ? d.value - d.previous : null;
              return (
                <TipBox title={d.fullLabel ?? d.label}>
                  <TipLine color={main} name={name} value={d.value == null ? "—" : `${d.value}%`} />
                  {hasPrev && <TipLine color={c["text-faint"]} dashed name={d.previousLabel ? `${previousName} (${d.previousLabel})` : previousName} value={d.previous == null ? "—" : `${d.previous}%`} />}
                  {delta != null && <div className="text-xs text-ink3 mt-1 text-right tabular">{delta > 0 ? "+" : delta < 0 ? "−" : ""}{Math.abs(Math.round(delta * 10) / 10)} pts</div>}
                  {d.note && <div className="text-xs text-ink3 mt-0.5">{d.note}</div>}
                </TipBox>
              );
            }}
          />
          {hasPrev && <Line type="monotone" dataKey="previous" stroke={c["text-faint"]} strokeWidth={1.75} strokeDasharray="4 4" dot={false} activeDot={false} connectNulls={false} isAnimationActive={anim()} animationDuration={900} />}
          <Area
            type="monotone"
            dataKey="value"
            connectNulls={false}
            stroke={`url(#rs${gid})`}
            strokeWidth={2.75}
            fill={`url(#rf${gid})`}
            dot={dots ? { r: 3.5, fill: c.surface, stroke: main, strokeWidth: 2 } : false}
            activeDot={{ r: 5.5, fill: second, stroke: c.surface, strokeWidth: 2 }}
            isAnimationActive={anim()}
            animationDuration={900}
            animationEasing="ease-out"
          />
        </ComposedChart>
      </ResponsiveContainer>
      <div className="mt-2 pl-[42px]">
        <ChartLegend
          items={[
            { label: name, color: main },
            ...(hasPrev ? [{ label: previousName, color: c["text-faint"], dashed: true }] : []),
            ...(target != null ? [{ label: "Target", color: c["chart-3"], dashed: true }] : []),
          ]}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- counts over time */

export interface CountPoint {
  label: string;
  fullLabel?: string;
  value: number;
  previous?: number | null;
  previousLabel?: string;
}

/** A count per day or week as rounded gradient columns, with the previous period's count as a soft column beside it. */
export function CountColumnChart({
  points,
  name = "This period",
  previousName = "Previous period",
  height = 230,
  unitLabel = "completed",
}: {
  points: CountPoint[];
  name?: string;
  previousName?: string;
  height?: number;
  unitLabel?: string;
}) {
  const c = useChartColors();
  const gid = useId().replace(/:/g, "");
  const hasPrev = points.some((p) => (p.previous ?? 0) > 0);
  const max = Math.max(1, ...points.map((p) => Math.max(p.value, p.previous ?? 0)));
  if (!points.some((p) => p.value > 0) && !hasPrev) {
    return <EmptyState icon={BarChart3} title="Nothing completed yet" description={`Items ${unitLabel} in this period will be charted here.`} compact />;
  }
  return (
    <div>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={points} margin={{ top: 14, right: 8, left: 0, bottom: 0 }} barGap={3} barCategoryGap="22%">
          <defs>
            <linearGradient id={`cb${gid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={c["chart-6"]} />
              <stop offset="100%" stopColor={c["chart-1"]} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke={c["border-soft"]} />
          <XAxis dataKey="label" tick={{ fontSize: 12, fill: c["text-faint"] }} axisLine={false} tickLine={false} tickMargin={8} minTickGap={14} />
          <YAxis allowDecimals={false} domain={[0, Math.ceil(max * 1.1)]} tick={{ fontSize: 12, fill: c["text-faint"] }} axisLine={false} tickLine={false} width={32} />
          <Tooltip
            cursor={{ fill: c["neutral-bg"], opacity: 0.5 }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0].payload as CountPoint;
              return (
                <TipBox title={d.fullLabel ?? d.label}>
                  <TipLine color={c["chart-1"]} name={name} value={`${d.value} ${unitLabel}`} />
                  {hasPrev && <TipLine color={c["text-faint"]} dashed name={d.previousLabel ? `${previousName} (${d.previousLabel})` : previousName} value={`${d.previous ?? 0}`} />}
                </TipBox>
              );
            }}
          />
          {hasPrev && <Bar dataKey="previous" fill={c["neutral"]} fillOpacity={0.28} radius={[5, 5, 0, 0]} maxBarSize={14} isAnimationActive={anim()} animationDuration={700} />}
          <Bar dataKey="value" fill={`url(#cb${gid})`} radius={[6, 6, 0, 0]} maxBarSize={22} isAnimationActive={anim()} animationDuration={900} animationBegin={120} />
        </BarChart>
      </ResponsiveContainer>
      <div className="mt-2 pl-[32px]">
        <ChartLegend items={[{ label: name, color: c["chart-1"] }, ...(hasPrev ? [{ label: previousName, color: c["neutral"] }] : [])]} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- donut */

/** Attended vs missed as a ring: a green-to-cyan arc for attended, amber for missed, the share in the middle. */
export function AttendanceDonut({ attended, total, height = 180 }: { attended: number; total: number; height?: number }) {
  const c = useChartColors();
  const gid = useId().replace(/:/g, "");
  const missed = Math.max(total - attended, 0);
  const empty = total === 0;
  const rate = empty ? 0 : Math.round((attended / total) * 100);
  const data = empty
    ? [{ name: "None", value: 1 }]
    : [
        { name: "Attended", value: attended },
        { name: "Missed", value: missed },
      ];
  const fills = empty ? [c["neutral-bg"]] : [`url(#dg${gid})`, c["chart-4"]];

  return (
    <div>
      <div className="relative" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <defs>
              <linearGradient id={`dg${gid}`} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor={c["chart-3"]} />
                <stop offset="100%" stopColor={c["chart-2"]} />
              </linearGradient>
            </defs>
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
              isAnimationActive={!empty && anim()}
              animationDuration={800}
              animationEasing="ease-out"
            >
              {data.map((_, i) => (
                <Cell key={i} fill={fills[i]} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <div className="text-2xl font-semibold text-ink tabular">{empty ? "—" : <AnimatedNumber value={rate} format={(n) => `${Math.round(n)}%`} />}</div>
          <div className="text-xs text-ink2 mt-0.5">{empty ? "No required meetings" : "attended"}</div>
        </div>
      </div>
      {!empty && (
        <div className="flex items-center justify-center gap-5 mt-3 text-[13px] text-ink2">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ background: c["chart-3"] }} aria-hidden />
            Attended <span className="font-semibold text-ink tabular">{attended}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ background: c["chart-4"] }} aria-hidden />
            Missed <span className="font-semibold text-ink tabular">{missed}</span>
          </span>
        </div>
      )}
    </div>
  );
}
