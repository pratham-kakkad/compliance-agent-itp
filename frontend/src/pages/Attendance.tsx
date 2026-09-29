import { useMemo, useState } from "react";
import { Fingerprint, UserSearch, CalendarDays, X } from "lucide-react";
import { useApi } from "../lib/useApi";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import { fmtDay } from "../lib/format";
import type { AttendanceDashboardPayload, AttendanceListItem, AttendanceListResponse } from "../types";
import {
  Avatar,
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  PageHeader,
  SearchInput,
  Select,
  StatCard,
  StatGridSkeleton,
  TableSkeleton,
  type Column,
} from "../components/ui";
import { useAttendanceEmployeeModal } from "../components/AttendanceEmployeeModal";

function uniqueSorted(values: (string | null)[]): string[] {
  return Array.from(new Set(values.filter((v): v is string => !!v))).sort((a, b) => a.localeCompare(b));
}

const COLUMNS: Column<AttendanceListItem>[] = [
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
  { key: "dept", header: "Department", hideBelow: "sm", sortValue: (i) => i.department, cell: (i) => <span className="text-ink2">{i.department || "—"}</span> },
  {
    key: "days",
    header: "Days tracked",
    align: "right",
    hideBelow: "sm",
    sortValue: (i) => i.days_tracked,
    cell: (i) => <span className="font-mono text-[13px] text-ink2">{i.days_tracked}</span>,
  },
  {
    key: "last_seen",
    header: "Last seen",
    align: "right",
    width: "150px",
    sortValue: (i) => i.last_seen,
    cell: (i) => <span className="font-mono text-[13px] text-ink2">{i.last_seen ? fmtDay(i.last_seen) : "—"}</span>,
  },
];

export function Attendance() {
  const openEmployee = useAttendanceEmployeeModal();
  const [search, setSearch] = useState("");
  const [department, setDepartment] = useState("");
  const q = useDebouncedValue(search, 250);

  const summary = useApi<AttendanceDashboardPayload>("/attendance/dashboard");
  // Unfiltered list, only to populate the filter options.
  const all = useApi<AttendanceListResponse>("/attendance");
  const params = new URLSearchParams();
  if (q) params.set("search", q);
  if (department) params.set("department", department);
  const list = useApi<AttendanceListResponse>(`/attendance?${params.toString()}`);

  const departments = useMemo(() => uniqueSorted((all.data?.items ?? []).map((i) => i.department)), [all.data]);
  const filtered = Boolean(q || department);
  const clear = () => {
    setSearch("");
    setDepartment("");
  };
  const s = summary.data?.summary;
  const count = list.data?.items.length ?? 0;

  return (
    <div>
      <PageHeader title="Employees" description="Biometric punch-log attendance across every tracked employee" />

      <div className="mb-6">
        {summary.error && !summary.data ? null : !s ? (
          <StatGridSkeleton />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <StatCard label="Employees tracked" icon={Fingerprint} value={String(s.employee_count)} animateValue={s.employee_count} foot="On biometric devices" />
            <StatCard label="Days tracked" icon={CalendarDays} value={String(s.total_days_tracked)} animateValue={s.total_days_tracked} foot="Across every employee" />
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <SearchInput value={search} onChange={setSearch} placeholder="Search employees…" className="w-full sm:w-72" />
        <Select value={department} onChange={(e) => setDepartment(e.target.value)} aria-label="Department">
          <option value="">All departments</option>
          {departments.map((d) => <option key={d} value={d}>{d}</option>)}
        </Select>
        {filtered && <Button variant="ghost" size="md" leadingIcon={X} onClick={clear}>Clear filters</Button>}
        {list.data && (
          <span className="ml-auto text-[13px] text-ink2 tabular" aria-live="polite">
            {count} employee{count === 1 ? "" : "s"}
          </span>
        )}
      </div>

      <Card padding="none" className="overflow-hidden">
        {list.error && !list.data ? (
          <ErrorState message={list.error.message} onRetry={list.reload} />
        ) : !list.data ? (
          <TableSkeleton rows={6} columns={5} />
        ) : (
          <DataTable
            columns={COLUMNS}
            rows={list.data.items}
            getRowKey={(i) => i.emp_code}
            onRowClick={(i) => openEmployee(i.emp_code)}
            rowLabel={(i) => `Open ${i.name}`}
            defaultSort={{ key: "last_seen", dir: "desc" }}
            dim={list.loading}
            caption="Employees"
            empty={
              <EmptyState
                icon={UserSearch}
                title={filtered ? "No employees match your filters" : "No employees tracked yet"}
                description={filtered ? "Try a different search or clear the filters." : "Import a punch-log export to start tracking."}
                action={filtered && <Button onClick={clear}>Clear filters</Button>}
              />
            }
          />
        )}
      </Card>
    </div>
  );
}
