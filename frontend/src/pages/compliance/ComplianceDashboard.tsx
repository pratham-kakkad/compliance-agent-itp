import { useId, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock3,
  FileSearch,
  Gauge,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Siren,
  Users2,
} from "lucide-react";
import { useApi } from "../../lib/useApi";
import { useCssVars } from "../../lib/useCssVar";
import { fmtDay, fmtDateTime } from "../../lib/format";
import { useCompliance } from "../../lib/ComplianceContext";
import type { Breakdown, DashboardData } from "../../lib/compliance";
import { Avatar, Button, Card, CardHeader, EmptyState, ErrorState, IconButton, PageHeader, ProgressBar, SegmentedControl, Skeleton, StatCard, StatGridSkeleton } from "../../components/ui";
import { BlockDeck } from "../../components/orbit/BlockDeck";
import type { DeckBlock } from "../../components/orbit/types";
import { DueLabel, PersonCell } from "../../components/compliance/common";

const pct = (n: number) => `${Math.round(n)}%`;
const count = (n: number) => String(Math.round(n));

function PanelSkeleton({ tall }: { tall?: boolean }) {
  return (
    <Card className="h-full">
      <Skeleton className="h-4 w-40 mb-4" />
      <Skeleton className={tall ? "h-[200px] w-full" : "h-[140px] w-full"} />
    </Card>
  );
}

function DailyTrend({ data }: { data: DashboardData["trend"] }) {
  const c = useCssVars(["accent", "border-soft", "text-faint", "text-soft", "surface"]);
  const gid = useId().replace(/:/g, "");
  const total = data.reduce((a, d) => a + d.completed, 0);
  if (total === 0) {
    return <EmptyState icon={Gauge} title="No completions yet" description="Completed items will chart here, day by day, for the last 30 days." compact />;
  }
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data.map((d) => ({ day: fmtDay(d.date), completed: d.completed }))} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <defs>
          <linearGradient id={`dt${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={c.accent} stopOpacity={0.3} />
            <stop offset="100%" stopColor={c.accent} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={c["border-soft"]} vertical={false} />
        <XAxis dataKey="day" tick={{ fill: c["text-faint"], fontSize: 11 }} tickLine={false} axisLine={false} interval={4} padding={{ left: 24, right: 12 }} />
        <YAxis allowDecimals={false} tick={{ fill: c["text-faint"], fontSize: 11 }} tickLine={false} axisLine={false} width={40} />
        <Tooltip
          cursor={{ stroke: c["text-faint"], strokeDasharray: 3 }}
          content={({ active, payload, label }) =>
            active && payload?.length ? (
              <div className="rounded-lg border border-line bg-panel shadow-md px-3 py-2 text-[13px]">
                <div className="text-ink2 text-xs mb-0.5">{label}</div>
                <span className="font-semibold text-ink tabular">{payload[0].value} completed</span>
              </div>
            ) : null
          }
        />
        <Area type="monotone" dataKey="completed" stroke={c.accent} strokeWidth={2} fill={`url(#dt${gid})`} animationDuration={900} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function GroupBars({ rows, empty }: { rows: Breakdown[]; empty: string }) {
  if (!rows.length) return <EmptyState icon={Users2} title={empty} compact />;
  return (
    <ul className="flex flex-col gap-3.5">
      {rows.map((r) => (
        <li key={r.name}>
          <div className="flex items-baseline justify-between gap-3 mb-1.5">
            <span className="text-sm font-semibold text-ink truncate">{r.name}</span>
            <span className="text-[13px] text-ink2 tabular whitespace-nowrap">
              {r.completed}/{r.total} · <span className="font-semibold text-ink">{r.percent}%</span>
              {r.overdue > 0 && <span className="text-crit font-semibold"> · {r.overdue} overdue</span>}
            </span>
          </div>
          <ProgressBar value={r.percent} tone={r.percent >= 90 ? "good" : r.percent >= 60 ? "accent" : "warn"} />
        </li>
      ))}
    </ul>
  );
}

function GroupsPanel({ data }: { data: DashboardData }) {
  const [by, setBy] = useState<"department" | "team" | "category">("department");
  const rows = by === "department" ? data.by_department : by === "team" ? data.by_team : data.by_category;
  return (
    <Card className="h-full">
      <CardHeader
        title="Where compliance stands"
        description="Required items completed, by group"
        actions={
          <SegmentedControl
            size="sm"
            value={by}
            onChange={setBy}
            aria-label="Group by"
            options={[
              { value: "department", label: "Department" },
              { value: "team", label: "Team" },
              { value: "category", label: "Category" },
            ]}
          />
        }
      />
      <GroupBars rows={rows} empty={`Nothing to show by ${by} yet`} />
    </Card>
  );
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

/** The dashboard's panels, as blocks for the grid / orbit ring. Each carries its own loading and error state. */
function useBlocks(data: DashboardData | null, error: Error | null, reload: () => void, loading: boolean): DeckBlock[] {
  const { can } = useCompliance();
  const fail = error && !data;
  const wait = !fail && (loading || !data) && !data;
  const panel = (render: (d: DashboardData) => React.ReactNode, tall = true) =>
    fail ? (
      <Card className="h-full">
        <ErrorState message={error!.message} onRetry={reload} />
      </Card>
    ) : wait || !data ? (
      <PanelSkeleton tall={tall} />
    ) : (
      render(data)
    );

  const k = data?.kpis;
  return [
    {
      id: "kpis",
      title: "Compliance at a glance",
      kicker: "Overview",
      span: 2,
      node: fail ? (
        <Card className="h-full">
          <ErrorState message={error!.message} onRetry={reload} />
        </Card>
      ) : wait || !k ? (
        <StatGridSkeleton count={6} />
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          <StatCard label="Compliance rate" icon={ShieldCheck} value={pct(k.compliance_percent)} tone={k.compliance_percent >= 90 ? "good" : k.compliance_percent >= 60 ? "warn" : "crit"} animateValue={k.compliance_percent} formatValue={pct} foot={`${k.completed} of ${k.obligations} required items done`} />
          <StatCard label="Active compliances" icon={Gauge} value={String(k.active_compliances)} animateValue={k.active_compliances} formatValue={count} foot={`${k.total_compliances} in total`} />
          <StatCard label="Pending" icon={Clock3} value={String(k.pending)} animateValue={k.pending} formatValue={count} foot="Not yet submitted" />
          <StatCard label="In review" icon={FileSearch} value={String(k.in_review)} tone={k.in_review ? "accent" : "neutral"} animateValue={k.in_review} formatValue={count} foot="Waiting for a reviewer" />
          <StatCard label="Overdue" icon={AlertTriangle} value={String(k.overdue)} tone={k.overdue ? "crit" : "good"} animateValue={k.overdue} formatValue={count} foot="Past the deadline" />
          <StatCard label="Non-compliant people" icon={ShieldAlert} value={String(k.non_compliant_users)} tone={k.non_compliant_users ? "crit" : "good"} animateValue={k.non_compliant_users} formatValue={count} foot={`${k.non_compliant} open items marked`} />
        </div>
      ),
    },
    {
      id: "trend",
      title: "Completions, last 30 days",
      kicker: "Trend",
      node: panel((d) => (
        <Card className="h-full">
          <CardHeader title="Completions" description="Required items completed per day, last 30 days" />
          <DailyTrend data={d.trend} />
        </Card>
      )),
    },
    { id: "groups", title: "By department, team and category", kicker: "Breakdown", node: panel((d) => <GroupsPanel data={d} />) },
    {
      id: "upcoming",
      title: "Upcoming deadlines",
      kicker: "Next 14 days",
      node: panel((d) => (
        <Card className="h-full">
          <CardHeader title="Upcoming deadlines" description="Open required items due in the next 14 days" />
          {d.upcoming.length === 0 ? (
            <EmptyState icon={CheckCircle2} title="Nothing due soon" description="No open items fall due in the next two weeks." compact />
          ) : (
            <ul className="divide-y divide-line-soft">
              {d.upcoming.map((u) => (
                <li key={u.obligation_id} className="py-2.5 first:pt-0 last:pb-0">
                  <Link to={`/compliance/obligations/${u.obligation_id}`} className="flex items-center gap-3 group">
                    <Avatar name={u.user.name} size={26} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-ink truncate group-hover:text-accent">{u.compliance}</div>
                      <div className="text-xs text-ink2 truncate">{u.user.name}</div>
                    </div>
                    <DueLabel iso={u.due_at} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )),
    },
    {
      id: "attention",
      title: "People who need attention",
      kicker: "Attention",
      node: panel((d) => (
        <Card className="h-full">
          <CardHeader
            title="People who need attention"
            description="Overdue or non-compliant items"
            actions={can("report", "view") ? <Link to="/compliance/scoreboard" className="text-[13px] text-accent hover:underline">Scoreboard</Link> : undefined}
          />
          {d.attention.length === 0 ? (
            <EmptyState icon={ShieldCheck} title="Everyone is on track" description="Nobody has overdue or non-compliant items." compact />
          ) : (
            <ul className="divide-y divide-line-soft">
              {d.attention.map((p) => (
                <li key={p.email} className="py-2.5 first:pt-0 last:pb-0 flex items-center gap-3">
                  <PersonCell person={{ email: p.email, name: p.name, title: "", department: null }} size={28} />
                  <span className="ml-auto flex items-center gap-3 text-[13px] tabular">
                    {p.non_compliant > 0 && <span className="text-crit font-semibold">{p.non_compliant} non-compliant</span>}
                    {p.overdue > 0 && <span className="text-warn font-semibold">{p.overdue} overdue</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )),
    },
    {
      id: "reviews",
      title: "Evidence awaiting review",
      kicker: "Reviews",
      node: panel((d) => (
        <Card className="h-full">
          <CardHeader
            title="Evidence awaiting review"
            description={d.review_queue.total ? `${d.review_queue.total} waiting for you` : "Submissions you can approve or reject"}
            actions={d.review_queue.total ? <Link to="/compliance/reviews" className="inline-flex items-center gap-1 text-[13px] text-accent hover:underline">Open queue <ArrowRight size={13} /></Link> : undefined}
          />
          {d.review_queue.items.length === 0 ? (
            <EmptyState icon={CheckCircle2} title="Nothing is waiting for you" compact />
          ) : (
            <ul className="divide-y divide-line-soft">
              {d.review_queue.items.map((o) => (
                <li key={o.id} className="py-2.5 first:pt-0 last:pb-0">
                  <Link to={`/compliance/obligations/${o.id}`} className="flex items-center gap-3 group">
                    <PersonCell person={o.user} size={26} />
                    <span className="ml-auto text-[13px] text-ink2 truncate max-w-[45%] group-hover:text-accent">{o.compliance.name}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )),
    },
    {
      id: "escalations",
      title: "Recent escalations",
      kicker: "Last 7 days",
      node: panel((d) => (
        <Card className="h-full">
          <CardHeader title="Recent escalations" description="What the rules did in the last 7 days" />
          {d.escalations.length === 0 ? (
            <EmptyState icon={Siren} title="No escalations" description="Reminders and escalations will be listed here as they fire." compact />
          ) : (
            <ul className="divide-y divide-line-soft">
              {d.escalations.map((e, i) => (
                <li key={`${e.obligation_id}-${e.rule}-${i}`} className="py-2.5 first:pt-0 last:pb-0">
                  <Link to={`/compliance/obligations/${e.obligation_id}`} className="block group">
                    <div className="text-sm text-ink group-hover:text-accent">
                      <span className="font-semibold">{e.user}</span> · {e.compliance}
                    </div>
                    <div className="text-xs text-ink2">
                      {ESCALATION_TEXT[e.action] ?? e.action} · {fmtDateTime(e.fired_at)}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )),
    },
  ];
}

export function ComplianceDashboard() {
  const { can, me } = useCompliance();
  const { data, error, loading, reload } = useApi<DashboardData>(can("dashboard", "view") ? "/compliance/dashboard" : null);
  const blocks = useBlocks(data, error, reload, loading);
  const firstName = me?.user?.name.split(" ")[0] ?? "";
  const scoped = useMemo(() => {
    const perms = me?.permissions.submission?.view ?? [];
    if (perms.includes("org")) return "across the whole organization";
    if (perms.some((s) => s === "subtree" || s === "direct_reports" || s === "team")) return "for your team";
    return "for you";
  }, [me]);

  if (me && !can("dashboard", "view")) {
    return (
      <>
        <PageHeader title="Compliance" />
        <EmptyState icon={ShieldAlert} title="You don't have access to this dashboard" description="Ask a compliance administrator to grant you access." />
      </>
    );
  }

  return (
    <div>
      <PageHeader
        title="Compliance overview"
        description={`${firstName ? `${firstName}, here` : "Here"} is where compliance stands ${scoped}.`}
        actions={
          <>
            {can("compliance", "create") && (
              <Link to="/compliance/library/new">
                <Button variant="primary">New compliance</Button>
              </Link>
            )}
            <IconButton icon={RefreshCw} label="Refresh data" variant="secondary" onClick={reload} />
          </>
        }
      />
      <BlockDeck blocks={blocks} />
    </div>
  );
}
