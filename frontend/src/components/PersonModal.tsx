import { CalendarX2 } from "lucide-react";
import { useApi } from "../lib/useApi";
import { pct, rateTone } from "../lib/format";
import type { PersonDetail } from "../types";
import { Avatar, EmptyState, ErrorState, RateMeter, Skeleton } from "./ui";
import { AttendanceDonut } from "./charts";
import { useOverlay } from "./Modal";
import { useMeetingPanel } from "./MeetingPanel";

export function usePersonModal() {
  const { openModal } = useOverlay();
  return (email: string) => openModal(<PersonModalBody email={email} />);
}

const TONE_TEXT = { neutral: "text-ink", accent: "text-accent", good: "text-good", warn: "text-warn", crit: "text-crit" } as const;

function PersonModalBody({ email }: { email: string }) {
  const { data: person, error, reload } = useApi<PersonDetail>(`/people/${encodeURIComponent(email)}`);
  const openPerson = usePersonModal();
  const openMeeting = useMeetingPanel();

  if (error) return <div className="pt-6"><ErrorState message={error.message} onRetry={reload} /></div>;
  if (!person) {
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
        <Skeleton className="h-40 w-40 !rounded-full mx-auto mt-6" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-4 pr-8">
        <Avatar name={person.name} size={48} />
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-ink truncate">{person.name}</h2>
          <p className="text-[13px] text-ink2 truncate">
            {person.title}
            <span className="text-ink3"> · </span>
            {person.email}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mt-5">
        <div className="rounded-lg border border-line bg-panel2 px-3 py-2.5">
          <div className="text-xs text-ink2">Attendance rate</div>
          <div className={`text-xl font-semibold tabular mt-0.5 ${TONE_TEXT[rateTone(person.attendance_rate)]}`}>{pct(person.attendance_rate)}</div>
        </div>
        <div className="rounded-lg border border-line bg-panel2 px-3 py-2.5">
          <div className="text-xs text-ink2">Required meetings</div>
          <div className="text-xl font-semibold text-ink tabular mt-0.5">
            {person.required_attended}
            <span className="text-ink3 font-normal">/{person.required_total}</span>
          </div>
        </div>
      </div>

      <div className="mt-5">
        <AttendanceDonut attended={person.required_attended} total={person.required_total} height={160} />
      </div>

      <h3 className="text-sm font-semibold text-ink mt-6 mb-2">Top meetings</h3>
      {person.series.length ? (
        <ul className="border border-line rounded-lg divide-y divide-line-soft overflow-hidden">
          {person.series.slice(0, 5).map((s) => (
            <li key={s.series_id}>
              <button
                type="button"
                onClick={() => openMeeting(s.series_id)}
                className="w-full flex items-center justify-between gap-3 px-3 h-11 text-left hover:bg-panel2 transition-colors"
              >
                <span className="text-sm text-ink truncate">{s.title}</span>
                <span className="flex items-center gap-3 flex-none">
                  <span className="text-xs text-ink3 tabular">{s.attended}/{s.total}</span>
                  <RateMeter rate={s.attendance_rate} width={56} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState icon={CalendarX2} title="No meeting history yet" compact />
      )}

      {person.direct_reports.length > 0 && (
        <>
          <h3 className="text-sm font-semibold text-ink mt-6 mb-2">Direct reports</h3>
          <div className="flex flex-wrap gap-2">
            {person.direct_reports.map((r) => (
              <button
                key={r.email}
                type="button"
                onClick={() => openPerson(r.email)}
                className="inline-flex items-center gap-2 h-8 pl-1 pr-3 rounded-full border border-line bg-panel hover:bg-panel2 hover:border-line-strong text-[13px] text-ink transition-colors"
              >
                <Avatar name={r.name} size={24} />
                {r.name}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
