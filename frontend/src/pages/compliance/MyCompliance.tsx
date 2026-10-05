import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import clsx from "clsx";
import { CheckCircle2, ClipboardCheck, Clock, Hourglass, Info, TriangleAlert } from "lucide-react";
import { api } from "../../lib/api";
import { useApi } from "../../lib/useApi";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import type { Obligation, Page } from "../../lib/compliance";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  SearchInput,
  SegmentedControl,
  Skeleton,
  StatCard,
  StatGridSkeleton,
} from "../../components/ui";
import { DueLabel, ObligationStatusLabel, ParticipationLabel, PriorityLabel, toastError } from "../../components/compliance/common";

const PAGE_SIZE = 100;

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

const EMPTY: Record<View, { title: string; description: string }> = {
  todo: { title: "You're all caught up", description: "Nothing needs your action right now. New compliance tasks will show up here." },
  review: { title: "Nothing is in review", description: "Items you've submitted that are waiting for a reviewer appear here." },
  done: { title: "Nothing completed yet", description: "Items you've finished (or that were waived) will be listed here." },
  info: { title: "Nothing for your information", description: "Notices that don't need any action from you appear here." },
  all: { title: "No compliance items yet", description: "When something is assigned to you it will show up here." },
};

export function MyCompliance() {
  const [view, setView] = useState<View>("todo");
  const [search, setSearch] = useState("");
  const q = useDebouncedValue(search.trim(), 250);
  const [extra, setExtra] = useState<Obligation[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);

  const params = new URLSearchParams({ mine: "true", limit: String(PAGE_SIZE), offset: "0" });
  if (q) params.set("q", q);
  const { data, error, loading, initialLoading, reload } = useApi<Page<Obligation>>(`/compliance/obligations?${params.toString()}`);

  // A fresh first page (new search, refetch) replaces anything "Load more" appended.
  useEffect(() => setExtra([]), [data]);

  const items = useMemo(() => (data ? [...data.items, ...extra] : []), [data, extra]);
  const total = data?.total ?? 0;
  const hasMore = items.length < total;

  async function loadMore() {
    setLoadingMore(true);
    try {
      const p = new URLSearchParams({ mine: "true", limit: String(PAGE_SIZE), offset: String(items.length) });
      if (q) p.set("q", q);
      const next = await api.get<Page<Obligation>>(`/compliance/obligations?${p.toString()}`);
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

  const visible = useMemo(() => {
    const pick: Record<View, (o: Obligation) => boolean> = {
      todo: isTodo,
      review: isReview,
      done: isDone,
      info: isInfo,
      all: () => true,
    };
    const rows = items.filter(pick[view]);
    // Array.prototype.sort is stable, so the server's deadline order survives inside each group.
    return view === "todo" || view === "all" ? [...rows].sort((a, b) => urgency(a) - urgency(b)) : rows;
  }, [items, view]);

  const informational = view === "all" ? visible.filter(isInfo) : [];
  const main = view === "all" ? visible.filter((o) => !isInfo(o)) : visible;

  const tilesLoading = initialLoading;
  const emptyCopy = q ? { title: "No matches", description: `Nothing matches "${q}". Try a different search.` } : EMPTY[view];

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

      <div className="mt-6 flex flex-wrap items-center gap-3 justify-between">
        <div className="max-w-full overflow-x-auto">
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
        <SearchInput value={search} onChange={setSearch} placeholder="Search by name…" aria-label="Search your compliance items" className="w-full sm:w-64" />
      </div>

      <Card padding="none" className="mt-4 overflow-hidden">
        {error && !data ? (
          <ErrorState title="Couldn't load your compliance items" message={error.message} onRetry={reload} />
        ) : initialLoading ? (
          <ListSkeleton />
        ) : visible.length === 0 ? (
          <EmptyState icon={view === "info" ? Info : CheckCircle2} title={emptyCopy.title} description={emptyCopy.description} />
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
