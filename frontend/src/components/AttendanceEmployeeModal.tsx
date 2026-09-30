import { useMemo } from "react";
import clsx from "clsx";
import { useApi } from "../lib/useApi";
import { fmtDay, fmtTime } from "../lib/format";
import type { AttendanceDay, AttendanceEmployeeDetail } from "../types";
import { Avatar, DataTable, EmptyState, ErrorState, Skeleton, Tooltip, type Column } from "./ui";
import { useOverlay } from "./Modal";
import { CalendarX2 } from "lucide-react";

export function useAttendanceEmployeeModal() {
  const { openModal } = useOverlay();
  return (empCode: string) => openModal(<AttendanceEmployeeModalBody empCode={empCode} />);
}

const WEEKDAYS = ["Mon", "", "Wed", "", "Fri", "", ""];

/** "YYYY-MM-DD" of a UTC-midnight calendar date. */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * GitHub contribution-graph style: one column per week (Mon–Sun), one cell per day.
 * work_date values are calendar dates (already in the org time zone), so all the
 * arithmetic here is done on UTC midnights — no zone, no DST, no shifted days.
 */
function DayHeatmap({ days }: { days: AttendanceDay[] }) {
  const weeks = useMemo(() => {
    if (!days.length) return [];
    const byDate = new Map(days.map((d) => [d.work_date.slice(0, 10), d]));
    const dates = days.map((d) => new Date(`${d.work_date.slice(0, 10)}T00:00:00Z`)).sort((a, b) => a.getTime() - b.getTime());
    const start = new Date(dates[0]);
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7)); // back to Monday
    const end = dates[dates.length - 1];
    const cols: { date: string; day?: AttendanceDay }[][] = [];
    for (let d = new Date(start); d <= end || cols[cols.length - 1]?.length < 7; d.setUTCDate(d.getUTCDate() + 1)) {
      if (!cols.length || cols[cols.length - 1].length === 7) cols.push([]);
      const iso = isoDate(d);
      cols[cols.length - 1].push({ date: iso, day: byDate.get(iso) });
    }
    return cols;
  }, [days]);

  if (!weeks.length) return null;

  return (
    <div>
      <div className="flex gap-[3px] overflow-x-auto pb-1">
        <div className="flex flex-col gap-[3px] pr-1.5">
          {WEEKDAYS.map((w, i) => (
            <span key={i} className="h-3 text-[10px] leading-3 text-ink3">{w}</span>
          ))}
        </div>
        {weeks.map((week, wi) => (
          <div key={wi} className="flex flex-col gap-[3px]">
            {week.map(({ date, day }) => {
              const tip = day
                ? `${fmtDay(day.work_date)} · Present · ${day.punch_count} punch${day.punch_count === 1 ? "" : "es"}`
                : `${fmtDay(date)} · No record`;
              return (
                <Tooltip key={date} content={tip} delay={100}>
                  <span
                    tabIndex={day ? 0 : -1}
                    aria-label={tip}
                    className={clsx("block w-3 h-3 rounded-[3px] outline-offset-1", day ? "bg-good" : "bg-neutral-bg")}
                  />
                </Tooltip>
              );
            })}
          </div>
        ))}
      </div>
      <div className="flex items-center justify-end gap-3 mt-2 text-[11px] text-ink2">
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-[3px] bg-good" aria-hidden />
          Present
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-[3px] bg-neutral-bg" aria-hidden />
          No record
        </span>
      </div>
    </div>
  );
}

const COLUMNS: Column<AttendanceDay>[] = [
  { key: "date", header: "Date", sortValue: (d) => d.work_date, cell: (d) => <span className="font-mono text-xs text-ink whitespace-nowrap">{fmtDay(d.work_date)}</span> },
  { key: "first", header: "First punch", cell: (d) => <span className="font-mono text-xs text-ink2">{d.first_punch ? fmtTime(d.first_punch) : "—"}</span> },
  { key: "last", header: "Last punch", cell: (d) => <span className="font-mono text-xs text-ink2">{d.last_punch ? fmtTime(d.last_punch) : "—"}</span> },
  { key: "count", header: "Punches", align: "right", sortValue: (d) => d.punch_count, cell: (d) => <span className="font-mono text-xs text-ink2">{d.punch_count}</span> },
];

function AttendanceEmployeeModalBody({ empCode }: { empCode: string }) {
  const { data: emp, error, reload } = useApi<AttendanceEmployeeDetail>(`/attendance/${encodeURIComponent(empCode)}`);

  if (error) return <div className="pt-6"><ErrorState message={error.message} onRetry={reload} /></div>;
  if (!emp) {
    return (
      <div>
        <div className="flex items-center gap-4 pr-8">
          <Skeleton className="w-12 h-12 !rounded-full" />
          <div className="flex-1">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-3.5 w-56 mt-2" />
          </div>
        </div>
        <div className="flex gap-3 mt-6">
          <Skeleton className="h-16 flex-1" />
          <Skeleton className="h-16 flex-1" />
        </div>
        <Skeleton className="h-24 w-full mt-6" />
      </div>
    );
  }

  const meta = [emp.emp_code, emp.company, emp.department].filter(Boolean).join(" · ");

  return (
    <div>
      <div className="flex items-center gap-4 pr-8">
        <Avatar name={emp.name} size={48} />
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-ink truncate">{emp.name}</h2>
          <p className="text-[13px] text-ink2 truncate font-mono">{meta}</p>
        </div>
      </div>

      <div className="mt-5 rounded-lg border border-line bg-panel2 px-3 py-2.5">
        <div className="text-xs text-ink2">Days tracked</div>
        <div className="text-xl font-semibold text-ink tabular mt-0.5">{emp.total_days_tracked}</div>
      </div>

      {emp.days.length ? (
        <>
          <h3 className="text-sm font-semibold text-ink mt-6 mb-3">Activity</h3>
          <DayHeatmap days={emp.days} />
          <h3 className="text-sm font-semibold text-ink mt-6 mb-2">
            Punch history <span className="text-ink3 font-normal">· {emp.days.length} day{emp.days.length === 1 ? "" : "s"}</span>
          </h3>
          <div className="border border-line rounded-lg overflow-hidden max-h-[300px] overflow-y-auto">
            <DataTable columns={COLUMNS} rows={emp.days} getRowKey={(d) => d.work_date} defaultSort={{ key: "date", dir: "desc" }} dense />
          </div>
        </>
      ) : (
        <EmptyState icon={CalendarX2} title="No punch history yet" compact className="mt-4" />
      )}
    </div>
  );
}
