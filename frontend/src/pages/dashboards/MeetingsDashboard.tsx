import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, CalendarCheck2, CalendarClock, CheckCircle2, Users2, UserX, Video } from "lucide-react";
import { Avatar, Card, CardHeader, EmptyState, Label, RateMeter, SegmentedControl } from "../../components/ui";
import { BlockDeck } from "../../components/orbit/BlockDeck";
import type { DeckBlock } from "../../components/orbit/types";
import { RateTrendChart } from "../../components/charts";
import { AnimatedNumber } from "../../components/ui";
import {
  ActionList,
  ActionRow,
  AreaHeading,
  DashboardHeader,
  KpiCard,
  KpiGrid,
  KpiGridSkeleton,
  ProgressRing,
  RankedBars,
  SeeAll,
  StackedBar,
  WeekdayStrip,
  panelOf,
  rateTrendPoints,
  useDashboard,
  usePeriod,
  type RankedRow,
} from "../../components/dash";
import { usePersonModal } from "../../components/PersonModal";
import { useMeetingPanel } from "../../components/MeetingPanel";
import { rateTone } from "../../lib/format";
import { WEEKDAY_LONG, type MeetingsDashboardData } from "../../lib/dashboards";
import { PanelError } from "../../components/dash";

const HUE = "sky" as const;

function SeriesPanel({ d, days }: { d: MeetingsDashboardData; days: number }) {
  const [by, setBy] = useState<"series" | "organizers">("series");
  const openMeeting = useMeetingPanel();
  const navigate = useNavigate();
  const target = d.thresholds.target;
  const seriesRows: RankedRow[] = d.series.map((s) => ({
    key: s.series_id,
    label: s.title,
    value: s.rate,
    tone: rateTone(s.rate),
    delta: s.delta,
    sub: `${s.organizer_name} · ${s.missed} of ${s.total} required attendances missed`,
    badge: s.at_risk ? (
      <Label tone="warn" size="sm">
        At risk
      </Label>
    ) : s.low_volume ? (
      <Label size="sm">Few meetings</Label>
    ) : undefined,
    onClick: () => openMeeting(s.series_id),
  }));
  const orgRows: RankedRow[] = d.organizers.map((o) => ({
    key: o.email,
    label: o.name,
    value: o.rate,
    tone: rateTone(o.rate),
    sub: `${o.series_count} series · ${o.attended} of ${o.total} required attendances attended`,
    badge: o.low_volume ? <Label size="sm">Few meetings</Label> : undefined,
  }));
  return (
    <Card className="h-full">
      <CardHeader
        title={by === "series" ? "Lowest-attendance series" : "Lowest-attendance organizers"}
        description={`Required attendance in the last ${days} days, lowest first. The tick marks the ${Math.round(target * 100)}% target.`}
        actions={
          <SegmentedControl
            size="sm"
            aria-label="Rank by"
            value={by}
            onChange={setBy}
            options={[
              { value: "series", label: "Series" },
              { value: "organizers", label: "Organizers" },
            ]}
          />
        }
      />
      <RankedBars
        rows={by === "series" ? seriesRows : orgRows}
        target={target}
        empty={<EmptyState icon={CheckCircle2} title="No required meetings in this period" description="Series appear here once a meeting with required attendees has ended." compact />}
      />
      {by === "series" && d.series_total > d.series.length && (
        <p className="text-[12px] text-ink3 mt-3">
          Showing the {d.series.length} lowest of {d.series_total} series.
        </p>
      )}
      <button type="button" onClick={() => navigate("/meetings")} className="mt-3 text-[13px] font-medium text-accent hover:underline">
        Open all meetings
      </button>
    </Card>
  );
}

function PeoplePanel({ d, days }: { d: MeetingsDashboardData; days: number }) {
  const openPerson = usePersonModal();
  const openMeeting = useMeetingPanel();
  return (
    <Card className="h-full">
      <CardHeader
        title="People to focus on"
        description={`Most required meetings missed in the last ${days} days. "Repeat" = ${d.thresholds.repeat_misses}+ misses.`}
      />
      {d.people.length === 0 ? (
        <EmptyState
          icon={d.scope.people > 1 ? CheckCircle2 : Users2}
          title={d.kpis.attendance.value == null ? "No required meetings in this period" : "Nobody missed a required meeting"}
          description={d.kpis.attendance.value == null ? "People appear here once a required meeting has ended." : "Everyone you can see attended what they had to."}
          compact
        />
      ) : (
        <ActionList>
          {d.people.map((p) => (
            <ActionRow
              key={p.email}
              leading={<Avatar name={p.name} size={30} />}
              title={
                <span className="flex items-center gap-2">
                  <span className="truncate">{p.name}</span>
                  {p.repeat && (
                    <Label tone="warn" size="sm">
                      Repeat
                    </Label>
                  )}
                </span>
              }
              sub={
                <span>
                  {p.missed} of {p.total} missed · most in{" "}
                  <button
                    type="button"
                    className="underline decoration-dotted hover:text-accent"
                    onClick={(e) => {
                      e.stopPropagation();
                      openMeeting(p.worst_series_id);
                    }}
                  >
                    {p.worst_series}
                  </button>{" "}
                  ({p.worst_series_missed})
                </span>
              }
              right={<RateMeter rate={p.rate} width={56} />}
              onClick={() => openPerson(p.email)}
              label={`Open ${p.name}`}
            />
          ))}
        </ActionList>
      )}
      {d.people_total > d.people.length && <p className="text-[12px] text-ink3 mt-3">Showing {d.people.length} of {d.people_total} people with a miss.</p>}
      {d.scope.people > 1 && <SeeAll to="/team">Open the team</SeeAll>}
    </Card>
  );
}

function useMeetingsBlocks(state: ReturnType<typeof useDashboard<MeetingsDashboardData>>, days: number): DeckBlock[] {
  const navigate = useNavigate();
  const wait = (n = 4) => <KpiGridSkeleton count={n} />;

  return [
    {
      id: "kpis",
      title: "Meeting compliance at a glance",
      kicker: "Headline",
      span: 2,
      gridHeading: <AreaHeading title="Headline numbers" description="Required meeting attendance for you and your reports" icon={CalendarClock} hue={HUE} />,
      node: state.error && !state.data ? <PanelError message={state.error.message} onRetry={state.reload} /> : !state.data ? wait() : (
        <KpiGrid>
          <KpiCard kpi={state.data.kpis.attendance} days={days} hue="sky" icon={CalendarCheck2} onClick={() => navigate("/meetings")} />
          <KpiCard kpi={state.data.kpis.series_at_risk} days={days} hue="violet" icon={AlertTriangle} onClick={() => navigate("/meetings")} />
          <KpiCard kpi={state.data.kpis.repeat_absentees} days={days} hue="pink" icon={UserX} onClick={() => navigate("/team")} />
          <KpiCard kpi={state.data.kpis.meetings_held} days={days} hue="cyan" icon={Video} onClick={() => navigate("/meetings")} />
        </KpiGrid>
      ),
    },
    {
      id: "trend",
      title: "Attendance trend",
      kicker: "Trend",
      span: 2,
      gridHeading: <AreaHeading title="Trends and patterns" description="How attendance moves, and when it slips" icon={CalendarClock} hue="violet" />,
      node: panelOf(state, (d) => (
        <Card className="h-full">
          <CardHeader
            title="Required attendance over time"
            description={`Share of required attendances attended, per ${d.trend.daily ? "day" : "7-day block"}, against the previous ${days} days`}
          />
          <RateTrendChart
            points={rateTrendPoints(d.trend, d.period, (p) => (p.total ? `${p.attended} of ${p.total} required attendances` : "No required meetings"))}
            target={d.trend.target}
            name={`Last ${days} days`}
            previousName={`Previous ${days} days`}
          />
        </Card>
      ), true),
    },
    {
      id: "weekday",
      title: "Attendance by weekday",
      kicker: "Pattern",
      node: panelOf(state, (d) => {
        const withData = d.weekday.filter((w) => w.rate != null);
        const low = withData.length > 1 ? withData.reduce((a, b) => (b.rate! < a.rate! ? b : a)) : null;
        return (
          <Card className="h-full">
            <CardHeader title="When attendance slips" description="Required attendance by the weekday the meeting was held" />
            {withData.length === 0 ? (
              <EmptyState icon={CalendarClock} title="No required meetings in this period" compact />
            ) : (
              <>
                <WeekdayStrip hue={HUE} cells={d.weekday.map((w) => ({ day: w.day, rate: w.rate, note: w.total ? `${w.total} slots` : undefined }))} />
                {low && (
                  <p className="mt-4 text-[13px] text-ink2">
                    Lowest on <span className="font-semibold text-ink">{WEEKDAY_LONG[low.day]}</span>: {Math.round(low.rate! * 100)}% of {low.total} required attendances.
                  </p>
                )}
              </>
            )}
          </Card>
        );
      }),
    },
    {
      id: "turnout",
      title: "Meeting turnout",
      kicker: "Pattern",
      node: panelOf(state, (d) => {
        const t = d.turnout;
        const fullShare = t.total ? t.full / t.total : null;
        return (
          <Card className="h-full">
            <CardHeader title="Meeting turnout" description="Did every required attendee come? Meetings held in the period" />
            {t.total === 0 ? (
              <EmptyState icon={Video} title="No meetings held in this period" compact />
            ) : (
              <div className="flex items-center gap-5">
                <ProgressRing value={fullShare} tone="accent" size={116} stroke={11} label="Meetings with every required attendee">
                  <div className="text-[24px] font-semibold text-ink tabular leading-7">
                    <AnimatedNumber value={Math.round((fullShare ?? 0) * 100)} format={(n) => `${Math.round(n)}%`} />
                  </div>
                  <div className="text-[11px] text-ink3 leading-3">fully attended</div>
                </ProgressRing>
                <div className="min-w-0 flex-1">
                  <StackedBar
                    segments={[
                      { key: "full", label: "Everyone came", value: t.full, color: "linear-gradient(90deg, var(--chart-3), var(--chart-2))" },
                      { key: "partial", label: "Some missing", value: t.partial, color: "linear-gradient(90deg, var(--chart-4), #f97316)" },
                      { key: "none", label: "No one came", value: t.none, color: "linear-gradient(90deg, #f43f5e, var(--crit))" },
                    ]}
                  />
                </div>
              </div>
            )}
          </Card>
        );
      }),
    },
    {
      id: "series",
      title: "Lowest-attendance series",
      kicker: "Act",
      gridHeading: <AreaHeading title="Where to act" description="The series and people behind the number" icon={AlertTriangle} hue="pink" />,
      node: panelOf(state, (d) => <SeriesPanel d={d} days={days} />, true),
    },
    {
      id: "people",
      title: "People to focus on",
      kicker: "Act",
      node: panelOf(state, (d) => <PeoplePanel d={d} days={days} />, true),
    },
  ];
}

export function MeetingsDashboard() {
  const [days, setDays] = usePeriod();
  const state = useDashboard<MeetingsDashboardData>("meetings", days);
  const blocks = useMeetingsBlocks(state, days);
  const d = state.data;
  return (
    <div>
      <DashboardHeader
        title="Meetings"
        description={d ? `Required attendance for ${d.scope.people > 1 ? `you and ${d.scope.people - 1} ${d.scope.people - 1 === 1 ? "person" : "people"} who report to you` : "you"}.` : "Required meeting attendance."}
        days={days}
        onDays={setDays}
        asOf={d?.as_of}
        loading={state.loading}
        onRefresh={state.reload}
      />
      <BlockDeck blocks={blocks} />
    </div>
  );
}
