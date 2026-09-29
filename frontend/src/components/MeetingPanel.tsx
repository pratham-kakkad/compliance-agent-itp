import { Check, Minus, X } from "lucide-react";
import clsx from "clsx";
import { useApi } from "../lib/useApi";
import { fmtDate, fmtTime } from "../lib/format";
import { useAuth } from "../auth/AuthContext";
import type { MeetingDetail } from "../types";
import { Avatar, ErrorState, Label, RateBadge, Skeleton } from "./ui";
import { useOverlay } from "./Modal";

export function useMeetingPanel() {
  const { openPanel } = useOverlay();
  return (seriesId: string) => openPanel(<MeetingPanelBody seriesId={seriesId} />);
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex-1 min-w-0 rounded-lg border border-line bg-panel2 px-3 py-2.5">
      <div className="text-xs text-ink2">{label}</div>
      <div className="text-lg font-semibold text-ink tabular mt-0.5">{value}</div>
    </div>
  );
}

function MeetingPanelBody({ seriesId }: { seriesId: string }) {
  const { displayName } = useAuth();
  const { data: meeting, error, reload } = useApi<MeetingDetail>(`/meetings/${seriesId}`);

  if (error) return <div className="pt-8"><ErrorState message={error.message} onRetry={reload} /></div>;
  if (!meeting) {
    return (
      <div className="pr-8">
        <Skeleton className="h-6 w-3/4" />
        <Skeleton className="h-4 w-1/2 mt-3" />
        <div className="flex gap-3 mt-6">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 flex-1" />)}
        </div>
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 w-full mt-4" />)}
      </div>
    );
  }

  const occurrences = meeting.occurrences.slice().reverse();
  const required = meeting.occurrences.flatMap((o) => o.attendances.filter((a) => a.required));
  const attended = required.filter((a) => a.attended).length;
  const rate = required.length ? attended / required.length : null;
  const organizer = displayName(meeting.organizer_email);

  return (
    <div>
      <div className="pr-10">
        <h2 className="text-lg font-semibold text-ink leading-6">{meeting.title}</h2>
        <div className="flex flex-wrap items-center gap-2 mt-2 text-[13px] text-ink2">
          <Avatar name={organizer} size={20} />
          <span>Organized by <span className="text-ink font-medium">{organizer}</span></span>
          <Label size="sm" tone={meeting.recurrence === "once" ? "neutral" : "accent"}>
            {meeting.recurrence === "once" ? "One-time" : "Recurring"}
          </Label>
        </div>
      </div>

      <div className="flex gap-3 mt-5">
        <Stat label="Occurrences" value={meeting.occurrences.length} />
        <Stat label="Attendance" value={<RateBadge rate={rate} />} />
        <Stat label="Required absences" value={required.length - attended} />
      </div>

      <h3 className="text-sm font-semibold text-ink mt-6 mb-3">Occurrences</h3>
      <ol className="relative">
        {occurrences.map((occ, i) => {
          const req = occ.attendances.filter((a) => a.required);
          const ok = req.filter((a) => a.attended).length;
          return (
            <li key={occ.id} className="relative pl-6 pb-5 last:pb-0">
              {i < occurrences.length - 1 && <span className="absolute left-[5px] top-3 bottom-0 w-px bg-line" aria-hidden />}
              <span className={clsx("absolute left-0 top-1.5 w-[11px] h-[11px] rounded-full border-2 border-panel", ok === req.length ? "bg-good" : "bg-crit")} aria-hidden />
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs text-ink2">{fmtDate(occ.start_time)} – {fmtTime(occ.end_time)}</span>
                <span className="text-xs text-ink2 tabular">{ok}/{req.length} required attended</span>
              </div>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {occ.attendances.map((a, ai) => {
                  const status = a.attended ? "present" : a.required ? "absent" : "optional";
                  const Icon = status === "present" ? Check : status === "absent" ? X : Minus;
                  return (
                    <span
                      key={`${a.attendee_email}-${ai}`}
                      title={`${a.name} — ${a.attended ? "present" : "absent"}${a.required ? "" : " (optional)"}`}
                      className={clsx(
                        "inline-flex items-center gap-1 h-6 pl-1.5 pr-2 rounded-full text-xs font-medium border",
                        status === "present" && "bg-good-bg text-good border-transparent",
                        status === "absent" && "bg-crit-bg text-crit border-transparent",
                        status === "optional" && "bg-panel text-ink2 border-line border-dashed"
                      )}
                    >
                      <Icon size={12} strokeWidth={2.5} aria-hidden />
                      {a.name}
                      {!a.required && <span className="text-ink3">· optional</span>}
                    </span>
                  );
                })}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
