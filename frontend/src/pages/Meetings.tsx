import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { CalendarX2, ChevronDown, Gauge, List, Repeat, Users } from "lucide-react";
import clsx from "clsx";
import { useApi } from "../lib/useApi";
import { fmtDate } from "../lib/format";
import { duration, ease } from "../lib/motion";
import { downloadCsv, type CsvColumn } from "../lib/csv";
import { useListFilters, type FilterField, type SortDef } from "../lib/useListFilters";
import { useAuth } from "../auth/AuthContext";
import type { MeetingListItem, MeetingListResponse } from "../types";
import {
  Avatar,
  Card,
  DataTable,
  ErrorState,
  FilterBar,
  FilterEmpty,
  Label,
  PageHeader,
  RateMeter,
  SegmentedControl,
  TableSkeleton,
  type Column,
  type QuickFilter,
} from "../components/ui";
import { useMeetingPanel } from "../components/MeetingPanel";

type View = "list" | "organizer";
type Sorting = { sort: { key: string; dir: "asc" | "desc" }; onSortChange: (s: { key: string; dir: "asc" | "desc" }) => void };

/** Below this attendance rate a meeting counts as at risk (the app's "red" band). */
const AT_RISK = 0.75;
const isRecurring = (m: MeetingListItem) => m.recurrence !== "once";

function useColumns(showOrganizer: boolean): Column<MeetingListItem>[] {
  const { displayName } = useAuth();
  return useMemo(() => {
    const cols: Column<MeetingListItem>[] = [
      {
        key: "title",
        header: "Meeting",
        sortValue: (m) => m.title.toLowerCase(),
        cell: (m) => (
          <div className="min-w-0">
            <div className="font-semibold text-ink truncate">{m.title}</div>
            <div className="text-xs text-ink2 mt-0.5 flex items-center gap-1.5">
              {m.recurrence === "once" ? "One-time" : "Recurring"}
              <span className="text-ink3" aria-hidden>·</span>
              {m.required_total} required slots
            </div>
          </div>
        ),
      },
    ];
    if (showOrganizer) {
      cols.push({
        key: "organizer",
        header: "Organizer",
        hideBelow: "md",
        sortValue: (m) => displayName(m.organizer_email).toLowerCase(),
        cell: (m) => (
          <div className="flex items-center gap-2 min-w-0">
            <Avatar name={displayName(m.organizer_email)} size={20} />
            <span className="text-ink2 truncate">{displayName(m.organizer_email)}</span>
          </div>
        ),
      });
    }
    cols.push(
      {
        key: "last",
        header: "Last occurrence",
        hideBelow: "sm",
        sortFirst: "desc",
        sortValue: (m) => new Date(m.last_occurrence).getTime(),
        cell: (m) => <span className="font-mono text-xs text-ink2 whitespace-nowrap">{fmtDate(m.last_occurrence)}</span>,
      },
      {
        key: "rate",
        header: "Attendance",
        align: "right",
        width: "150px",
        sortValue: (m) => m.attendance_rate,
        cell: (m) => <RateMeter rate={m.attendance_rate} />,
      }
    );
    return cols;
  }, [showOrganizer, displayName]);
}

function OrganizerGroup({
  email,
  items,
  onOpen,
  sorting,
}: {
  email: string;
  items: MeetingListItem[];
  onOpen: (m: MeetingListItem) => void;
  sorting: Sorting;
}) {
  const { displayName } = useAuth();
  const [open, setOpen] = useState(true);
  const columns = useColumns(false);
  const name = displayName(email);
  return (
    <Card padding="none" className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={clsx("w-full flex items-center gap-3 px-4 h-12 text-left hover:bg-panel2 transition-colors", open && "border-b border-line")}
      >
        <Avatar name={name} size={24} />
        <span className="text-sm font-semibold text-ink truncate">{name}</span>
        <Label size="sm">{items.length} meeting{items.length === 1 ? "" : "s"}</Label>
        <motion.span animate={{ rotate: open ? 0 : -90 }} transition={{ duration: duration.base, ease: ease.standard }} className="ml-auto text-ink2 flex">
          <ChevronDown size={16} />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: duration.medium, ease: ease.standard }}
            className="overflow-hidden"
          >
            <DataTable
              columns={columns}
              rows={items}
              getRowKey={(m) => m.series_id}
              onRowClick={onOpen}
              rowLabel={(m) => `Open ${m.title}`}
              {...sorting}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}

const QUICK: QuickFilter[] = [
  { id: "risk", label: "At risk (under 75%)", icon: Gauge, field: "at_risk" },
  { id: "recurring", label: "Recurring", icon: Repeat, field: "type", value: "recurring" },
  { id: "recent", label: "Held in the last 7 days", field: "last", value: "last7" },
];

export function Meetings() {
  const openMeeting = useMeetingPanel();
  const { displayName } = useAuth();
  const [params, setParams] = useSearchParams();
  const view: View = params.get("view") === "organizer" ? "organizer" : "list";
  const setView = (v: View) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (v === "organizer") next.set("view", "organizer");
        else next.delete("view");
        return next;
      },
      { replace: true }
    );

  const { data, error, loading, initialLoading, reload } = useApi<MeetingListResponse>("/meetings");
  const items = data?.items;
  const columns = useColumns(true);

  const fields = useMemo<FilterField<MeetingListItem>[]>(() => {
    const byOrg = new Map<string, number>();
    for (const m of items ?? []) byOrg.set(m.organizer_email, (byOrg.get(m.organizer_email) ?? 0) + 1);
    const recurring = (items ?? []).filter(isRecurring).length;
    return [
      {
        type: "multi",
        key: "type",
        label: "Type",
        options: [
          { value: "recurring", label: "Recurring", count: recurring },
          { value: "once", label: "One-time", count: (items?.length ?? 0) - recurring },
        ],
        get: (m) => (isRecurring(m) ? "recurring" : "once"),
      },
      {
        type: "multi",
        key: "organizer",
        label: "Organizer",
        options: Array.from(byOrg, ([email, count]) => ({ value: email, label: displayName(email), count })).sort((a, b) => a.label.localeCompare(b.label)),
        get: (m) => m.organizer_email,
      },
      { type: "date", key: "last", label: "Last occurrence", presets: ["today", "last7", "last30", "month", "custom"], get: (m) => m.last_occurrence },
      {
        type: "range",
        key: "rate",
        label: "Attendance rate",
        suffix: "%",
        min: 0,
        max: 100,
        get: (m) => (m.attendance_rate == null ? null : Math.round(m.attendance_rate * 100)),
      },
      { type: "range", key: "slots", label: "Required slots", min: 0, hint: "How many required attendances the series has had.", get: (m) => m.required_total },
      {
        type: "toggle",
        key: "at_risk",
        label: "At risk only",
        hint: "Attendance rate under 75%.",
        chip: (() => "At risk (under 75%)") as never,
        test: (m) => m.attendance_rate != null && m.attendance_rate < AT_RISK,
      },
    ];
  }, [items, displayName]);

  const sorts = useMemo<SortDef<MeetingListItem>[]>(
    () => [
      { key: "rate", label: "Attendance rate", value: (m) => m.attendance_rate },
      { key: "title", label: "Title", value: (m) => m.title.toLowerCase() },
      { key: "organizer", label: "Organizer", value: (m) => displayName(m.organizer_email).toLowerCase() },
      { key: "last", label: "Last occurrence", value: (m) => new Date(m.last_occurrence).getTime(), firstDir: "desc" },
      { key: "slots", label: "Required slots", value: (m) => m.required_total, firstDir: "desc" },
    ],
    [displayName]
  );

  const lf = useListFilters<MeetingListItem>({
    id: "meetings",
    fields,
    sorts,
    defaultSort: { key: "rate", dir: "asc" },
    tieBreak: [{ key: "title", dir: "asc" }],
    searchText: (m) => `${m.title} ${displayName(m.organizer_email)} ${m.organizer_email}`,
  });

  const rows = useMemo(() => (items ? lf.apply(items) : []), [items, lf.apply]);
  const groups = useMemo(() => {
    const g = new Map<string, MeetingListItem[]>();
    for (const m of rows) g.set(m.organizer_email, [...(g.get(m.organizer_email) ?? []), m]);
    return Array.from(g).sort((a, b) => displayName(a[0]).localeCompare(displayName(b[0])));
  }, [rows, displayName]);

  const sorting: Sorting = { sort: lf.sort, onSortChange: lf.setSort };

  const exportColumns: CsvColumn<MeetingListItem>[] = [
    { header: "Meeting", value: (m) => m.title },
    { header: "Organizer", value: (m) => displayName(m.organizer_email) },
    { header: "Organizer email", value: (m) => m.organizer_email },
    { header: "Type", value: (m) => (isRecurring(m) ? "Recurring" : "One-time") },
    { header: "Required slots", value: (m) => m.required_total },
    { header: "Attendance rate (%)", value: (m) => (m.attendance_rate == null ? "" : Math.round(m.attendance_rate * 100)) },
    { header: "Last occurrence", value: (m) => m.last_occurrence },
  ];

  const empty = (
    <FilterEmpty
      lf={lf}
      icon={CalendarX2}
      emptyTitle="No meetings yet"
      emptyDescription="Meetings you or your reports are required at will appear here."
    />
  );

  return (
    <div>
      <PageHeader title="Meetings" description="Every series you or your reports are expected at" />

      <FilterBar
        lf={lf}
        noun={["meeting", "meetings"]}
        total={items?.length}
        shown={items ? rows.length : undefined}
        quick={QUICK}
        searchPlaceholder="Search title or organizer…"
        onExport={() => downloadCsv("meetings", exportColumns, rows)}
        trailing={
          <SegmentedControl
            aria-label="View"
            value={view}
            onChange={setView}
            options={[
              { value: "list", label: "List", icon: List },
              { value: "organizer", label: "By organizer", icon: Users },
            ]}
          />
        }
      />

      {error && !data ? (
        <Card>
          <ErrorState message={error.message} onRetry={reload} />
        </Card>
      ) : initialLoading || !items ? (
        <Card padding="none" className="overflow-hidden">
          <TableSkeleton rows={6} columns={4} />
        </Card>
      ) : view === "organizer" ? (
        groups.length ? (
          <div className={clsx("flex flex-col gap-4 transition-opacity", loading && "opacity-60")}>
            {groups.map(([org, list]) => (
              <OrganizerGroup key={org} email={org} items={list} onOpen={(m) => openMeeting(m.series_id)} sorting={sorting} />
            ))}
          </div>
        ) : (
          <Card>{empty}</Card>
        )
      ) : (
        <Card padding="none" className="overflow-hidden">
          <DataTable
            columns={columns}
            rows={rows}
            getRowKey={(m) => m.series_id}
            onRowClick={(m) => openMeeting(m.series_id)}
            rowLabel={(m) => `Open ${m.title}`}
            {...sorting}
            dim={loading}
            rank
            empty={empty}
            caption="Meetings"
          />
        </Card>
      )}
    </div>
  );
}
