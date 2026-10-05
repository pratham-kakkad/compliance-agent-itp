import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, ArrowRight, Building2, CalendarCheck2, CalendarClock, CalendarDays, CheckCircle2, Fingerprint, RefreshCw, TrendingUp, Users2 } from "lucide-react";
import { useApi } from "../lib/useApi";
import { pct, rateTone } from "../lib/format";
import { useAuth } from "../auth/AuthContext";
import type { AttendanceDashboardPayload, DashboardPayload, PersonListItem } from "../types";
import {
  Avatar,
  Button,
  Card,
  CardHeader,
  DataTable,
  EmptyState,
  ErrorState,
  IconButton,
  PageHeader,
  RateMeter,
  SectionHeader,
  Skeleton,
  StatCard,
  StatGridSkeleton,
  type Column,
} from "../components/ui";
import { AttendanceDonut, CountBarChart, CountTrendChart, RatedBarChart, TrendChart } from "../components/charts";
import { BlockDeck } from "../components/orbit/BlockDeck";
import type { DeckBlock } from "../components/orbit/types";
import { usePersonModal } from "../components/PersonModal";
import { useMeetingPanel } from "../components/MeetingPanel";

const formatPct = (n: number) => `${Math.round(n)}%`;
const formatCount = (n: number) => String(Math.round(n));
const ratePct = (r: number | null | undefined) => (r == null ? null : r * 100);

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** Placeholder card shown in a panel's place while its data loads. */
function PanelSkeleton() {
  return (
    <Card className="h-full">
      <Skeleton className="h-4 w-40 mb-4" />
      <Skeleton className="h-[160px] w-full" />
    </Card>
  );
}

function PanelError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card className="h-full">
      <ErrorState message={message} onRetry={onRetry} />
    </Card>
  );
}

/** Every panel of the dashboard, as the blocks the grid / orbit ring show. Each carries its own loading and error state. */
function useDashboardBlocks(): DeckBlock[] {
  const navigate = useNavigate();
  const { displayName } = useAuth();
  const openMeeting = useMeetingPanel();
  const openPerson = usePersonModal();
  const meetings = useApi<DashboardPayload>("/dashboard");
  const team = useApi<PersonListItem[]>(meetings.data?.has_reports ? "/people" : null);
  const attendance = useApi<AttendanceDashboardPayload>("/attendance/dashboard");

  const blocks: DeckBlock[] = [];
  const m = meetings.data;
  const mFail = meetings.error && !m;
  const mWait = !mFail && (meetings.initialLoading || !m);
  const mPanel = (node: () => React.ReactNode) =>
    mFail ? <PanelError message={meetings.error!.message} onRetry={meetings.reload} /> : mWait ? <PanelSkeleton /> : node();

  const concerns: Column<DashboardPayload["top_concern_series"][number]>[] = [
    {
      key: "title",
      header: "Meeting",
      cell: (s) => (
        <div className="min-w-0">
          <div className="font-semibold text-ink truncate">{s.title}</div>
          <div className="text-xs text-ink2">{s.missed} of {s.total} required attendances missed</div>
        </div>
      ),
    },
    { key: "org", header: "Organizer", hideBelow: "md", cell: (s) => <span className="text-ink2">{displayName(s.organizer_email)}</span> },
    { key: "rate", header: "Attendance", align: "right", cell: (s) => <RateMeter rate={s.attendance_rate} /> },
  ];

  const focus: Column<DashboardPayload["top_members_to_focus"][number]>[] = [
    {
      key: "person",
      header: "Person",
      cell: (x) => (
        <div className="flex items-center gap-2.5 min-w-0">
          <Avatar name={displayName(x.email)} size={24} />
          <span className="font-semibold text-ink truncate">{displayName(x.email)}</span>
        </div>
      ),
    },
    { key: "missed", header: "Missed", align: "right", cell: (x) => <span className="text-ink2">{x.missed}/{x.total}</span> },
    { key: "rate", header: "Attendance", align: "right", cell: (x) => <RateMeter rate={x.attendance_rate} /> },
  ];

  // ---------------- Meetings ----------------
  blocks.push({
    id: "m-stats",
    title: "Meeting compliance",
    kicker: "Meetings",
    span: 2,
    gridHeading: <SectionHeader title="Meetings" icon={CalendarClock} description="Teams meeting attendance for you and your reports" />,
    node: mFail ? (
      <PanelError message={meetings.error!.message} onRetry={meetings.reload} />
    ) : mWait || !m ? (
      <StatGridSkeleton />
    ) : (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="My attendance rate"
          icon={CalendarCheck2}
          value={pct(m.me.attendance_rate)}
          tone={rateTone(m.me.attendance_rate)}
          animateValue={m.me.required_total === 0 ? null : ratePct(m.me.attendance_rate)}
          formatValue={formatPct}
          foot={m.me.required_total === 0 ? "No required meetings yet" : `${m.me.required_attended} of ${m.me.required_total} required meetings`}
        />
        <StatCard
          label="Direct reports"
          icon={Users2}
          value={String(m.direct_report_count)}
          animateValue={m.direct_report_count}
          formatValue={formatCount}
          foot={`${m.total_report_count} total in your org`}
          onClick={m.has_reports ? () => navigate("/team") : undefined}
        />
        <StatCard
          label="Team attendance rate"
          icon={TrendingUp}
          value={m.team ? pct(m.team.attendance_rate) : "—"}
          tone={m.team ? rateTone(m.team.attendance_rate) : "neutral"}
          animateValue={m.team ? ratePct(m.team.attendance_rate) : null}
          formatValue={formatPct}
          trend={m.team ? m.trend.map((t) => t.attendance_rate) : undefined}
          foot={m.team ? `${m.team.attended} of ${m.team.total} required meetings` : "No direct reports"}
        />
        <StatCard
          label="Open concerns"
          icon={AlertTriangle}
          value={String(m.top_concern_series.length)}
          tone={m.top_concern_series.length ? "crit" : "good"}
          animateValue={m.top_concern_series.length}
          formatValue={formatCount}
          foot="Meeting series with a required miss"
          onClick={() => navigate("/meetings")}
        />
      </div>
    ),
  });

  blocks.push({
    id: "m-trend",
    title: "Attendance trend",
    kicker: "Meetings",
    node: mPanel(() => (
      <Card className="h-full">
        <CardHeader title="Attendance trend" description="Required meetings, weekly" />
        <TrendChart data={m!.trend.map((t) => ({ week_start: t.week_start, rate: t.attendance_rate }))} label="Attendance" />
      </Card>
    )),
  });

  blocks.push({
    id: "m-required",
    title: "My required meetings",
    kicker: "Meetings",
    node: mPanel(() => (
      <Card className="h-full">
        <CardHeader title="My required meetings" description="Across all series you're required at" />
        <AttendanceDonut attended={m!.me.required_attended} total={m!.me.required_total} />
      </Card>
    )),
  });

  blocks.push({
    id: "m-concerns",
    title: "Meetings needing attention",
    kicker: "Meetings",
    node: mPanel(() => (
      <Card padding="none" className="h-full overflow-hidden">
        <CardHeader
          divider
          title="Meetings needing attention"
          description="Series with the most required absences"
          actions={<Button size="sm" variant="ghost" trailingIcon={ArrowRight} onClick={() => navigate("/meetings")}>View all</Button>}
        />
        <DataTable
          columns={concerns}
          rows={m!.top_concern_series}
          getRowKey={(s) => s.series_id}
          onRowClick={(s) => openMeeting(s.series_id)}
          rowLabel={(s) => `Open ${s.title}`}
          rank
          empty={<EmptyState icon={CheckCircle2} title="No concerns" description="Every required attendee is showing up." compact />}
        />
      </Card>
    )),
  });

  blocks.push({
    id: "m-focus",
    title: "People to focus on",
    kicker: "Meetings",
    node: mPanel(() => (
      <Card padding="none" className="h-full overflow-hidden">
        <CardHeader
          divider
          title="People to focus on"
          description="Reports with the most missed required meetings"
          actions={m!.has_reports && <Button size="sm" variant="ghost" trailingIcon={ArrowRight} onClick={() => navigate("/team")}>View team</Button>}
        />
        <DataTable
          columns={focus}
          rows={m!.top_members_to_focus}
          getRowKey={(x) => x.email}
          onRowClick={(x) => openPerson(x.email)}
          rowLabel={(x) => `Open ${displayName(x.email)}`}
          rank
          empty={
            <EmptyState
              icon={m!.has_reports ? CheckCircle2 : Users2}
              title={m!.has_reports ? "Your team is fully compliant" : "No direct reports"}
              description={m!.has_reports ? "Nobody has missed a required meeting." : "People who report to you will show up here."}
              compact
            />
          }
        />
      </Card>
    )),
  });

  if (m?.has_reports) {
    blocks.push({
      id: "m-team",
      title: "Team breakdown",
      kicker: "Meetings",
      span: 2,
      node: (
        <Card className="h-full">
          <CardHeader title="Team attendance breakdown" description="Required meetings, all visible reports — lowest first" />
          {team.error ? (
            <ErrorState compact message={team.error.message} onRetry={team.reload} />
          ) : !team.data ? (
            <div className="flex flex-col gap-3">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-3 w-full" />)}
            </div>
          ) : (
            <RatedBarChart
              name="Attendance"
              data={team.data
                .filter((p) => !p.is_self)
                .sort((a, b) => (a.attendance_rate ?? 1) - (b.attendance_rate ?? 1))
                .map((p) => ({ label: p.name, rate: p.attendance_rate }))}
            />
          )}
        </Card>
      ),
    });
  }

  // ---------------- Attendance ----------------
  const a = attendance.data;
  const aFail = attendance.error && !a;
  const aWait = !aFail && (attendance.initialLoading || !a);
  const aPanel = (node: () => React.ReactNode) =>
    aFail ? <PanelError message={attendance.error!.message} onRetry={attendance.reload} /> : aWait ? <PanelSkeleton /> : node();

  blocks.push({
    id: "a-stats",
    title: "Attendance compliance",
    kicker: "Attendance",
    span: 2,
    gridHeading: <SectionHeader title="Attendance" icon={Fingerprint} description="Biometric punch-log compliance" />,
    node: aFail ? (
      <PanelError message={attendance.error!.message} onRetry={attendance.reload} />
    ) : aWait || !a ? (
      <StatGridSkeleton />
    ) : (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <StatCard label="Employees tracked" icon={Fingerprint} value={String(a.summary.employee_count)} animateValue={a.summary.employee_count} formatValue={formatCount} foot="On biometric devices" onClick={() => navigate("/attendance")} />
        <StatCard label="Days tracked" icon={CalendarDays} value={String(a.summary.total_days_tracked)} animateValue={a.summary.total_days_tracked} formatValue={formatCount} foot="Across every employee" />
        <StatCard label="Departments" icon={Building2} value={String(a.by_department.length)} animateValue={a.by_department.length} formatValue={formatCount} foot="With tracked attendance" />
      </div>
    ),
  });

  blocks.push({
    id: "a-trend",
    title: "Days tracked",
    kicker: "Attendance",
    node: aPanel(() => (
      <Card className="h-full">
        <CardHeader title="Attendance trend" description="Days tracked, weekly" />
        <CountTrendChart data={a!.trend.map((t) => ({ week_start: t.week_start, count: t.days_tracked }))} label="Days tracked" />
      </Card>
    )),
  });

  blocks.push({
    id: "a-dept",
    title: "By department",
    kicker: "Attendance",
    node: aPanel(() => (
      <Card className="h-full">
        <CardHeader title="By department" description="Days tracked per department" />
        {a!.by_department.length ? (
          <CountBarChart name="Days tracked" data={a!.by_department.map((d) => ({ label: d.department, count: d.days_tracked }))} />
        ) : (
          <EmptyState icon={Building2} title="No department data yet" compact />
        )}
      </Card>
    )),
  });

  return blocks;
}

function DashboardDeck() {
  const blocks = useDashboardBlocks();
  return <BlockDeck blocks={blocks} />;
}

export function Dashboard() {
  const { me } = useAuth();
  const firstName = me?.name.split(" ")[0] ?? "";
  // Remounting the deck re-runs its fetches — simplest reliable refresh.
  const [nonce, setNonce] = useState(0);

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description={`${greeting()}, ${firstName} — here's where compliance stands across every agent.`}
        actions={<IconButton icon={RefreshCw} label="Refresh data" variant="secondary" onClick={() => setNonce((n) => n + 1)} />}
      />
      <DashboardDeck key={nonce} />
    </div>
  );
}
