import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CalendarX2, ChevronDown, List, Users } from "lucide-react";
import clsx from "clsx";
import { useApi } from "../lib/useApi";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import { fmtDate } from "../lib/format";
import { duration, ease } from "../lib/motion";
import { useAuth } from "../auth/AuthContext";
import type { MeetingListItem, MeetingListResponse } from "../types";
import {
  Avatar,
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  Label,
  PageHeader,
  RateMeter,
  SearchInput,
  SegmentedControl,
  Select,
  TableSkeleton,
  type Column,
} from "../components/ui";
import { useMeetingPanel } from "../components/MeetingPanel";

type View = "list" | "organizer";

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

function OrganizerGroup({ email, items, onOpen }: { email: string; items: MeetingListItem[]; onOpen: (m: MeetingListItem) => void }) {
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
              defaultSort={{ key: "rate", dir: "asc" }}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}

export function Meetings() {
  const openMeeting = useMeetingPanel();
  const [search, setSearch] = useState("");
  const [recurrence, setRecurrence] = useState("");
  const [view, setView] = useState<View>("list");
  const q = useDebouncedValue(search, 250);

  const params = new URLSearchParams();
  if (q) params.set("search", q);
  if (recurrence) params.set("recurrence", recurrence);
  if (view === "organizer") params.set("group_by", "organizer");
  const { data, error, loading, initialLoading, reload } = useApi<MeetingListResponse>(`/meetings?${params.toString()}`);
  const columns = useColumns(true);

  // The response shape must match the current view; while the other view loads, show the skeleton.
  const matchesView = data && (view === "organizer" ? data.grouped_by === "organizer" : data.grouped_by !== "organizer");
  const groups = data?.grouped_by === "organizer" ? Object.entries(data.groups) : [];
  const count = data ? (data.grouped_by === "organizer" ? groups.reduce((n, [, g]) => n + g.length, 0) : data.items.length) : 0;
  const filtered = Boolean(q || recurrence);
  const clear = () => {
    setSearch("");
    setRecurrence("");
  };

  const empty = (
    <EmptyState
      icon={CalendarX2}
      title={filtered ? "No meetings match your filters" : "No meetings yet"}
      description={filtered ? "Try a different search or clear the filters." : "Meetings you or your reports are required at will appear here."}
      action={filtered && <Button onClick={clear}>Clear filters</Button>}
    />
  );

  return (
    <div>
      <PageHeader title="Meetings" description="Every series you or your reports are expected at" />

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <SearchInput value={search} onChange={setSearch} placeholder="Search meetings…" className="w-full sm:w-72" />
        <Select value={recurrence} onChange={(e) => setRecurrence(e.target.value)} aria-label="Meeting type">
          <option value="">All types</option>
          <option value="once">One-time</option>
          <option value="daily">Recurring</option>
        </Select>
        <SegmentedControl
          aria-label="View"
          value={view}
          onChange={setView}
          options={[
            { value: "list", label: "List", icon: List },
            { value: "organizer", label: "By organizer", icon: Users },
          ]}
        />
        {data && (
          <span className="ml-auto text-[13px] text-ink2 tabular" aria-live="polite">
            {count} meeting{count === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {error && !data ? (
        <Card>
          <ErrorState message={error.message} onRetry={reload} />
        </Card>
      ) : initialLoading || !matchesView ? (
        <Card padding="none" className="overflow-hidden">
          <TableSkeleton rows={6} columns={4} />
        </Card>
      ) : data.grouped_by === "organizer" ? (
        groups.length ? (
          <div className={clsx("flex flex-col gap-4 transition-opacity", loading && "opacity-60")}>
            {groups.map(([org, items]) => (
              <OrganizerGroup key={org} email={org} items={items} onOpen={(m) => openMeeting(m.series_id)} />
            ))}
          </div>
        ) : (
          <Card>{empty}</Card>
        )
      ) : (
        <Card padding="none" className="overflow-hidden">
          <DataTable
            columns={columns}
            rows={data.items}
            getRowKey={(m) => m.series_id}
            onRowClick={(m) => openMeeting(m.series_id)}
            rowLabel={(m) => `Open ${m.title}`}
            defaultSort={{ key: "rate", dir: "asc" }}
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
