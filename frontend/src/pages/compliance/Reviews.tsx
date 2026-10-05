import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ExternalLink, Inbox, MessageSquareWarning } from "lucide-react";
import { useApi } from "../../lib/useApi";
import { fmtDateTime } from "../../lib/format";
import { duration, ease } from "../../lib/motion";
import type { Obligation, Page, Submission } from "../../lib/compliance";
import { Button, Card, EmptyState, ErrorState, Label, PageHeader, Skeleton } from "../../components/ui";
import { DueLabel, PersonCell, PriorityLabel } from "../../components/compliance/common";
import { EvidenceList, latestSubmission, useReviewActions } from "../../components/compliance/evidence";

/** The submission a reviewer is being asked to look at: the newest one still waiting. */
function pendingOf(o: Obligation): Submission | null {
  const s = latestSubmission(o.submissions);
  return s && (s.status === "submitted" || s.status === "under_review") ? s : null;
}

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

  const rows = useMemo(() => {
    const list = (data?.items ?? [])
      .filter((o) => !removed.has(o.id))
      .map((o) => ({ o, sub: pendingOf(o) }))
      .filter((r): r is { o: Obligation; sub: Submission } => r.sub !== null);
    // Oldest first: the person who has waited longest is at the top.
    return list.sort((a, b) => new Date(a.sub.submitted_at).getTime() - new Date(b.sub.submitted_at).getTime());
  }, [data, removed]);

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
          data && rows.length > 0
            ? `${rows.length} ${rows.length === 1 ? "submission is" : "submissions are"} waiting for you, oldest first.`
            : "Submissions that are waiting for you to approve or send back."
        }
      />

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
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState icon={Check} title="Nothing is waiting for you" description="When someone submits evidence for you to review, it will show up here." />
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
