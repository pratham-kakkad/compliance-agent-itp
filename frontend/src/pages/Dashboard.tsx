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
import { usePersonModal } from "../components/PersonModal";
import { useMeetingPanel } from "../components/MeetingPanel";

const formatPct = (n: number) => `${Math.round(n)}%`;
const formatCount = (n: number) => String(Math.round(n));
const ratePct = (r: number | null | undefined) => (r == null ? null : r * 100);

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function ChartsSkeleton() {
  return (
    <div className="grid lg:grid-cols-3 gap-4">
      <Card className="lg:col-span-2">
        <Skeleton className="h-4 w-40 mb-4" />
        <Skeleton className="h-[200px] w-full" />
      </Card>
      <Card>
        <Skeleton className="h-4 w-40 mb-4" />
        <Skeleton className="h-[200px] w-[200px] mx-auto !rounded-full" />
      </Card>
    </div>
  );
}

function MeetingsSection() {
  const navigate = useNavigate();
  const { displayName } = useAuth();
  const openMeeting = useMeetingPanel();
  const openPerson = usePersonModal();
  const { data, error, initialLoading, reload } = useApi<DashboardPayload>("/dashboard");
  const team = useApi<PersonListItem[]>(data?.has_reports ? "/people" : null);

  if (error && !data) return <Card><ErrorState message={error.message} onRetry={reload} /></Card>;
  if (initialLoading || !data) {
    return (
      <div className="flex flex-col gap-4">
        <StatGridSkeleton />
        <ChartsSkeleton />
      </div>
    );
  }

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
      cell: (m) => (
        <div className="flex items-center gap-2.5 min-w-0">
          <Avatar name={displayName(m.email)} size={24} />
          <span className="font-semibold text-ink truncate">{displayName(m.email)}</span>
        </div>
      ),
    },
    { key: "missed", header: "Missed", align: "right", cell: (m) => <span className="text-ink2">{m.missed}/{m.total}</span> },
    { key: "rate", header: "Attendance", align: "right", cell: (m) => <RateMeter rate={m.attendance_rate} /> },
  ];

  const noOwnMeetings = data.me.required_total === 0;
  const trend = data.trend.map((t) => t.attendance_rate);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="My attendance rate"
          icon={CalendarCheck2}
          value={pct(data.me.attendance_rate)}
          tone={rateTone(data.me.attendance_rate)}
          animateValue={noOwnMeetings ? null : ratePct(data.me.attendance_rate)}
          formatValue={formatPct}
          foot={noOwnMeetings ? "No required meetings yet" : `${data.me.required_attended} of ${data.me.required_total} required meetings`}
        />
        <StatCard
          label="Direct reports"
          icon={Users2}
          value={String(data.direct_report_count)}
          animateValue={data.direct_report_count}
          formatValue={formatCount}
          foot={`${data.total_report_count} total in your org`}
          onClick={data.has_reports ? () => navigate("/team") : undefined}
        />
        <StatCard
          label="Team attendance rate"
          icon={TrendingUp}
          value={data.team ? pct(data.team.attendance_rate) : "—"}
          tone={data.team ? rateTone(data.team.attendance_rate) : "neutral"}
          animateValue={data.team ? ratePct(data.team.attendance_rate) : null}
          formatValue={formatPct}
          trend={data.team ? trend : undefined}
          foot={data.team ? `${data.team.attended} of ${data.team.total} required meetings` : "No direct reports"}
        />
        <StatCard
          label="Open concerns"
          icon={AlertTriangle}
          value={String(data.top_concern_series.length)}
          tone={data.top_concern_series.length ? "crit" : "good"}
          animateValue={data.top_concern_series.length}
          formatValue={formatCount}
          foot="Meeting series with a required miss"
          onClick={() => navigate("/meetings")}
        />
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader title="Attendance trend" description="Required meetings, weekly" />
          <TrendChart data={data.trend.map((t) => ({ week_start: t.week_start, rate: t.attendance_rate }))} label="Attendance" />
        </Card>
        <Card>
          <CardHeader title="My required meetings" description="Across all series you're required at" />
          <AttendanceDonut attended={data.me.required_attended} total={data.me.required_total} />
        </Card>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <Card padding="none" className="overflow-hidden">
          <CardHeader
            divider
            title="Meetings needing attention"
            description="Series with the most required absences"
            actions={<Button size="sm" variant="ghost" trailingIcon={ArrowRight} onClick={() => navigate("/meetings")}>View all</Button>}
          />
          <DataTable
            columns={concerns}
            rows={data.top_concern_series}
            getRowKey={(s) => s.series_id}
            onRowClick={(s) => openMeeting(s.series_id)}
            rowLabel={(s) => `Open ${s.title}`}
            rank
            empty={<EmptyState icon={CheckCircle2} title="No concerns" description="Every required attendee is showing up." compact />}
          />
        </Card>
        <Card padding="none" className="overflow-hidden">
          <CardHeader
            divider
            title="People to focus on"
            description="Reports with the most missed required meetings"
            actions={data.has_reports && <Button size="sm" variant="ghost" trailingIcon={ArrowRight} onClick={() => navigate("/team")}>View team</Button>}
          />
          <DataTable
            columns={focus}
            rows={data.top_members_to_focus}
            getRowKey={(m) => m.email}
            onRowClick={(m) => openPerson(m.email)}
            rowLabel={(m) => `Open ${displayName(m.email)}`}
            rank
            empty={
              <EmptyState
                icon={data.has_reports ? CheckCircle2 : Users2}
                title={data.has_reports ? "Your team is fully compliant" : "No direct reports"}
                description={data.has_reports ? "Nobody has missed a required meeting." : "People who report to you will show up here."}
                compact
              />
            }
          />
        </Card>
      </div>

      {data.has_reports && (
        <Card>
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
      )}
    </div>
  );
}

function AttendanceSection() {
  const navigate = useNavigate();
  const { data, error, initialLoading, reload } = useApi<AttendanceDashboardPayload>("/attendance/dashboard");

  if (error && !data) return <Card><ErrorState message={error.message} onRetry={reload} /></Card>;
  if (initialLoading || !data) {
    return (
      <div className="flex flex-col gap-4">
        <StatGridSkeleton />
        <ChartsSkeleton />
      </div>
    );
  }

  const s = data.summary;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <StatCard label="Employees tracked" icon={Fingerprint} value={String(s.employee_count)} animateValue={s.employee_count} formatValue={formatCount} foot="On biometric devices" onClick={() => navigate("/attendance")} />
        <StatCard label="Days tracked" icon={CalendarDays} value={String(s.total_days_tracked)} animateValue={s.total_days_tracked} formatValue={formatCount} foot="Across every employee" />
        <StatCard label="Departments" icon={Building2} value={String(data.by_department.length)} animateValue={data.by_department.length} formatValue={formatCount} foot="With tracked attendance" />
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader title="Attendance trend" description="Days tracked, weekly" />
          <CountTrendChart data={data.trend.map((t) => ({ week_start: t.week_start, count: t.days_tracked }))} label="Days tracked" />
        </Card>
        <Card>
          <CardHeader title="By department" description="Days tracked per department" />
          {data.by_department.length ? (
            <CountBarChart name="Days tracked" data={data.by_department.map((d) => ({ label: d.department, count: d.days_tracked }))} />
          ) : (
            <EmptyState icon={Building2} title="No department data yet" compact />
          )}
        </Card>
      </div>
    </div>
  );
}

export function Dashboard() {
  const { me } = useAuth();
  const firstName = me?.name.split(" ")[0] ?? "";
  // Remounting the sections re-runs their fetches — simplest reliable refresh.
  const [nonce, setNonce] = useState(0);

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description={`${greeting()}, ${firstName} — here's where compliance stands across every agent.`}
        actions={<IconButton icon={RefreshCw} label="Refresh data" variant="secondary" onClick={() => setNonce((n) => n + 1)} />}
      />
      <section aria-label="Meetings" className="mb-10" key={`m${nonce}`}>
        <SectionHeader title="Meetings" icon={CalendarClock} description="Teams meeting attendance for you and your reports" />
        <MeetingsSection />
      </section>
      <section aria-label="Attendance" key={`a${nonce}`}>
        <SectionHeader title="Attendance" icon={Fingerprint} description="Biometric punch-log compliance" />
        <AttendanceSection />
      </section>
    </div>
  );
}
