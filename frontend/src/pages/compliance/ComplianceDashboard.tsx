import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AlertTriangle, CalendarClock, CheckCircle2, FileSearch, Hourglass, ListChecks, ShieldAlert, ShieldCheck, Siren, Timer } from "lucide-react";
import { useCompliance } from "../../lib/ComplianceContext";
import { fmtDateTime } from "../../lib/format";
import type { Priority } from "../../lib/compliance";
import type { ComplianceDashboardData, ComplianceGroupRow } from "../../lib/dashboards";
import { Avatar, Button, Card, CardHeader, EmptyState, Label, PageHeader, SegmentedControl } from "../../components/ui";
import { BlockDeck } from "../../components/orbit/BlockDeck";
import type { DeckBlock } from "../../components/orbit/types";
import { CountColumnChart } from "../../components/charts";
import {
  ActionList,
  ActionRow,
  AreaHeading,
  DashboardHeader,
  KpiCard,
  KpiGrid,
  KpiGridSkeleton,
  PanelError,
  RankedBars,
  SeeAll,
  StackedBar,
  countTrendPoints,
  panelOf,
  useDashboard,
  usePeriod,
  type RankedRow,
} from "../../components/dash";
import { DueLabel, PriorityLabel } from "../../components/compliance/common";
import type { Tone } from "../../lib/format";

const HUE = "violet" as const;

function rateToneFor(rate: number | null, target: number): Tone {
  if (rate == null) return "neutral";
  return rate >= target ? "good" : rate >= target - 0.15 ? "warn" : "crit";
}

const ESCALATION_TEXT: Record<string, string> = {
  notify_assignee: "reminded the person",
  notify_manager: "told the manager",
  notify_manager_chain: "told the management chain",
  notify_users: "notified named people",
  notify_reviewers: "nudged the reviewers",
  mark_non_compliant: "marked non-compliant",
  flag_defaulter: "added to the defaulter list",
};

function BreakdownPanel({ d, days }: { d: ComplianceDashboardData; days: number }) {
  const [by, setBy] = useState<"category" | "priority" | "department">("category");
  const target = d.thresholds.target;
  const source: ComplianceGroupRow[] = by === "category" ? d.by_category : by === "priority" ? d.by_priority : d.by_department;
  const rows: RankedRow[] = source.map((g) => ({
    key: g.name,
    label: by === "priority" ? g.name.charAt(0).toUpperCase() + g.name.slice(1) : g.name,
    value: g.rate,
    tone: rateToneFor(g.rate, target),
    delta: g.delta,
    display: g.rate == null ? "no deadline" : undefined,
    sub: (
      <span>
        {g.total ? `${g.completed} of ${g.total} due items completed` : `Nothing fell due in ${days} days`}
        {g.overdue > 0 && <span className="text-crit font-medium"> {"·"} {g.overdue} overdue now</span>}
      </span>
    ),
  }));
  return (
    <Card className="h-full">
      <CardHeader
        title="Where compliance stands"
        description={`Completion rate of items that fell due in the last ${days} days, lowest first. The tick marks the ${Math.round(target * 100)}% target.`}
        actions={
          <SegmentedControl
            size="sm"
            aria-label="Group by"
            value={by}
            onChange={setBy}
            options={[
              { value: "category", label: "Category" },
              { value: "priority", label: "Priority" },
              { value: "department", label: "Department" },
            ]}
          />
        }
      />
      <RankedBars rows={rows} target={target} dense empty={<EmptyState icon={ShieldCheck} title={`Nothing to show by ${by} yet`} description="Groups appear once required items with a deadline exist." compact />} />
    </Card>
  );
}

function AgingPanel({ d }: { d: ComplianceDashboardData }) {
  const navigate = useNavigate();
  const a = d.aging;
  const rows: RankedRow[] = d.overdue_by_compliance.slice(0, 5).map((g) => {
    const max = Math.max(1, ...d.overdue_by_compliance.map((x) => x.overdue));
    return {
      key: g.compliance_id,
      label: g.name,
      value: g.overdue / max,
      display: `${g.overdue} overdue`,
      tone: g.oldest_days > 30 ? "crit" : g.oldest_days > 7 ? "warn" : "accent",
      sub: `Oldest ${g.oldest_days} ${g.oldest_days === 1 ? "day" : "days"} late · ${g.priority} priority`,
      onClick: () => navigate(`/compliance/library/${g.compliance_id}`),
    };
  });
  return (
    <Card className="h-full">
      <CardHeader title="Overdue, by age" description="Open required items past their deadline: how late they are, and which compliances they belong to" />
      {a.total === 0 ? (
        <EmptyState icon={CheckCircle2} title="Nothing is overdue" description="Every open required item is still within its deadline." compact />
      ) : (
        <>
          <StackedBar
            segments={[
              { key: "a", label: "1–7 days late", value: a.d1_7, color: "linear-gradient(90deg, var(--chart-4), #fb923c)" },
              { key: "b", label: "8–30 days late", value: a.d8_30, color: "linear-gradient(90deg, #fb923c, #f43f5e)" },
              { key: "c", label: "Over 30 days", value: a.d30_plus, color: "linear-gradient(90deg, #f43f5e, var(--crit))" },
            ]}
          />
          <div className="mt-5 pt-4 border-t border-line-soft">
            <div className="text-[12px] font-semibold uppercase tracking-wide text-ink3 mb-3">Compliances with the most overdue items</div>
            <RankedBars rows={rows} dense />
          </div>
        </>
      )}
    </Card>
  );
}

function ComingUpPanel({ d }: { d: ComplianceDashboardData }) {
  const [tab, setTab] = useState<"soon" | "reviews" | "escalations">("soon");
  return (
    <Card className="h-full">
      <CardHeader
        title={tab === "soon" ? "Due in the next 7 days" : tab === "reviews" ? "Awaiting your review" : "Recent escalations"}
        description={tab === "soon" ? "Open required items about to fall due, soonest first" : tab === "reviews" ? "Submissions you can approve or reject, oldest first" : "What the escalation rules did in this period"}
        actions={
          <SegmentedControl
            size="sm"
            aria-label="Coming up"
            value={tab}
            onChange={setTab}
            options={[
              { value: "soon", label: "Due soon" },
              { value: "reviews", label: "Reviews" },
              { value: "escalations", label: "Escalations" },
            ]}
          />
        }
      />
      {tab === "soon" &&
        (d.due_soon.length === 0 ? (
          <EmptyState icon={CheckCircle2} title="Nothing falls due in the next 7 days" compact />
        ) : (
          <ActionList>
            {d.due_soon.map((u) => (
              <ActionRow
                key={u.obligation_id}
                leading={<Avatar name={u.user.name} size={28} />}
                title={u.compliance}
                sub={u.user.name}
                right={<DueLabel iso={u.due_at} />}
                to={`/compliance/obligations/${u.obligation_id}`}
              />
            ))}
          </ActionList>
        ))}
      {tab === "reviews" &&
        (d.kpis.review_queue.value == null ? (
          <EmptyState icon={FileSearch} title="You are not a reviewer" description="Reviews you can decide on appear here." compact />
        ) : d.review_items.length === 0 ? (
          <EmptyState icon={CheckCircle2} title="Nothing is waiting for you" compact />
        ) : (
          <>
            <ActionList>
              {d.review_items.map((r) => (
                <ActionRow
                  key={r.obligation_id}
                  leading={<Avatar name={r.user.name} size={28} />}
                  title={r.compliance}
                  sub={r.user.name}
                  right={<span className={r.waiting_days > 7 ? "text-crit font-semibold" : r.waiting_days > 3 ? "text-warn font-semibold" : "text-ink2"}>waiting {r.waiting_days < 1 ? "<1" : Math.floor(r.waiting_days)} d</span>}
                  to={`/compliance/obligations/${r.obligation_id}`}
                />
              ))}
            </ActionList>
            {d.kpis.review_queue.value! > d.review_items.length && <SeeAll to="/compliance/reviews">Open the queue ({d.kpis.review_queue.value})</SeeAll>}
          </>
        ))}
      {tab === "escalations" &&
        (d.escalations.length === 0 ? (
          <EmptyState icon={Siren} title="No escalations in this period" description="Reminders and escalations are listed here as the rules fire." compact />
        ) : (
          <ActionList>
            {d.escalations.map((e, i) => (
              <ActionRow
                key={`${e.obligation_id}-${e.fired_at}-${i}`}
                title={
                  <span>
                    {e.user} <span className="text-ink3 font-normal">{"·"}</span> {e.compliance}
                  </span>
                }
                sub={`${ESCALATION_TEXT[e.action] ?? e.action} · ${fmtDateTime(e.fired_at)}`}
                to={`/compliance/obligations/${e.obligation_id}`}
              />
            ))}
          </ActionList>
        ))}
    </Card>
  );
}

function useBlocks(state: ReturnType<typeof useDashboard<ComplianceDashboardData>>, days: number): DeckBlock[] {
  const navigate = useNavigate();
  const { can } = useCompliance();
  const d = state.data;
  const failed = state.error && !d;
  const kpiBlock = (render: (d: ComplianceDashboardData) => React.ReactNode) => (failed ? <PanelError message={state.error!.message} onRetry={state.reload} /> : !d ? <KpiGridSkeleton /> : render(d));

  return [
    {
      id: "kpis",
      title: "Compliance at a glance",
      kicker: "Headline",
      span: 2,
      gridHeading: <AreaHeading title="Headline numbers" description="Are required items getting done, and on time?" icon={ShieldCheck} hue={HUE} />,
      node: kpiBlock((d) => (
        <KpiGrid>
          <KpiCard kpi={d.kpis.completion} days={days} hue="violet" icon={ShieldCheck} onClick={() => navigate("/compliance/mine")} />
          <KpiCard kpi={d.kpis.on_time} days={days} hue="emerald" icon={CheckCircle2} />
          <KpiCard kpi={d.kpis.overdue} days={days} hue="amber" icon={AlertTriangle} onClick={() => navigate("/compliance/mine")} />
          <KpiCard kpi={d.kpis.due_soon} days={days} hue="sky" icon={CalendarClock} onClick={() => navigate("/compliance/mine")} />
        </KpiGrid>
      )),
    },
    {
      id: "pipeline",
      title: "Reviews and resolution",
      kicker: "Headline",
      span: 2,
      gridHeading: <AreaHeading title="Reviews and resolution" description="How fast evidence is reviewed and work is finished, and who is non-compliant" icon={ListChecks} hue="indigo" />,
      node: kpiBlock((d) => (
        <KpiGrid>
          <KpiCard kpi={d.kpis.review_queue} days={days} hue="indigo" icon={ListChecks} onClick={can("submission", "approve") ? () => navigate("/compliance/reviews") : undefined} />
          <KpiCard kpi={d.kpis.review_turnaround} days={days} hue="cyan" icon={Timer} />
          <KpiCard kpi={d.kpis.time_to_complete} days={days} hue="teal" icon={Hourglass} />
          <KpiCard kpi={d.kpis.non_compliant} days={days} hue="pink" icon={ShieldAlert} onClick={can("report", "view") ? () => navigate("/compliance/scoreboard") : undefined} />
        </KpiGrid>
      )),
    },
    {
      id: "completions",
      title: "Completions over time",
      kicker: "Trend",
      span: 2,
      gridHeading: <AreaHeading title="Trends and breakdowns" description="How completions move, how late the late items are, and who is behind" icon={ShieldCheck} hue="violet" />,
      node: panelOf(
        state,
        (d) => (
          <Card className="h-full">
            <CardHeader
              title="Completions over time"
              description={`Required items completed per ${d.completions.daily ? "day" : "7-day block"}: ${d.completions.total} in the last ${days} days, ${d.completions.previous_total} in the ${days} before`}
            />
            <CountColumnChart points={countTrendPoints(d.completions.points, d.completions.daily, d.period)} name={`Last ${days} days`} previousName={`Previous ${days} days`} />
          </Card>
        ),
        true
      ),
    },
    { id: "aging", title: "Overdue, by age", kicker: "Overdue", node: panelOf(state, (d) => <AgingPanel d={d} />, true) },
    { id: "breakdown", title: "Where compliance stands", kicker: "Breakdown", node: panelOf(state, (d) => <BreakdownPanel d={d} days={days} />, true) },
    {
      id: "overdue-items",
      title: "Overdue items",
      kicker: "Act",
      gridHeading: <AreaHeading title="Where to act" description="The items and people behind the numbers" icon={AlertTriangle} hue="pink" />,
      node: panelOf(
        state,
        (d) => (
          <Card className="h-full">
            <CardHeader title="Most overdue items" description="Highest priority first, then longest overdue" />
            {d.overdue_items.length === 0 ? (
              <EmptyState icon={CheckCircle2} title="Nothing is overdue" compact />
            ) : (
              <>
                <ActionList>
                  {d.overdue_items.map((o) => (
                    <ActionRow
                      key={o.obligation_id}
                      leading={<Avatar name={o.user.name} size={28} />}
                      title={o.compliance}
                      sub={o.user.name}
                      right={
                        <>
                          <PriorityLabel priority={o.priority as Priority} />
                          <span className={o.days_overdue > 30 ? "text-crit font-semibold" : o.days_overdue > 7 ? "text-warn font-semibold" : "text-ink2"}>{o.days_overdue < 1 ? "<1" : o.days_overdue} d late</span>
                        </>
                      }
                      to={`/compliance/obligations/${o.obligation_id}`}
                    />
                  ))}
                </ActionList>
                {d.overdue_total > d.overdue_items.length && <p className="text-[12px] text-ink3 mt-3">Showing {d.overdue_items.length} of {d.overdue_total} overdue items.</p>}
                <SeeAll to="/compliance/mine">All compliance items</SeeAll>
              </>
            )}
          </Card>
        ),
        true
      ),
    },
    { id: "coming-up", title: "Due soon, reviews and escalations", kicker: "Act", node: panelOf(state, (d) => <ComingUpPanel d={d} />, true) },
    {
      id: "defaulters",
      title: "Repeat defaulters",
      kicker: "People",
      span: 2,
      node: panelOf(state, (d) => {
        const k = d.kpis.repeat_defaulters;
        return (
          <Card className="h-full">
            <CardHeader
              title="Who keeps missing things"
              description={`People ranked by incidents in the last ${days} days (late, overdue, non-compliant or flagged, weighted by priority). 3+ incidents makes a repeat defaulter.`}
              actions={k.value != null ? <Label tone={k.value ? "crit" : "good"}>{k.value} repeat {k.value === 1 ? "defaulter" : "defaulters"}</Label> : undefined}
            />
            {k.value == null ? (
              <EmptyState icon={ShieldAlert} title="The scoreboard is not available to you" description="Ask a compliance administrator for report access." compact />
            ) : d.defaulters.length === 0 ? (
              <EmptyState icon={ShieldCheck} title="Nobody has incidents in this period" compact />
            ) : (
              <>
                <ActionList>
                  {d.defaulters.map((p) => (
                    <ActionRow
                      key={p.email}
                      leading={<Avatar name={p.name} size={28} />}
                      title={
                        <span className="flex items-center gap-2">
                          <span className="truncate">{p.name}</span>
                          {p.repeat && <Label tone="crit" size="sm">Repeat</Label>}
                        </span>
                      }
                      sub={p.department ?? "No department"}
                      right={
                        <>
                          {p.non_compliant > 0 && <span className="text-crit font-semibold">{p.non_compliant} non-compliant</span>}
                          {p.overdue > 0 && <span className="text-warn font-semibold">{p.overdue} overdue</span>}
                          {p.late > 0 && <span className="text-ink2">{p.late} late</span>}
                          <span className="text-ink3">{p.incidents} {p.incidents === 1 ? "incident" : "incidents"}</span>
                        </>
                      }
                      to="/compliance/scoreboard"
                    />
                  ))}
                </ActionList>
                <SeeAll to="/compliance/scoreboard">Open the scoreboard</SeeAll>
              </>
            )}
          </Card>
        );
      }),
    },
  ];
}

export function ComplianceDashboard() {
  const { can, me } = useCompliance();
  const [days, setDays] = usePeriod();
  const allowed = can("dashboard", "view");
  const state = useDashboard<ComplianceDashboardData>("compliance", days, allowed);
  const blocks = useBlocks(state, days);
  const firstName = me?.user?.name.split(" ")[0] ?? "";
  const perms = me?.permissions.submission?.view ?? [];
  const scoped = perms.includes("org") || me?.is_super ? "across the whole organization" : perms.some((s) => s === "subtree" || s === "direct_reports" || s === "team") ? "for your team" : "for you";

  if (me && !allowed) {
    return (
      <>
        <PageHeader title="Compliance" />
        <EmptyState icon={ShieldAlert} title="You don't have access to this dashboard" description="Ask a compliance administrator to grant you access." />
      </>
    );
  }

  return (
    <div>
      <DashboardHeader
        title="General compliance"
        description={`${firstName ? `${firstName}, here` : "Here"} is where compliance stands ${scoped}.`}
        days={days}
        onDays={setDays}
        asOf={state.data?.as_of}
        loading={state.loading}
        onRefresh={state.reload}
        actions={
          can("compliance", "create") && (
            <Link to="/compliance/library/new">
              <Button variant="primary">New compliance</Button>
            </Link>
          )
        }
      />
      <BlockDeck blocks={blocks} />
    </div>
  );
}
