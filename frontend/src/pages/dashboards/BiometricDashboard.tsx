import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AlarmClock, Building2, CheckCircle2, Clock3, DoorOpen, Fingerprint, ScanLine, Timer, UserCheck, UserMinus, UploadCloud } from "lucide-react";
import { AnimatedNumber, Avatar, Banner, Button, Card, CardHeader, EmptyState, Label, SegmentedControl } from "../../components/ui";
import { BlockDeck } from "../../components/orbit/BlockDeck";
import type { DeckBlock } from "../../components/orbit/types";
import { RateTrendChart } from "../../components/charts";
import {
  ActionList,
  ActionRow,
  AreaHeading,
  DashboardHeader,
  KpiCard,
  KpiGrid,
  KpiGridSkeleton,
  PanelError,
  ProgressRing,
  RankedBars,
  SeeAll,
  WeekdayStrip,
  panelOf,
  rateTrendPoints,
  useDashboard,
  usePeriod,
  type RankedRow,
} from "../../components/dash";
import { WorkHoursTile, useWorkHoursDialog } from "../../components/dash/WorkHours";
import { useAttendanceEmployeeModal } from "../../components/AttendanceEmployeeModal";
import { fmtDateTime, fmtDay } from "../../lib/format";
import { WEEKDAY_LONG, type BiometricDashboardData } from "../../lib/dashboards";
import type { Tone } from "../../lib/format";

const HUE = "teal" as const;

function rateToneFor(rate: number | null, target: number): Tone {
  if (rate == null) return "neutral";
  return rate >= target ? "good" : rate >= target - 0.15 ? "warn" : "crit";
}

function NotSeenPanel({ d }: { d: BiometricDashboardData }) {
  const openEmployee = useAttendanceEmployeeModal();
  const gone = d.not_seen.filter((p) => p.assumed_left).length;
  return (
    <Card className="h-full">
      <CardHeader
        title="Not seen recently"
        description={`Employees with no punch in the ${d.thresholds.quiet_days} days up to ${d.reference_day ? fmtDay(d.reference_day) : "the latest working day"}, longest absence first`}
      />
      {d.not_seen.length === 0 ? (
        <EmptyState icon={CheckCircle2} title={d.empty ? "No punch data yet" : "Everyone has been seen"} description={d.empty ? "Import a punch log to see who is missing." : "Every tracked employee punched in the last week."} compact />
      ) : (
        <ActionList>
          {d.not_seen.map((p) => (
            <ActionRow
              key={p.emp_code}
              leading={<Avatar name={p.name} size={30} />}
              title={p.name}
              sub={p.department ?? "No department"}
              right={
                <>
                  {p.assumed_left && <Label size="sm">Assumed left</Label>}
                  <span className="text-ink2">
                    {fmtDay(p.last_seen)} <span className="text-ink3">{"·"} {p.days_silent} days</span>
                  </span>
                </>
              }
              onClick={() => openEmployee(p.emp_code)}
              label={`Open ${p.name}`}
            />
          ))}
        </ActionList>
      )}
      <p className="text-[12px] text-ink3 mt-3">
        {d.not_seen_total > d.not_seen.length ? `Showing ${d.not_seen.length} of ${d.not_seen_total}. ` : ""}
        {gone > 0 || d.not_seen_total > 0 ? `After ${d.thresholds.leaver_after_days} days without a punch someone is assumed to have left and no longer counts as expected.` : ""}
      </p>
      <SeeAll to="/attendance">All employees</SeeAll>
    </Card>
  );
}

function FollowUpPanel({ d }: { d: BiometricDashboardData }) {
  const [tab, setTab] = useState<"late" | "missed" | "low">("late");
  const openEmployee = useAttendanceEmployeeModal();
  const rows =
    tab === "late"
      ? d.late_people.map((p) => ({ p, right: `${p.count} late of ${p.days_present} days`, rate: p.rate }))
      : tab === "missed"
        ? d.missed_punch_people.map((p) => ({ p, right: `${p.count} of ${p.days_present} days`, rate: p.rate }))
        : d.low_presence_people.map((p) => ({ p, right: `${p.present} of ${p.expected} days`, rate: p.rate }));
  const meta = {
    late: { title: "Late arrivals", desc: `First punch after ${d.work_hours.work_start} + ${d.work_hours.grace_minutes} min, most late days first`, empty: "Nobody arrived late in this period." },
    missed: { title: "Missed punches", desc: "Days with a single punch, so arrival or departure is unknown, most first", empty: "Every present day has more than one punch." },
    low: { title: "Lowest attendance", desc: "Share of expected working days present, lowest first (3+ expected days)", empty: "Everyone expected was present every day." },
  }[tab];
  return (
    <Card className="h-full">
      <CardHeader
        title={meta.title}
        description={meta.desc}
        actions={
          <SegmentedControl
            size="sm"
            aria-label="People to follow up"
            value={tab}
            onChange={setTab}
            options={[
              { value: "late", label: "Late" },
              { value: "missed", label: "Missed punch" },
              { value: "low", label: "Low" },
            ]}
          />
        }
      />
      {rows.length === 0 ? (
        <EmptyState icon={CheckCircle2} title={d.empty ? "No punch data yet" : meta.empty} compact />
      ) : (
        <ActionList>
          {rows.map(({ p, right }) => (
            <ActionRow
              key={p.emp_code}
              leading={<Avatar name={p.name} size={30} />}
              title={p.name}
              sub={p.department ?? "No department"}
              right={<span className="text-ink2">{right}</span>}
              onClick={() => openEmployee(p.emp_code)}
              label={`Open ${p.name}`}
            />
          ))}
        </ActionList>
      )}
    </Card>
  );
}

function useBiometricBlocks(state: ReturnType<typeof useDashboard<BiometricDashboardData>>, days: number, editHours: (w: BiometricDashboardData["work_hours"]) => void): DeckBlock[] {
  const navigate = useNavigate();
  const d = state.data;
  const failed = state.error && !d;
  const kpiBlock = (render: (d: BiometricDashboardData) => React.ReactNode, n = 4) => (failed ? <PanelError message={state.error!.message} onRetry={state.reload} /> : !d ? <KpiGridSkeleton count={n} /> : render(d));

  return [
    {
      id: "kpis",
      title: "Attendance at a glance",
      kicker: "Headline",
      span: 2,
      gridHeading: <AreaHeading title="Headline numbers" description="Presence on working days, from the biometric punch logs" icon={Fingerprint} hue={HUE} />,
      node: kpiBlock((d) => (
        <KpiGrid>
          <KpiCard kpi={d.kpis.attendance} days={days} hue="teal" icon={Fingerprint} onClick={() => navigate("/attendance")} />
          <KpiCard kpi={d.kpis.present_today} days={days} hue="emerald" icon={UserCheck} />
          <KpiCard kpi={d.kpis.not_seen} days={days} hue="amber" icon={UserMinus} onClick={() => navigate("/attendance")} />
          <KpiCard kpi={d.kpis.avg_hours} days={days} hue="indigo" icon={Timer} />
        </KpiGrid>
      )),
    },
    {
      id: "punctuality",
      title: "Punctuality and punch quality",
      kicker: "Headline",
      span: 2,
      gridHeading: <AreaHeading title="Punctuality and punch quality" description="Against the work hours set for the organization" icon={Clock3} hue="amber" />,
      node: kpiBlock((d) => (
        <KpiGrid>
          <KpiCard kpi={d.kpis.late_arrivals} days={days} hue="amber" icon={AlarmClock} />
          <KpiCard kpi={d.kpis.early_exits} days={days} hue="violet" icon={DoorOpen} />
          <KpiCard kpi={d.kpis.missed_punch} days={days} hue="pink" icon={ScanLine} />
          <WorkHoursTile hours={d.work_hours} onEdit={() => editHours(d.work_hours)} />
        </KpiGrid>
      )),
    },
    {
      id: "trend",
      title: "Attendance trend",
      kicker: "Trend",
      span: 2,
      gridHeading: <AreaHeading title="Trends and patterns" description="How presence moves, by day of week and by department" icon={Fingerprint} hue="violet" />,
      node: panelOf(
        state,
        (d) => (
          <Card className="h-full">
            <CardHeader
              title="Attendance rate over time"
              description={`Present employee-days / expected, working days only, per ${d.trend.daily ? "day" : "7-day block"}, against the previous ${days} days`}
            />
            <RateTrendChart
              colorIndex={3}
              points={rateTrendPoints(d.trend, d.period ?? { days, start: "", end: "", previous_start: "", previous_end: "" }, (p) => (p.expected ? `${p.present} of ${p.expected} expected days` : "No working days"))}
              target={d.trend.target}
              name={`Last ${days} days`}
              previousName={`Previous ${days} days`}
            />
          </Card>
        ),
        true
      ),
    },
    {
      id: "weekday",
      title: "Presence by weekday",
      kicker: "Pattern",
      node: panelOf(state, (d) => {
        const withData = d.weekday.filter((w) => w.rate != null);
        const low = withData.length > 1 ? withData.reduce((a, b) => (b.rate! < a.rate! ? b : a)) : null;
        return (
          <Card className="h-full">
            <CardHeader title="Presence by weekday" description="Share of expected people present, by day of the week" />
            {withData.length === 0 ? (
              <EmptyState icon={Fingerprint} title="No working days in this period" compact />
            ) : (
              <>
                <WeekdayStrip hue={HUE} cells={d.weekday.map((w) => ({ day: w.day, rate: w.rate, note: w.expected ? `${w.expected} days` : undefined }))} />
                {low && (
                  <p className="mt-4 text-[13px] text-ink2">
                    Quietest on <span className="font-semibold text-ink">{WEEKDAY_LONG[low.day]}</span>: {Math.round(low.rate! * 100)}% present.
                  </p>
                )}
                <div className="mt-5 pt-4 border-t border-line-soft flex items-center gap-5">
                  <ProgressRing value={d.kpis.attendance.value} target={d.thresholds.target} tone={d.kpis.attendance.tone === "neutral" ? "accent" : d.kpis.attendance.tone} size={108} stroke={11} label="Attendance rate">
                    <div className="text-[22px] font-semibold text-ink tabular leading-6">{d.kpis.attendance.value == null ? "—" : <AnimatedNumber value={d.kpis.attendance.value * 100} format={(n) => `${Math.round(n)}%`} />}</div>
                    <div className="text-[10.5px] text-ink3 leading-3">attendance</div>
                  </ProgressRing>
                  <p className="text-[13px] text-ink2 min-w-0">
                    Across the {d.period?.working_days ?? 0} working days in this period, {d.kpis.attendance.numerator?.toLocaleString()} of {d.kpis.attendance.denominator?.toLocaleString()} expected employee-days had a punch. The tick on the ring marks the {Math.round(d.thresholds.target * 100)}% target.
                  </p>
                </div>
              </>
            )}
          </Card>
        );
      }),
    },
    {
      id: "departments",
      title: "Departments compared",
      kicker: "Pattern",
      node: panelOf(
        state,
        (d) => {
          const target = d.thresholds.target;
          const rows: RankedRow[] = d.departments.map((x) => ({
            key: x.department,
            label: x.department,
            value: x.rate,
            tone: rateToneFor(x.rate, target),
            delta: x.delta,
            sub: `${x.headcount} ${x.headcount === 1 ? "person" : "people"} · ${x.present} of ${x.expected} days`,
          }));
          return (
            <Card className="h-full">
              <CardHeader title="Departments compared" description={`Attendance rate, lowest first. The tick marks the ${Math.round(target * 100)}% target.`} />
              <RankedBars rows={rows} target={target} dense empty={<EmptyState icon={Building2} title="No department data in this period" compact />} />
            </Card>
          );
        },
        true
      ),
    },
    {
      id: "not-seen",
      title: "Not seen recently",
      kicker: "Act",
      gridHeading: <AreaHeading title="Where to act" description="The people behind the numbers" icon={UserMinus} hue="pink" />,
      node: panelOf(state, (d) => <NotSeenPanel d={d} />, true),
    },
    {
      id: "follow-up",
      title: "People to follow up",
      kicker: "Act",
      node: panelOf(state, (d) => <FollowUpPanel d={d} />, true),
    },
  ];
}

export function BiometricDashboard() {
  const [days, setDays] = usePeriod();
  const state = useDashboard<BiometricDashboardData>("biometric", days);
  const editHours = useWorkHoursDialog(state.reload);
  const blocks = useBiometricBlocks(state, days, editHours);
  const d = state.data;
  return (
    <div>
      <DashboardHeader
        title="Biometric attendance"
        description={
          d?.data_through
            ? `Punch-log data through ${fmtDay(d.data_through)}${d.last_import ? ` · last import ${fmtDateTime(d.last_import.at)}` : ""}.`
            : "Presence and punctuality from the punch-log imports."
        }
        days={days}
        onDays={setDays}
        asOf={d?.as_of}
        loading={state.loading}
        onRefresh={state.reload}
        actions={
          d && (
            <Button variant="secondary" leadingIcon={Clock3} onClick={() => editHours(d.work_hours)}>
              Work hours {d.work_hours.work_start}{"–"}{d.work_hours.work_end}
            </Button>
          )
        }
      />
      {d?.empty && (
        <Banner tone="info" title="No punch data yet" className="mb-4" action={<Link to="/attendance/import"><Button size="sm" leadingIcon={UploadCloud}>Import a punch log</Button></Link>}>
          Every number below is empty until a punch-log export has been imported.
        </Banner>
      )}
      {d?.stale && d.data_through && (
        <Banner tone="warn" title={`The latest punches are ${d.data_age_days} days old`} className="mb-4" action={<Link to="/attendance/import"><Button size="sm" leadingIcon={UploadCloud}>Import newer data</Button></Link>}>
          These figures describe the period ending {d.reference_day ? fmtDay(d.reference_day) : fmtDay(d.data_through)}, not today. Import a recent punch log to bring them up to date.
        </Banner>
      )}
      <BlockDeck blocks={blocks} />
    </div>
  );
}
