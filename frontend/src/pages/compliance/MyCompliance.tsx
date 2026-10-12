import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import clsx from "clsx";
import { AlarmClock, CalendarClock, CheckCircle2, ClipboardCheck, Clock, Flame, Hourglass, Info, TriangleAlert } from "lucide-react";
import { api } from "../../lib/api";
import { useApi } from "../../lib/useApi";
import { downloadCsv, type CsvColumn } from "../../lib/csv";
import { fmtDate } from "../../lib/format";
import { useListFilters, type FilterField, type SortDef } from "../../lib/useListFilters";
import { PRIORITY_LABEL, STATUS_LABEL, type Obligation, type ObligationStatus, type Page, type Priority } from "../../lib/compliance";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  FilterBar,
  FilterEmpty,
  PageHeader,
  SegmentedControl,
  Skeleton,
  StatCard,
  StatGridSkeleton,
  type QuickFilter,
} from "../../components/ui";
import { DueLabel, ObligationStatusLabel, ParticipationLabel, PriorityLabel, toastError } from "../../components/compliance/common";

const PAGE_SIZE = 100;

const PRIORITIES = Object.keys(PRIORITY_LABEL) as Priority[];
const STATUSES = Object.keys(STATUS_LABEL) as ObligationStatus[];

type View = "todo" | "review" | "done" | "info" | "all";

const TODO = ["not_started", "in_progress", "rejected"];
const IN_REVIEW = ["submitted", "under_review"];
const DONE = ["completed", "waived", "cancelled"];

const isInfo = (o: Obligation) => o.participation === "informational";
const isTodo = (o: Obligation) => !isInfo(o) && TODO.includes(o.status);
const isReview = (o: Obligation) => !isInfo(o) && IN_REVIEW.includes(o.status);
const isDone = (o: Obligation) => !isInfo(o) && DONE.includes(o.status);
const needsAttention = (o: Obligation) => !isInfo(o) && (o.non_compliant || (o.overdue && !DONE.includes(o.status)));

/** Overdue / non-compliant first, then "changes needed", then the rest; the server's deadline order is kept inside each group. */
function urgency(o: Obligation): number {
  if (DONE.includes(o.status) || isInfo(o)) return 3;
  if (needsAttention(o)) return 0;
  if (o.status === "rejected") return 1;
  return 2;
}

function actionFor(o: Obligation): { label: string; primary: boolean } {
  if (o.can.start) return { label: "Start", primary: true };
  if (o.can.submit) return { label: o.status === "rejected" ? "Fix and resubmit" : "Submit proof", primary: true };
  return { label: "View", primary: false };
}

function Row({ o }: { o: Obligation }) {
  const navigate = useNavigate();
  const action = actionFor(o);
  const finished = DONE.includes(o.status);
  const urgent = needsAttention(o);
  const href = `/compliance/obligations/${o.id}`;
  return (
    <li
      className="relative flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4 px-4 py-3.5 border-b border-line-soft last:border-0"
      style={urgent || o.status === "rejected" ? { background: "color-mix(in srgb, var(--warn-bg) 45%, transparent)" } : undefined}
    >
      {(urgent || o.status === "rejected") && (
        <span className={clsx("absolute left-0 top-0 bottom-0 w-[3px]", urgent ? "bg-crit" : "bg-warn")} aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <Link to={href} className="font-semibold text-ink hover:text-accent hover:underline truncate max-w-full">
            {o.compliance.name}
          </Link>
          <PriorityLabel priority={o.compliance.priority} />
          {o.participation !== "required" && <ParticipationLabel participation={o.participation} />}
        </div>
        <div className="text-xs text-ink2 mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span>{o.compliance.category}</span>
          {o.compliance.action_text && (
            <>
              <span className="text-ink3" aria-hidden>·</span>
              <span className="truncate max-w-[40ch]">{o.compliance.action_text}</span>
            </>
          )}
        </div>
        {o.status === "rejected" && o.status_reason && (
          <p className="mt-1.5 text-[13px] text-warn flex items-start gap-1.5">
            <TriangleAlert size={14} className="mt-0.5 flex-none" aria-hidden />
            <span className="line-clamp-2">{o.status_reason}</span>
          </p>
        )}
      </div>
      <div className="flex items-center justify-between gap-3 sm:justify-end sm:gap-4 flex-wrap">
        <div className="flex flex-col items-start sm:items-end gap-1">
          <DueLabel iso={o.due_at} finished={finished || isInfo(o)} />
          <ObligationStatusLabel o={o} size="sm" />
        </div>
        <Button
          size="sm"
          variant={action.primary ? "primary" : "secondary"}
          onClick={() => navigate(href)}
          aria-label={`${action.label}: ${o.compliance.name}`}
          className="min-w-[88px]"
        >
          {action.label}
        </Button>
      </div>
    </li>
  );
}

function ListSkeleton() {
  return (
    <ul aria-busy="true" aria-label="Loading">
      {Array.from({ length: 5 }).map((_, i) => (
        <li key={i} className="flex items-center gap-4 px-4 py-4 border-b border-line-soft last:border-0">
          <div className="flex-1">
            <Skeleton className="h-4 w-56 max-w-full" />
            <Skeleton className="h-3 w-32 mt-2" />
          </div>
          <Skeleton className="h-8 w-24" />
        </li>
      ))}
    </ul>
  );
}

// The server filters and sorts (GET /compliance/obligations?mine=true). "urgency" is the page's own order:
// open items by deadline with overdue first, so it sends no sort parameter.
const SORTS: SortDef<Obligation>[] = [
  { key: "urgency", label: "Most urgent first", value: () => null, serverKey: null },
  { key: "due", label: "Deadline", value: (o) => o.due_at },
  { key: "priority", label: "Priority", value: (o) => PRIORITIES.indexOf(o.compliance.priority), firstDir: "desc" },
  { key: "name", label: "Name", value: (o) => o.compliance.name.toLowerCase() },
  { key: "status", label: "Status", value: (o) => STATUSES.indexOf(o.status) },
];

const QUICK: QuickFilter[] = [
  { id: "overdue", label: "Overdue", icon: AlarmClock, field: "overdue" },
  { id: "week", label: "Due this week", icon: CalendarClock, field: "due", value: "thisweek" },
  { id: "critical", label: "Critical", icon: Flame, field: "priority", value: "critical" },
  { id: "changes", label: "Changes needed", icon: TriangleAlert, field: "status", value: "rejected" },
];

const EMPTY: Record<View, { title: string; description: string }> = {
  todo: { title: "You're all caught up", description: "Nothing needs your action right now. New compliance tasks will show up here." },
  review: { title: "Nothing is in review", description: "Items you've submitted that are waiting for a reviewer appear here." },
  done: { title: "Nothing completed yet", description: "Items you've finished (or that were waived) will be listed here." },
  info: { title: "Nothing for your information", description: "Notices that don't need any action from you appear here." },
  all: { title: "No compliance items yet", description: "When something is assigned to you it will show up here." },
};

export function MyCompliance() {
  const [params, setParams] = useSearchParams();
  const rawView = params.get("view");
  const view: View = rawView === "review" || rawView === "done" || rawView === "info" || rawView === "all" ? rawView : "todo";
  const setView = (v: View) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (v === "todo") next.delete("view");
        else next.set("view", v);
        return next;
      },
      { replace: true }
    );
  const [extra, setExtra] = useState<Obligation[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);

  const cats = useApi<string[]>("/compliance/categories");
  const fields = useMemo<FilterField<Obligation>[]>(
    () => [
      { type: "multi", key: "priority", label: "Priority", options: PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] })) },
      { type: "multi", key: "status", label: "Status", options: STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] })) },
      { type: "multi", key: "category", label: "Category", options: (cats.data ?? []).filter(Boolean).map((c) => ({ value: c, label: c })) },
      { type: "date", key: "due", label: "Due", presets: ["overdue", "today", "thisweek", "month", "next7", "next30", "custom"] },
      { type: "toggle", key: "overdue", label: "Overdue only", hint: "Still open and past the deadline." },
    ],
    [cats.data]
  );
  const lf = useListFilters<Obligation>({
    id: "my-compliance",
    fields,
    sorts: SORTS,
    defaultSort: { key: "urgency", dir: "asc" },
  });
  const baseParams = new URLSearchParams(lf.serverParams());
  baseParams.set("mine", "true");
  baseParams.set("limit", String(PAGE_SIZE));
  const baseKey = baseParams.toString();

  const { data, error, loading, initialLoading, reload } = useApi<Page<Obligation>>(`/compliance/obligations?${baseKey}&offset=0`);
  // Everything assigned to you, before any filter, for "12 of 40".
  const everything = useApi<Page<Obligation>>("/compliance/obligations?mine=true&limit=1");

  // A fresh first page (new search, filter or sort, refetch) replaces anything "Load more" appended.
  useEffect(() => setExtra([]), [data]);

  const items = useMemo(() => (data ? [...data.items, ...extra] : []), [data, extra]);
  const total = data?.total ?? 0;
  const hasMore = items.length < total;

  async function loadMore() {
    setLoadingMore(true);
    try {
      const next = await api.get<Page<Obligation>>(`/compliance/obligations?${baseKey}&offset=${items.length}`);
      setExtra((e) => [...e, ...next.items]);
    } catch (e) {
      toastError("Couldn't load more", e);
    } finally {
      setLoadingMore(false);
    }
  }

  const counts = useMemo(
    () => ({
      todo: items.filter(isTodo).length,
      review: items.filter(isReview).length,
      done: items.filter(isDone).length,
      info: items.filter(isInfo).length,
      overdue: items.filter(needsAttention).length,
    }),
    [items]
  );

  const urgencySort = lf.sort.key === "urgency";
  const arrange = (list: Obligation[]) => {
    const pick: Record<View, (o: Obligation) => boolean> = {
      todo: isTodo,
      review: isReview,
      done: isDone,
      info: isInfo,
      all: () => true,
    };
    const rows = list.filter(pick[view]);
    // Array.prototype.sort is stable, so the server's order survives inside each group. A sort the person
    // chose is the server's order, so only the default "most urgent" regroups.
    return urgencySort && (view === "todo" || view === "all") ? [...rows].sort((a, b) => urgency(a) - urgency(b)) : rows;
  };
  const visible = useMemo(() => arrange(items), [items, view, urgencySort]); // eslint-disable-line react-hooks/exhaustive-deps

  const informational = view === "all" ? visible.filter(isInfo) : [];
  const main = view === "all" ? visible.filter((o) => !isInfo(o)) : visible;

  const csvColumns: CsvColumn<Obligation>[] = [
    { header: "Compliance", value: (o) => o.compliance.name },
    { header: "Category", value: (o) => o.compliance.category },
    { header: "Priority", value: (o) => PRIORITY_LABEL[o.compliance.priority] },
    { header: "Status", value: (o) => (o.non_compliant ? "Non-compliant" : o.overdue ? "Overdue" : STATUS_LABEL[o.status]) },
    { header: "Due", value: (o) => (o.due_at ? fmtDate(o.due_at) : "") },
    { header: "What to do", value: (o) => o.compliance.action_text },
  ];
  // Every matching item (not just the pages loaded so far), laid out the way the list shows them.
  async function exportAll(): Promise<number> {
    const all: Obligation[] = [];
    for (let offset = 0; offset < 5000; offset += 500) {
      const res = await api.get<Page<Obligation>>(`/compliance/obligations?${baseKey}&limit=500&offset=${offset}`);
      all.push(...res.items);
      if (all.length >= res.total || res.items.length === 0) break;
    }
    const rows = arrange(all);
    downloadCsv("my-compliance", csvColumns, rows);
    return rows.length;
  }

  const tilesLoading = initialLoading;
  const emptyCopy = EMPTY[view];

  return (
    <div>
      <PageHeader title="My compliance" description="Everything that's been assigned to you, what's due next, and what's waiting on someone else." />

      {tilesLoading ? (
        <StatGridSkeleton />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard label="To do" value={String(counts.todo)} icon={ClipboardCheck} tone={counts.todo ? "accent" : "neutral"} foot="Needs your action" onClick={() => setView("todo")} />
          <StatCard label="In review" value={String(counts.review)} icon={Hourglass} foot="Waiting for a reviewer" onClick={() => setView("review")} />
          <StatCard label="Overdue" value={String(counts.overdue)} icon={Clock} tone={counts.overdue ? "crit" : "neutral"} foot={counts.overdue ? "Past the deadline" : "Nothing is late"} onClick={() => setView("todo")} />
          <StatCard label="Done" value={String(counts.done)} icon={CheckCircle2} tone={counts.done ? "good" : "neutral"} foot="Completed or waived" onClick={() => setView("done")} />
        </div>
      )}
      {data && hasMore && (
        <p className="text-xs text-ink3 mt-2">Counts cover the {items.length} of {total} items loaded so far.</p>
      )}

      <div className="mt-6 mb-3 max-w-full overflow-x-auto">
        <SegmentedControl<View>
          aria-label="Filter your compliance items"
          value={view}
          onChange={setView}
          options={[
            { value: "todo", label: `To do${data ? ` (${counts.todo})` : ""}` },
            { value: "review", label: `In review${data ? ` (${counts.review})` : ""}` },
            { value: "done", label: "Done" },
            { value: "info", label: "For information" },
            { value: "all", label: "All" },
          ]}
        />
      </div>

      <FilterBar
        lf={lf}
        noun={["item", "items"]}
        total={everything.data?.total}
        shown={data ? visible.length : undefined}
        quick={QUICK}
        searchPlaceholder="Search by name…"
        onExport={exportAll}
        className="!mb-0"
      />

      <Card padding="none" className="mt-4 overflow-hidden">
        {error && !data ? (
          <ErrorState title="Couldn't load your compliance items" message={error.message} onRetry={reload} />
        ) : initialLoading ? (
          <ListSkeleton />
        ) : visible.length === 0 ? (
          <FilterEmpty lf={lf} icon={view === "info" ? Info : CheckCircle2} emptyTitle={emptyCopy.title} emptyDescription={emptyCopy.description} />
        ) : (
          <div className={clsx("transition-opacity duration-150", loading && "opacity-70")}>
            {main.length > 0 && (
              <ul aria-label={view === "all" ? "Items that need action" : "Compliance items"}>
                {main.map((o) => <Row key={o.id} o={o} />)}
              </ul>
            )}
            {informational.length > 0 && (
              <>
                <div className="px-4 py-2 bg-panel2 border-y border-line text-xs font-semibold text-ink2 flex items-center gap-1.5">
                  <Info size={14} aria-hidden /> For your information (no action needed)
                </div>
                <ul aria-label="For your information">
                  {informational.map((o) => <Row key={o.id} o={o} />)}
                </ul>
              </>
            )}
          </div>
        )}
      </Card>

      {error && data && (
        <p className="text-sm text-crit mt-3" role="alert">
          Couldn't refresh: {error.message}{" "}
          <button className="underline" onClick={reload}>Try again</button>
        </p>
      )}

      {hasMore && (
        <div className="mt-4 flex justify-center">
          <Button onClick={loadMore} loading={loadingMore}>
            Load more ({total - items.length} left)
          </Button>
        </div>
      )}
    </div>
  );
}
