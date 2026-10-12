import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import clsx from "clsx";
import {
  AlarmClock,
  Bell,
  BellRing,
  CalendarClock,
  CheckCheck,
  CheckCircle2,
  ClipboardList,
  Eye,
  Mail,
  MessageSquareWarning,
  ShieldOff,
  Siren,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { api } from "../../lib/api";
import { useApi } from "../../lib/useApi";
import { useCompliance } from "../../lib/ComplianceContext";
import { fmtDate, fmtDateTime, fmtTime, getDisplayTimeZone, parseInstant } from "../../lib/format";
import type { NotificationItem } from "../../lib/compliance";
import { Button, Card, EmptyState, ErrorState, IconButton, PageHeader, SegmentedControl, Skeleton } from "../../components/ui";
import { toastError } from "../../components/compliance/common";

interface Inbox {
  unread: number;
  items: NotificationItem[];
}

type Filter = "all" | "unread";

const KIND: Record<string, { icon: LucideIcon; tone: string; label: string }> = {
  assigned: { icon: ClipboardList, tone: "text-accent", label: "Assigned" },
  reminder: { icon: AlarmClock, tone: "text-warn", label: "Reminder" },
  escalation: { icon: Siren, tone: "text-crit", label: "Escalation" },
  review_needed: { icon: Eye, tone: "text-accent", label: "Review needed" },
  approved: { icon: CheckCircle2, tone: "text-good", label: "Approved" },
  rejected: { icon: MessageSquareWarning, tone: "text-warn", label: "Changes needed" },
  completed: { icon: CheckCircle2, tone: "text-good", label: "Completed" },
  non_compliant: { icon: TriangleAlert, tone: "text-crit", label: "Non-compliant" },
  waived: { icon: ShieldOff, tone: "text-ink2", label: "Waived" },
  deadline_changed: { icon: CalendarClock, tone: "text-accent", label: "Deadline changed" },
  review_overdue: { icon: BellRing, tone: "text-crit", label: "Review overdue" },
  message: { icon: Mail, tone: "text-accent", label: "Message" },
};
const FALLBACK = { icon: Bell, tone: "text-ink2", label: "Notification" };

/** "2026-10-05" for the instant, as seen in the organization's time zone. */
function dayKey(iso: string): string {
  const d = parseInstant(iso);
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: getDisplayTimeZone(), year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

function when(iso: string, today: string): string {
  return dayKey(iso) === today ? fmtTime(iso) : fmtDate(iso);
}

function Item({ n, unread, today, onOpen, onMarkRead }: { n: NotificationItem; unread: boolean; today: string; onOpen: (n: NotificationItem) => void; onMarkRead: (n: NotificationItem) => void }) {
  const k = KIND[n.kind] ?? FALLBACK;
  const Icon = k.icon;
  return (
    <li className={clsx("flex items-stretch border-b border-line-soft last:border-0", unread && "bg-accent-soft")}>
      <button
        type="button"
        onClick={() => onOpen(n)}
        className="flex-1 min-w-0 flex items-start gap-3 px-4 py-3 text-left hover:bg-panel2 focus-visible:bg-panel2 focus-visible:outline-none focus-visible:shadow-[inset_2px_0_0_var(--accent)] transition-colors"
        aria-label={`${unread ? "Unread: " : ""}${k.label}. ${n.title}`}
      >
        <span className={clsx("mt-0.5 flex-none w-8 h-8 rounded-full bg-panel border border-line flex items-center justify-center", k.tone)}>
          <Icon size={16} aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-start justify-between gap-3">
            <span className={clsx("text-sm text-ink", unread ? "font-semibold" : "font-medium")}>{n.title}</span>
            <time dateTime={n.created_at} title={fmtDateTime(n.created_at)} className="text-xs text-ink3 whitespace-nowrap tabular mt-0.5">
              {when(n.created_at, today)}
            </time>
          </span>
          {n.body && <span className={clsx("block text-[13px] mt-0.5 break-words line-clamp-3", unread ? "text-ink" : "text-ink2")}>{n.body}</span>}
        </span>
        {unread && <span className="mt-2 w-2 h-2 rounded-full bg-accent flex-none" aria-hidden />}
      </button>
      {unread && (
        <div className="flex items-center pr-2">
          <IconButton icon={CheckCheck} label="Mark as read" size="sm" onClick={() => onMarkRead(n)} />
        </div>
      )}
    </li>
  );
}

function ListSkeleton() {
  return (
    <ul aria-busy="true" aria-label="Loading">
      {Array.from({ length: 6 }).map((_, i) => (
        <li key={i} className="flex gap-3 px-4 py-3.5 border-b border-line-soft last:border-0">
          <Skeleton className="w-8 h-8 rounded-full flex-none" />
          <div className="flex-1">
            <Skeleton className="h-4 w-64 max-w-full" />
            <Skeleton className="h-3 w-80 max-w-full mt-2" />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function Notifications() {
  const navigate = useNavigate();
  const { reload: reloadMe } = useCompliance();
  const [filter, setFilter] = useState<Filter>("all");
  const [readIds, setReadIds] = useState<Set<string>>(new Set());
  const [markingAll, setMarkingAll] = useState(false);
  const { data, error, initialLoading, reload } = useApi<Inbox>(`/compliance/notifications?limit=100${filter === "unread" ? "&unread=true" : ""}`);

  const isUnread = (n: NotificationItem) => !n.read && !readIds.has(n.id);
  const items = data?.items ?? [];
  const locallyRead = items.filter((n) => !n.read && readIds.has(n.id)).length;
  const unreadCount = Math.max(0, (data?.unread ?? 0) - locallyRead);

  const groups = useMemo(() => {
    const today = dayKey(new Date().toISOString());
    return {
      today,
      recent: items.filter((n) => dayKey(n.created_at) === today),
      earlier: items.filter((n) => dayKey(n.created_at) !== today),
    };
  }, [items]);

  async function markRead(n: NotificationItem): Promise<boolean> {
    if (!isUnread(n)) return true;
    setReadIds((s) => new Set(s).add(n.id));
    try {
      await api.post(`/compliance/notifications/${n.id}/read`);
      void reloadMe();
      return true;
    } catch (e) {
      setReadIds((s) => {
        const next = new Set(s);
        next.delete(n.id);
        return next;
      });
      toastError("Couldn't mark it as read", e);
      return false;
    }
  }

  async function open(n: NotificationItem) {
    await markRead(n);
    // Links from the server are app routes such as /compliance/obligations/<id>.
    if (n.link) navigate(n.link.startsWith("/") ? n.link : `/${n.link}`);
  }

  async function markAll() {
    setMarkingAll(true);
    try {
      await api.post("/compliance/notifications/read-all");
      setReadIds(new Set());
      reload();
      void reloadMe();
    } catch (e) {
      toastError("Couldn't mark everything as read", e);
    } finally {
      setMarkingAll(false);
    }
  }

  function section(title: string, list: NotificationItem[]) {
    if (list.length === 0) return null;
    return (
      <section aria-label={title}>
        <h2 className="px-4 py-2 bg-panel2 border-y border-line first:border-t-0 text-xs font-semibold text-ink2">{title}</h2>
        <ul>
          {list.map((n) => (
            <Item key={n.id} n={n} unread={isUnread(n)} today={groups.today} onOpen={open} onMarkRead={markRead} />
          ))}
        </ul>
      </section>
    );
  }

  return (
    <div>
      <PageHeader
        title="Notifications"
        description={data ? (unreadCount > 0 ? `${unreadCount} unread` : "You're all caught up.") : "Reminders, decisions and anything that needs you."}
        actions={
          <>
            <SegmentedControl<Filter>
              aria-label="Show notifications"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "All" },
                { value: "unread", label: "Unread" },
              ]}
            />
            <Button leadingIcon={CheckCheck} onClick={markAll} loading={markingAll} disabled={unreadCount === 0}>
              Mark all read
            </Button>
          </>
        }
      />

      <Card padding="none" className="overflow-hidden">
        {error && !data ? (
          <ErrorState title="Couldn't load your notifications" message={error.message} onRetry={reload} />
        ) : initialLoading ? (
          <ListSkeleton />
        ) : items.length === 0 ? (
          <EmptyState
            icon={Bell}
            title={filter === "unread" ? "No unread notifications" : "No notifications yet"}
            description={filter === "unread" ? "Everything has been read." : "When something is assigned to you, reviewed or due soon, you'll hear about it here."}
            action={filter === "unread" ? <Button size="sm" onClick={() => setFilter("all")}>Show all</Button> : undefined}
          />
        ) : (
          <>
            {section("Today", groups.recent)}
            {section("Earlier", groups.earlier)}
          </>
        )}
      </Card>

      {error && data && (
        <p className="text-sm text-crit mt-3" role="alert">
          Couldn't refresh: {error.message} <button className="underline" onClick={reload}>Try again</button>
        </p>
      )}
    </div>
  );
}
