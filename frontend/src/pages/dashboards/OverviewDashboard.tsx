import { Link, useNavigate } from "react-router-dom";
import { AlertTriangle, ArrowRight, CalendarCheck2, CalendarClock, CheckCircle2, Fingerprint, ShieldAlert, ShieldCheck, UserCheck, UserMinus, UserX, type LucideIcon } from "lucide-react";
import clsx from "clsx";
import { useAuth } from "../../auth/AuthContext";
import { Avatar, Button, Card, CardHeader, EmptyState, Label } from "../../components/ui";
import { BlockDeck } from "../../components/orbit/BlockDeck";
import type { DeckBlock } from "../../components/orbit/types";
import { ActionList, ActionRow, AreaHeading, DashboardHeader, KpiCard, KpiGrid, KpiGridSkeleton, PanelError, panelOf, useDashboard, usePeriod } from "../../components/dash";
import { useMeetingPanel } from "../../components/MeetingPanel";
import { useAttendanceEmployeeModal } from "../../components/AttendanceEmployeeModal";
import { RateMeter } from "../../components/ui";
import { PriorityLabel } from "../../components/compliance/common";
import { fmtDay } from "../../lib/format";
import type { Priority } from "../../lib/compliance";
import type { Hue, Kpi, OverviewData } from "../../lib/dashboards";

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** The card for one area: its name, a clear "Open dashboard" link, and its headline KPIs. */
function AreaSummary({
  title,
  description,
  icon: Icon,
  hue,
  to,
  kpis,
  icons,
  hues,
  days,
  note,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
  hue: Hue;
  to: string;
  kpis: Kpi[];
  icons: LucideIcon[];
  hues: Hue[];
  days: number;
  note?: React.ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <Card className="h-full">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div className={clsx("flex items-center gap-2.5 min-w-0", `hue-${hue}`)}>
          <span className="nav-chip-on w-9 h-9 rounded-xl flex items-center justify-center flex-none">
            <Icon size={18} aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-ink leading-5">{title}</h2>
            <p className="text-[13px] text-ink2 truncate">{description}</p>
          </div>
        </div>
        <Link to={to} aria-label={`Open the ${title} dashboard`}>
          <Button variant="secondary" size="sm" trailingIcon={ArrowRight}>
            Open dashboard
          </Button>
        </Link>
      </div>
      {note}
      <KpiGrid cols={3}>
        {kpis.map((k, i) => (
          <KpiCard key={k.key} kpi={k} days={days} hue={hues[i] ?? hue} icon={icons[i]} onClick={() => navigate(to)} />
        ))}
      </KpiGrid>
    </Card>
  );
}

function useOverviewBlocks(state: ReturnType<typeof useDashboard<OverviewData>>, days: number): DeckBlock[] {
  const openMeeting = useMeetingPanel();
  const openEmployee = useAttendanceEmployeeModal();
  const navigate = useNavigate();
  const d = state.data;
  const failed = state.error && !d;
  const kpiWait = failed ? <PanelError message={state.error!.message} onRetry={state.reload} /> : <Card className="h-full"><KpiGridSkeleton count={3} /></Card>;

  return [
    {
      id: "meetings",
      title: "Meetings",
      kicker: "Headline",
      span: 2,
      gridHeading: <AreaHeading title="Where each area stands" description={`Headline numbers for the last ${days} days, against the ${days} before`} icon={CalendarClock} hue="indigo" />,
      node: !d ? kpiWait : (
        <AreaSummary
          title="Meetings"
          description="Required attendance at Teams meetings"
          icon={CalendarClock}
          hue="sky"
          to="/dashboards/meetings"
          kpis={d.meetings.kpis}
          icons={[CalendarCheck2, AlertTriangle, UserX]}
          hues={["sky", "violet", "pink"]}
          days={days}
        />
      ),
    },
    {
      id: "biometric",
      title: "Biometric attendance",
      kicker: "Headline",
      span: 2,
      node: !d ? kpiWait : (
        <AreaSummary
          title="Biometric attendance"
          description="Presence from the punch-log imports"
          icon={Fingerprint}
          hue="teal"
          to="/dashboards/biometric"
          kpis={d.biometric.kpis}
          icons={[Fingerprint, UserCheck, UserMinus]}
          hues={["teal", "emerald", "amber"]}
          days={days}
          note={
            d.biometric.stale && d.biometric.data_through ? (
              <p className="text-[12.5px] text-warn font-medium mb-3">
                Punch data ends {fmtDay(d.biometric.data_through)}, {d.biometric.data_age_days} days ago: these figures are not today&apos;s.
              </p>
            ) : undefined
          }
        />
      ),
    },
    {
      id: "compliance",
      title: "General compliance",
      kicker: "Headline",
      span: 2,
      node: !d ? kpiWait : d.compliance.available ? (
        <AreaSummary
          title="General compliance"
          description="Obligations, evidence and reviews"
          icon={ShieldCheck}
          hue="violet"
          to="/compliance"
          kpis={d.compliance.kpis}
          icons={[ShieldCheck, AlertTriangle, CalendarClock]}
          hues={["violet", "amber", "sky"]}
          days={days}
        />
      ) : (
        <Card className="h-full">
          <EmptyState icon={ShieldAlert} title="General compliance is not available to you" description={d.compliance.reason} compact />
        </Card>
      ),
    },
    {
      id: "attention-compliance",
      title: "Overdue compliance",
      kicker: "Needs attention now",
      gridHeading: <AreaHeading title="Needs attention now" description="The few things most worth acting on today" icon={AlertTriangle} hue="pink" />,
      node: panelOf(state, (d) => {
        const c = d.compliance;
        return (
          <Card className="h-full">
            <CardHeader
              title="Overdue compliances"
              description="Open required items past their deadline, highest priority first"
              actions={c.available && c.attention_total > 0 ? <Label tone="crit">{c.attention_total} overdue</Label> : undefined}
            />
            {!c.available ? (
              <EmptyState icon={ShieldAlert} title="Not available to you" description={c.reason} compact />
            ) : c.attention.length === 0 ? (
              <EmptyState icon={CheckCircle2} title="Nothing is overdue" description="Every open required item is within its deadline." compact />
            ) : (
              <ActionList>
                {c.attention.map((g) => (
                  <ActionRow
                    key={g.compliance_id}
                    title={g.name}
                    sub={`${g.overdue} ${g.overdue === 1 ? "item" : "items"} overdue · oldest ${g.oldest_days} ${g.oldest_days === 1 ? "day" : "days"} late`}
                    right={<PriorityLabel priority={g.priority as Priority} />}
                    onClick={() => navigate(`/compliance/library/${g.compliance_id}`)}
                    label={`Open ${g.name}`}
                  />
                ))}
              </ActionList>
            )}
            {c.available && (
              <Link to="/compliance" className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline">
                Open the compliance dashboard <ArrowRight size={13} aria-hidden />
              </Link>
            )}
          </Card>
        );
      }, true),
    },
    {
      id: "attention-meetings",
      title: "Meetings at risk",
      kicker: "Needs attention now",
      node: panelOf(state, (d) => {
        const m = d.meetings;
        return (
          <Card className="h-full">
            <CardHeader
              title="Meetings at risk"
              description="Series below 75% required attendance in this period"
              actions={m.attention_total > 0 ? <Label tone="warn">{m.attention_total} at risk</Label> : undefined}
            />
            {m.attention.length === 0 ? (
              <EmptyState
                icon={CheckCircle2}
                title={m.kpis[0].value == null ? "No required meetings in this period" : "No series at risk"}
                description={m.kpis[0].value == null ? "Series appear here once a required meeting has ended." : "Every series is at or above 75%."}
                compact
              />
            ) : (
              <ActionList>
                {m.attention.map((s) => (
                  <ActionRow
                    key={s.series_id}
                    title={s.title}
                    sub={`${s.organizer_name} · ${s.missed} of ${s.total} required attendances missed`}
                    right={<RateMeter rate={s.rate} width={52} />}
                    onClick={() => openMeeting(s.series_id)}
                    label={`Open ${s.title}`}
                  />
                ))}
              </ActionList>
            )}
            <Link to="/dashboards/meetings" className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline">
              Open the meetings dashboard <ArrowRight size={13} aria-hidden />
            </Link>
          </Card>
        );
      }, true),
    },
    {
      id: "attention-biometric",
      title: "Biometric anomalies",
      kicker: "Needs attention now",
      span: 2,
      node: panelOf(state, (d) => {
        const b = d.biometric;
        return (
          <Card className="h-full">
            <CardHeader
              title="Biometric anomalies"
              description="People not seen for a week, and the most missed punches"
              actions={b.attention_total > 0 ? <Label tone="warn">{b.attention_total} not seen</Label> : undefined}
            />
            {b.empty ? (
              <EmptyState icon={Fingerprint} title="No punch data yet" description="Import a punch log to see who is missing and where punches are lost." compact />
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5">
                <div>
                  <div className="text-[12px] font-semibold uppercase tracking-wide text-ink3 mb-2">Not seen in 7 days</div>
                  {b.attention.length === 0 ? (
                    <p className="text-[13px] text-ink2">Everyone expected has been seen.</p>
                  ) : (
                    <ActionList>
                      {b.attention.map((p) => (
                        <ActionRow
                          key={p.emp_code}
                          leading={<Avatar name={p.name} size={26} />}
                          title={p.name}
                          sub={p.department ?? "No department"}
                          right={<span className="text-ink2">{p.days_silent} days</span>}
                          onClick={() => openEmployee(p.emp_code)}
                          label={`Open ${p.name}`}
                        />
                      ))}
                    </ActionList>
                  )}
                </div>
                <div>
                  <div className="text-[12px] font-semibold uppercase tracking-wide text-ink3 mb-2">Most missed punches</div>
                  {b.missed_punch.length === 0 ? (
                    <p className="text-[13px] text-ink2">Every present day has more than one punch.</p>
                  ) : (
                    <ActionList>
                      {b.missed_punch.map((p) => (
                        <ActionRow
                          key={p.emp_code}
                          leading={<Avatar name={p.name} size={26} />}
                          title={p.name}
                          sub={p.department ?? "No department"}
                          right={<span className="text-ink2">{p.count} {p.count === 1 ? "day" : "days"}</span>}
                          onClick={() => openEmployee(p.emp_code)}
                          label={`Open ${p.name}`}
                        />
                      ))}
                    </ActionList>
                  )}
                </div>
              </div>
            )}
            <Link to="/dashboards/biometric" className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline">
              Open the biometric dashboard <ArrowRight size={13} aria-hidden />
            </Link>
          </Card>
        );
      }, true),
    },
  ];
}

export function OverviewDashboard() {
  const { me } = useAuth();
  const [days, setDays] = usePeriod();
  const state = useDashboard<OverviewData>("overview", days);
  const blocks = useOverviewBlocks(state, days);
  const firstName = me?.name.split(" ")[0] ?? "";
  return (
    <div>
      <DashboardHeader
        title="Overview"
        description={`${greeting()}${firstName ? `, ${firstName}` : ""}: where meetings, attendance and compliance stand.`}
        days={days}
        onDays={setDays}
        asOf={state.data?.as_of}
        loading={state.loading}
        onRefresh={state.reload}
      />
      <BlockDeck blocks={blocks} />
    </div>
  );
}
