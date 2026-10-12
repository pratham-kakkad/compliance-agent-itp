import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Clock, ExternalLink, Flame, Inbox, MessageSquareWarning, RotateCcw } from "lucide-react";
import { useApi } from "../../lib/useApi";
import { downloadCsv, type CsvColumn } from "../../lib/csv";
import { useListFilters, type FilterField, type SortDef } from "../../lib/useListFilters";
import { fmtDateTime } from "../../lib/format";
import { duration, ease } from "../../lib/motion";
import { PRIORITY_LABEL, type Obligation, type Page, type Priority, type Submission } from "../../lib/compliance";
import { Button, Card, EmptyState, ErrorState, FilterBar, FilterEmpty, Label, PageHeader, Skeleton, type QuickFilter } from "../../components/ui";
import { DueLabel, PersonCell, PriorityLabel } from "../../components/compliance/common";
import { EvidenceList, latestSubmission, useReviewActions } from "../../components/compliance/evidence";
import { EmailButton } from "../../components/compliance/email/EmailButton";

/** The submission a reviewer is being asked to look at: the newest one still waiting. */
function pendingOf(o: Obligation): Submission | null {
  const s = latestSubmission(o.submissions);
  return s && (s.status === "submitted" || s.status === "under_review") ? s : null;
}

type ReviewRow = { o: Obligation; sub: Submission };

const PRIORITIES = Object.keys(PRIORITY_LABEL) as Priority[];
const DAY_MS = 86_400_000;
const waitedDays = (r: ReviewRow) => (Date.now() - new Date(r.sub.submitted_at).getTime()) / DAY_MS;
const submitter = (r: ReviewRow) => r.o.user?.name ?? "Unknown";

const SORTS: SortDef<ReviewRow>[] = [
  { key: "waiting", label: "Waiting longest", value: (r) => new Date(r.sub.submitted_at).getTime() },
  { key: "priority", label: "Priority", value: (r) => PRIORITIES.indexOf(r.o.compliance.priority), firstDir: "desc" },
  { key: "deadline", label: "Deadline", value: (r) => (r.o.due_at ? new Date(r.o.due_at).getTime() : null) },
  { key: "person", label: "Submitted by", value: (r) => submitter(r).toLowerCase() },
  { key: "name", label: "Compliance", value: (r) => r.o.compliance.name.toLowerCase() },
];

const QUICK: QuickFilter[] = [
  { id: "late", label: "Late submissions", icon: Clock, field: "late" },
  { id: "critical", label: "Critical", icon: Flame, field: "priority", value: "critical" },
  { id: "week", label: "Waiting over 3 days", field: "waiting", value: 3 },
  { id: "resub", label: "Resubmissions", icon: RotateCcw, field: "resub" },
];

const CSV_COLUMNS: CsvColumn<ReviewRow>[] = [
  { header: "Compliance", value: (r) => r.o.compliance.name },
  { header: "Category", value: (r) => r.o.compliance.category },
  { header: "Priority", value: (r) => PRIORITY_LABEL[r.o.compliance.priority] },
  { header: "Submitted by", value: (r) => submitter(r) },
  { header: "Submitted at", value: (r) => r.sub.submitted_at },
  { header: "Days waiting", value: (r) => Math.floor(waitedDays(r)) },
  { header: "Late", value: (r) => (r.sub.late ? "Yes" : "No") },
  { header: "Version", value: (r) => r.sub.version },
  { header: "Deadline", value: (r) => r.o.due_at },
];

function ReviewCard({
  o,
  sub,
  onDecided,
  onRemove,
}: {
  o: Obligation;
  sub: Submission;
  onDecided: () => void;
  onRemove: (id: string) => void;
}) {
  const { approve, requestChanges } = useReviewActions();
  const [approving, setApproving] = useState(false);
  const href = `/compliance/obligations/${o.id}`;
  const reqs = o.instructions?.evidence_requirements;
  const resubmission = sub.version > 1;

  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0, transition: { duration: duration.base, ease: ease.decelerate } }}
      exit={{ opacity: 0, height: 0, marginTop: 0, transition: { duration: duration.base } }}
      className="list-none overflow-hidden"
    >
      <Card as="article" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex flex-col gap-2">
            <PersonCell person={o.user} size={28} showTitle />
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              <Link to={href} className="font-semibold text-ink hover:text-accent hover:underline">{o.compliance.name}</Link>
              <PriorityLabel priority={o.compliance.priority} />
              {sub.late && <Label tone="crit" size="sm">Late</Label>}
              {resubmission && <Label tone="neutral" size="sm">Resubmission (v{sub.version})</Label>}
            </div>
            <p className="text-[13px] text-ink2">
              Submitted {fmtDateTime(sub.submitted_at)}
              {o.due_at && (
                <>
                  <span className="text-ink3" aria-hidden> · </span>
                  <span className="whitespace-nowrap">Deadline <DueLabel iso={o.due_at} finished /></span>
                </>
              )}
            </p>
          </div>
          <Link to={href} className="inline-flex items-center gap-1 text-[13px] text-accent hover:underline whitespace-nowrap">
            Open full item <ExternalLink size={13} aria-hidden />
          </Link>
        </div>

        <div className="rounded-md border border-line bg-panel2 p-3">
          <EvidenceList items={sub.items} requirements={reqs} showSameFileNote compact />
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            leadingIcon={Check}
            loading={approving}
            onClick={async () => {
              setApproving(true);
              const ok = await approve(sub, o.user?.name);
              if (ok) {
                onRemove(o.id);
                onDecided();
              } else setApproving(false);
            }}
            aria-label={`Approve ${o.compliance.name} from ${o.user?.name ?? "this person"}`}
          >
            Approve
          </Button>
          <Button
            variant="danger"
            leadingIcon={MessageSquareWarning}
            disabled={approving}
            onClick={() =>
              requestChanges(
                sub,
                () => {
                  onRemove(o.id);
                  onDecided();
                },
                o.user?.name
              )
            }
            aria-label={`Request changes on ${o.compliance.name} from ${o.user?.name ?? "this person"}`}
          >
            Request changes
          </Button>
          {o.user && (
            <EmailButton
              label="Email submitter"
              variant="ghost"
              disabled={approving}
              target={() => ({
                recipients: { obligation_id: o.id },
                heading: `Email ${o.user?.name ?? "the submitter"}`,
                subtitle: `About ${o.compliance.name}. Replies go to you.`,
                defaultKind: "request",
              })}
            />
          )}
        </div>
      </Card>
    </motion.li>
  );
}

function QueueSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="bg-panel border border-line rounded-lg p-4">
          <div className="flex items-center gap-3">
            <Skeleton className="h-7 w-7 rounded-full" />
            <Skeleton className="h-4 w-40" />
          </div>
          <Skeleton className="h-4 w-64 max-w-full mt-3" />
          <Skeleton className="h-16 w-full mt-3" />
          <div className="flex gap-2 mt-3">
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-8 w-36" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function Reviews() {
  const { data, error, initialLoading, reload } = useApi<Page<Obligation>>("/compliance/reviews");
  // Decided items disappear straight away; the refetch then confirms what's really left.
  const [removed, setRemoved] = useState<Set<string>>(new Set());

  useEffect(() => setRemoved(new Set()), [data]);

  const pending = useMemo(
    () =>
      (data?.items ?? [])
        .filter((o) => !removed.has(o.id))
        .map((o) => ({ o, sub: pendingOf(o) }))
        .filter((r): r is ReviewRow => r.sub !== null),
    [data, removed]
  );

  const fields = useMemo<FilterField<ReviewRow>[]>(() => {
    const count = (key: (r: ReviewRow) => string | undefined) => {
      const m = new Map<string, number>();
      for (const r of pending) {
        const k = key(r);
        if (k) m.set(k, (m.get(k) ?? 0) + 1);
      }
      return m;
    };
    const people = new Map<string, { name: string; n: number }>();
    for (const r of pending) {
      const e = r.o.user?.email;
      if (e) people.set(e, { name: submitter(r), n: (people.get(e)?.n ?? 0) + 1 });
    }
    const categories = count((r) => r.o.compliance.category);
    return [
      {
        type: "multi",
        key: "priority",
        label: "Priority",
        options: PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p], count: pending.filter((r) => r.o.compliance.priority === p).length })),
        get: (r) => r.o.compliance.priority,
      },
      {
        type: "multi",
        key: "person",
        label: "Submitted by",
        options: Array.from(people, ([value, v]) => ({ value, label: v.name, count: v.n })).sort((a, b) => a.label.localeCompare(b.label)),
        get: (r) => r.o.user?.email,
      },
      {
        type: "multi",
        key: "category",
        label: "Category",
        options: Array.from(categories, ([value, n]) => ({ value, label: value, count: n })).sort((a, b) => a.label.localeCompare(b.label)),
        get: (r) => r.o.compliance.category,
      },
      { type: "date", key: "submitted", label: "Submitted", presets: ["today", "last7", "last30", "month", "custom"], get: (r) => r.sub.submitted_at },
      { type: "date", key: "deadline", label: "Deadline", presets: ["overdue", "today", "thisweek", "month", "next7", "custom"], get: (r) => r.o.due_at },
      {
        type: "number",
        key: "waiting",
        label: "Waiting longer than",
        suffix: "days",
        chip: ((n: number) => `Waiting over ${n} day${n === 1 ? "" : "s"}`) as never,
        test: (r, n) => waitedDays(r) > n,
      },
      { type: "toggle", key: "late", label: "Late submissions only", hint: "Submitted after the deadline.", test: (r) => r.sub.late },
      { type: "toggle", key: "resub", label: "Resubmissions only", hint: "Sent back before and submitted again.", test: (r) => r.sub.version > 1 },
    ];
  }, [pending]);

  const lf = useListFilters<ReviewRow>({
    id: "reviews",
    fields,
    sorts: SORTS,
    // Oldest first: the person who has waited longest is at the top.
    defaultSort: { key: "waiting", dir: "asc" },
    tieBreak: [{ key: "name", dir: "asc" }],
    searchText: (r) => `${r.o.compliance.name} ${submitter(r)} ${r.o.user?.email ?? ""} ${r.o.compliance.category}`,
  });
  const rows = useMemo(() => lf.apply(pending), [pending, lf.apply]);

  const remove = (id: string) => setRemoved((s) => new Set(s).add(id));
  const refetch = () => {
    reload();
  };

  // A 403 means the viewer doesn't review anything: say so instead of showing a generic failure.
  const forbidden = error && /don't review|permission/i.test(error.message);

  return (
    <div>
      <PageHeader
        title="Reviews"
        description={
          data && pending.length > 0
            ? `${pending.length} ${pending.length === 1 ? "submission is" : "submissions are"} waiting for you.`
            : "Submissions that are waiting for you to approve or send back."
        }
      />

      {!(error && !data) && !initialLoading && pending.length > 0 && (
        <FilterBar
          lf={lf}
          noun={["submission", "submissions"]}
          total={pending.length}
          shown={rows.length}
          quick={QUICK}
          searchPlaceholder="Search compliance or person…"
          onExport={() => downloadCsv("review-queue", CSV_COLUMNS, rows)}
        />
      )}

      {error && !data ? (
        <Card>
          {forbidden ? (
            <EmptyState icon={Inbox} title="You don't review submissions" description="This page is for people who approve compliance evidence." />
          ) : (
            <ErrorState title="Couldn't load the review queue" message={error.message} onRetry={reload} />
          )}
        </Card>
      ) : initialLoading ? (
        <QueueSkeleton />
      ) : pending.length === 0 ? (
        <Card>
          <EmptyState icon={Check} title="Nothing is waiting for you" description="When someone submits evidence for you to review, it will show up here." />
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <FilterEmpty lf={lf} icon={Check} emptyTitle="Nothing is waiting for you" />
        </Card>
      ) : (
        <ul className="flex flex-col gap-4 p-0" aria-label="Submissions waiting for review">
          <AnimatePresence initial={false}>
            {rows.map(({ o, sub }) => (
              <ReviewCard key={o.id} o={o} sub={sub} onRemove={remove} onDecided={refetch} />
            ))}
          </AnimatePresence>
        </ul>
      )}

      {data && data.total > (data.items?.length ?? 0) && (
        <p className="text-xs text-ink3 mt-3">Showing {data.items.length} of {data.total}. The rest appear as you clear these.</p>
      )}
      {error && data && (
        <p className="text-sm text-crit mt-3" role="alert">
          Couldn't refresh: {error.message} <button className="underline" onClick={reload}>Try again</button>
        </p>
      )}
    </div>
  );
}
