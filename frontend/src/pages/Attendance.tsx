import { useMemo } from "react";
import { Building2, CalendarClock, EyeOff, Fingerprint, Gauge, UserCheck, UserSearch } from "lucide-react";
import { useApi } from "../lib/useApi";
import { downloadCsv, type CsvColumn } from "../lib/csv";
import { useListFilters, type FilterField, type Option, type SortDef } from "../lib/useListFilters";
import { fmtDay, rateTone } from "../lib/format";
import type { AttendanceDashboardPayload, AttendanceEmployeeRow, AttendanceListResponse } from "../types";
import {
  Avatar,
  Card,
  DataTable,
  ErrorState,
  FilterBar,
  FilterEmpty,
  PageHeader,
  RateMeter,
  StatCard,
  StatGridSkeleton,
  TableSkeleton,
  type Column,
  type QuickFilter,
} from "../components/ui";
import { useAttendanceEmployeeModal } from "../components/AttendanceEmployeeModal";

type Row = AttendanceEmployeeRow;

const UNASSIGNED = "Unassigned";

function optionsOf(values: (string | null)[]): Option[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v || UNASSIGNED, (counts.get(v || UNASSIGNED) ?? 0) + 1);
  return Array.from(counts, ([value, count]) => ({ value, label: value, count })).sort((a, b) => a.label.localeCompare(b.label));
}

const COLUMNS: Column<Row>[] = [
  {
    key: "name",
    header: "Employee",
    sortValue: (i) => i.name.toLowerCase(),
    cell: (i) => (
      <div className="flex items-center gap-2.5 min-w-0">
        <Avatar name={i.name} size={28} />
        <div className="min-w-0">
          <div className="font-semibold text-ink truncate">{i.name}</div>
          <div className="text-xs text-ink3 font-mono">{i.emp_code}</div>
        </div>
      </div>
    ),
  },
  { key: "company", header: "Company", hideBelow: "md", sortValue: (i) => i.company, cell: (i) => <span className="text-ink2">{i.company || "—"}</span> },
  { key: "department", header: "Department", hideBelow: "sm", sortValue: (i) => i.department, cell: (i) => <span className="text-ink2">{i.department || "—"}</span> },
  {
    key: "days",
    header: "Days tracked",
    align: "right",
    hideBelow: "sm",
    sortFirst: "desc",
    sortValue: (i) => i.days_tracked,
    cell: (i) => <span className="font-mono text-[13px] text-ink2">{i.days_tracked}</span>,
  },
  {
    key: "rate",
    header: "Attendance (30 days)",
    align: "right",
    hideBelow: "md",
    width: "180px",
    sortFirst: "desc",
    sortValue: (i) => i.rate,
    cell: (i) => <RateMeter rate={i.rate} />,
  },
  {
    key: "last_seen",
    header: "Last seen",
    align: "right",
    width: "150px",
    sortFirst: "desc",
    sortValue: (i) => i.last_seen,
    cell: (i) => <span className="font-mono text-[13px] text-ink2">{i.last_seen ? fmtDay(i.last_seen) : "—"}</span>,
  },
];

// The backend sorts and filters (GET /attendance), so these keys are its `sort` values.
const SORTS: SortDef<Row>[] = [
  { key: "name", label: "Name", value: (i) => i.name.toLowerCase() },
  { key: "company", label: "Company", value: (i) => i.company },
  { key: "department", label: "Department", value: (i) => i.department },
  { key: "days", label: "Days tracked", value: (i) => i.days_tracked, firstDir: "desc" },
  { key: "rate", label: "Attendance rate", value: (i) => i.rate, firstDir: "desc" },
  { key: "last_seen", label: "Last seen", value: (i) => i.last_seen, firstDir: "desc" },
];

const CSV_COLUMNS: CsvColumn<Row>[] = [
  { header: "Employee code", value: (i) => i.emp_code },
  { header: "Name", value: (i) => i.name },
  { header: "Company", value: (i) => i.company },
  { header: "Department", value: (i) => i.department },
  { header: "Days tracked", value: (i) => i.days_tracked },
  { header: "Attendance rate, last 30 working days (%)", value: (i) => (i.rate == null ? "" : Math.round(i.rate * 100)) },
  { header: "Present on latest working day", value: (i) => (i.present_latest ? "Yes" : "No") },
  { header: "Last seen", value: (i) => i.last_seen },
];

const QUICK: QuickFilter[] = [
  { id: "present", label: "Present on latest day", icon: UserCheck, field: "present", value: "true" },
  { id: "quiet", label: "Not seen in 7+ days", icon: EyeOff, field: "not_seen", value: 7 },
  { id: "recent", label: "Seen in the last 30 days", icon: CalendarClock, field: "last_seen", value: "last30" },
  { id: "low", label: "Attendance 75% or less", icon: Gauge, field: "rate", value: { max: 75 } },
];

export function Attendance() {
  const openEmployee = useAttendanceEmployeeModal();

  const summary = useApi<AttendanceDashboardPayload>("/attendance/dashboard");
  // Unfiltered list: the total, and the choices the filters offer.
  const all = useApi<AttendanceListResponse>("/attendance");

  const fields = useMemo<FilterField<Row>[]>(() => {
    const items = (all.data?.items ?? []) as Row[];
    return [
      { type: "multi", key: "department", label: "Department", icon: Building2, options: optionsOf(items.map((i) => i.department)) },
      { type: "multi", key: "company", label: "Company", icon: Building2, options: optionsOf(items.map((i) => i.company)) },
      { type: "date", key: "last_seen", label: "Last seen", presets: ["today", "last7", "last30", "month", "custom"], param: "last_seen" },
      { type: "range", key: "rate", label: "Attendance rate", suffix: "%", min: 0, max: 100, paramScale: 0.01, hint: "Share of the last 30 working days the person was present." },
      { type: "range", key: "days", label: "Days tracked", suffix: "days", min: 0 },
      {
        type: "select",
        key: "present",
        label: "Latest working day",
        anyLabel: "Anyone",
        param: "present_latest",
        options: [
          { value: "true", label: "Present" },
          { value: "false", label: "Not present" },
        ],
        chip: ((v: string) => (v === "true" ? "Present on latest day" : "Not present on latest day")) as never,
      },
      {
        type: "number",
        key: "not_seen",
        label: "Not seen in",
        suffix: "days",
        param: "not_seen_days",
        max: 3650,
        hint: "No punches in the last N days of data, or never seen.",
        chip: ((n: number) => `Not seen in ${n}+ days`) as never,
      },
    ];
  }, [all.data]);

  const lf = useListFilters<Row>({
    id: "attendance-employees",
    fields,
    sorts: SORTS,
    defaultSort: { key: "last_seen", dir: "desc" },
    serverSearchParam: "search",
  });

  const params = lf.serverParams();
  const list = useApi<AttendanceListResponse>(`/attendance?${params.toString()}`);
  const rows = (list.data?.items ?? []) as Row[];

  const s = summary.data?.summary;
  const ins = summary.data?.insights;
  const total = all.data?.items.length;

  return (
    <div>
      <PageHeader title="Employees" description="Biometric punch-log attendance across every tracked employee" />

      <div className="mb-6">
        {summary.error && !summary.data ? null : !s ? (
          <StatGridSkeleton />
        ) : !ins ? null : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <StatCard label="Employees tracked" icon={Fingerprint} value={String(s.employee_count)} animateValue={s.employee_count} foot="On biometric devices" />
            <StatCard
              label={ins.latest_day ? `Present on ${fmtDay(ins.latest_day)}` : "Present"}
              icon={UserCheck}
              value={ins.present_rate == null ? "—" : `${Math.round(ins.present_rate * 100)}%`}
              tone={rateTone(ins.present_rate)}
              foot={ins.latest_day ? `${ins.present_latest} of ${ins.headcount} · ${ins.quiet_count} not seen in ${ins.quiet_days} days` : "Import a punch log to see this"}
            />
          </div>
        )}
      </div>

      <FilterBar
        lf={lf}
        noun={["employee", "employees"]}
        total={total}
        shown={list.data ? rows.length : undefined}
        quick={QUICK}
        searchPlaceholder="Search name or employee code…"
        onExport={() => downloadCsv("employees", CSV_COLUMNS, rows)}
      />

      <Card padding="none" className="overflow-hidden">
        {list.error && !list.data ? (
          <ErrorState message={list.error.message} onRetry={list.reload} />
        ) : !list.data ? (
          <TableSkeleton rows={6} columns={5} />
        ) : (
          <DataTable
            columns={COLUMNS}
            rows={rows}
            getRowKey={(i) => i.emp_code}
            onRowClick={(i) => openEmployee(i.emp_code)}
            rowLabel={(i) => `Open ${i.name}`}
            sort={lf.sort}
            onSortChange={lf.setSort}
            dim={list.loading}
            caption="Employees"
            empty={
              <FilterEmpty
                lf={lf}
                icon={UserSearch}
                emptyTitle="No employees tracked yet"
                emptyDescription="Import a punch-log export to start tracking."
              />
            }
          />
        )}
      </Card>
    </div>
  );
}
