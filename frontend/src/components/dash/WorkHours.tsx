import { useState } from "react";
import clsx from "clsx";
import { Clock3 } from "lucide-react";
import { api } from "../../lib/api";
import type { WorkHours } from "../../lib/dashboards";
import { Banner, Button, TextInput } from "../ui";
import { useOverlay } from "../Modal";
import { InfoTip } from "./Kpi";

/** The form inside the "Work hours" dialog: when the day starts and ends, and how many minutes of grace. */
function WorkHoursForm({ initial, onSaved }: { initial: WorkHours; onSaved: () => void }) {
  const { close } = useOverlay();
  const [start, setStart] = useState(initial.work_start);
  const [end, setEnd] = useState(initial.work_end);
  const [grace, setGrace] = useState(String(initial.grace_minutes));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put("/settings/work-hours", { work_start: start, work_end: end, grace_minutes: Number(grace) });
      close();
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const field = "flex flex-col gap-1 text-[13px] font-medium text-ink2";
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h2 className="text-lg font-semibold text-ink pr-8">Work hours</h2>
      <p className="text-[13px] text-ink2 mt-1">
        They decide what counts as a late arrival (first punch after the start plus the grace) and an early exit (last punch before the end minus the grace). Times are in the organization time zone.
      </p>
      <div className="grid grid-cols-3 gap-3 mt-5">
        <label className={field}>
          Day starts
          <TextInput type="time" value={start} onChange={(e) => setStart(e.target.value)} required />
        </label>
        <label className={field}>
          Day ends
          <TextInput type="time" value={end} onChange={(e) => setEnd(e.target.value)} required />
        </label>
        <label className={field}>
          Grace (minutes)
          <TextInput type="number" min={0} max={120} value={grace} onChange={(e) => setGrace(e.target.value)} required />
        </label>
      </div>
      {!initial.saved && <p className="text-[12px] text-ink3 mt-3">Nobody has saved work hours yet: the defaults above are in use.</p>}
      {error && <Banner tone="crit" className="mt-4">{error}</Banner>}
      <div className="flex justify-end gap-2 mt-6">
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={busy}>
          Save
        </Button>
      </div>
    </form>
  );
}

/** Opens the work-hours dialog; `onSaved` runs after a successful save (reload the dashboard). */
export function useWorkHoursDialog(onSaved: () => void) {
  const { openModal } = useOverlay();
  return (current: WorkHours) => openModal(<WorkHoursForm initial={current} onSaved={onSaved} />);
}

/** A tile in the KPI grid that shows the work hours behind the late / early numbers, and changes them. */
export function WorkHoursTile({ hours, onEdit, className }: { hours: WorkHours; onEdit: () => void; className?: string }) {
  return (
    <div data-tone="neutral" data-hue="indigo" className={clsx("spot glass tile rounded-2xl p-4 flex flex-col items-stretch text-left min-w-0 w-full h-full", className)}>
      <div className="w-full flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="text-[13px] font-medium text-ink2 truncate">Work hours</span>
          <InfoTip label="Work hours" text="The working day used to decide what counts as a late arrival and an early exit. Late = first punch after the start plus grace; early = last punch before the end minus grace." />
        </span>
        <span className="tile-chip flex-none">
          <Clock3 size={15} aria-hidden />
        </span>
      </div>
      <div className="mt-1.5 text-[26px] leading-9 font-semibold text-ink tabular">
        {hours.work_start}
        <span className="text-ink3 font-normal"> to </span>
        {hours.work_end}
      </div>
      <div className="mt-1.5 text-[12px] leading-4 text-ink3">
        {hours.grace_minutes} min grace
        {!hours.saved && <span className="text-warn font-medium"> {"·"} default, confirm yours</span>}
      </div>
      <button type="button" onClick={onEdit} className="mt-auto pt-3 self-start text-[13px] font-medium text-accent hover:underline focus-ring rounded">
        Change work hours
      </button>
    </div>
  );
}
