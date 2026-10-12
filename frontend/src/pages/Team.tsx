import { useMemo } from "react";
import clsx from "clsx";
import { Gauge, UserSearch, Users } from "lucide-react";
import { useApi } from "../lib/useApi";
import { downloadCsv, type CsvColumn } from "../lib/csv";
import { useListFilters, type FilterField, type SortDef } from "../lib/useListFilters";
import type { PersonListItem } from "../types";
import { Avatar, Card, ErrorState, FilterBar, FilterEmpty, Label, PageHeader, RateMeter, Skeleton, type QuickFilter } from "../components/ui";
import { usePersonModal } from "../components/PersonModal";

/** Below this attendance rate a person counts as at risk (the app's "red" band). */
const AT_RISK = 0.75;

const SORTS: SortDef<PersonListItem>[] = [
  { key: "rate", label: "Attendance rate", value: (p) => p.attendance_rate },
  { key: "name", label: "Name", value: (p) => p.name.toLowerCase() },
  { key: "title", label: "Job title", value: (p) => p.title.toLowerCase() },
];

const CSV_COLUMNS = (nameOf: (email: string | null) => string): CsvColumn<PersonListItem>[] => [
  { header: "Name", value: (p) => p.name },
  { header: "Email", value: (p) => p.email },
  { header: "Job title", value: (p) => p.title },
  { header: "Manager", value: (p) => nameOf(p.manager_email) },
  { header: "Attendance rate (%)", value: (p) => (p.attendance_rate == null ? "" : Math.round(p.attendance_rate * 100)) },
];

const GRID = "grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4";

export function Team() {
  const { data: people, error, reload } = useApi<PersonListItem[]>("/people");
  const openPerson = usePersonModal();

  const nameOf = useMemo(() => {
    const byEmail = new Map((people ?? []).map((p) => [p.email, p.name]));
    return (email: string | null) => (email ? byEmail.get(email) ?? email : "");
  }, [people]);
  const selfEmail = people?.find((p) => p.is_self)?.email;

  const fields = useMemo<FilterField<PersonListItem>[]>(() => {
    const managers = new Map<string, number>();
    const titles = new Map<string, number>();
    for (const p of people ?? []) {
      if (p.manager_email) managers.set(p.manager_email, (managers.get(p.manager_email) ?? 0) + 1);
      if (p.title) titles.set(p.title, (titles.get(p.title) ?? 0) + 1);
    }
    const opts = (m: Map<string, number>, label: (v: string) => string) =>
      Array.from(m, ([value, count]) => ({ value, label: label(value), count })).sort((a, b) => a.label.localeCompare(b.label));
    return [
      { type: "multi", key: "manager", label: "Manager", icon: Users, options: opts(managers, (e) => nameOf(e)), get: (p) => p.manager_email },
      { type: "multi", key: "title", label: "Job title", options: opts(titles, (t) => t), get: (p) => p.title },
      {
        type: "range",
        key: "rate",
        label: "Attendance rate",
        suffix: "%",
        min: 0,
        max: 100,
        get: (p) => (p.attendance_rate == null ? null : Math.round(p.attendance_rate * 100)),
      },
      {
        type: "toggle",
        key: "at_risk",
        label: "At risk only",
        hint: "Attendance rate under 75%.",
        chip: (() => "At risk (under 75%)") as never,
        test: (p) => p.attendance_rate != null && p.attendance_rate < AT_RISK,
      },
      {
        type: "toggle",
        key: "has_data",
        label: "Has attendance data",
        hint: "Hide people who haven't been required at any meeting yet.",
        test: (p) => p.attendance_rate != null,
      },
    ];
  }, [people, nameOf]);

  const quick = useMemo<QuickFilter[]>(
    () => [
      { id: "risk", label: "At risk (under 75%)", icon: Gauge, field: "at_risk" },
      ...(selfEmail ? [{ id: "mine", label: "My direct reports", icon: Users, field: "manager", value: selfEmail }] : []),
    ],
    [selfEmail]
  );

  const lf = useListFilters<PersonListItem>({
    id: "team",
    fields,
    sorts: SORTS,
    defaultSort: { key: "rate", dir: "asc" },
    tieBreak: [{ key: "name", dir: "asc" }],
    searchText: (p) => `${p.name} ${p.email} ${p.title}`,
  });
  const list = useMemo(() => (people ? lf.apply(people) : []), [people, lf.apply]);

  return (
    <div>
      <PageHeader title="Team" description="You and everyone reporting to you, directly or indirectly" />

      <FilterBar
        lf={lf}
        noun={["person", "people"]}
        total={people?.length}
        shown={people ? list.length : undefined}
        quick={quick}
        searchPlaceholder="Search name, email or job title…"
        onExport={() => downloadCsv("team", CSV_COLUMNS(nameOf), list)}
      />

      {error && !people ? (
        <Card>
          <ErrorState message={error.message} onRetry={reload} />
        </Card>
      ) : !people ? (
        <div className={GRID}>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="bg-panel border border-line rounded-lg p-4">
              <div className="flex items-center gap-3">
                <Skeleton className="w-10 h-10 !rounded-full" />
                <div className="flex-1">
                  <Skeleton className="h-3.5 w-24" />
                  <Skeleton className="h-3 w-32 mt-2" />
                </div>
              </div>
              <Skeleton className="h-2 w-full mt-5" />
            </div>
          ))}
        </div>
      ) : list.length ? (
        <ul className={GRID}>
          {list.map((p) => (
            <li key={p.email}>
              <button
                type="button"
                onClick={() => openPerson(p.email)}
                className={clsx(
                  "w-full h-full text-left bg-panel border border-line rounded-lg shadow-xs p-4 flex flex-col items-stretch gap-4",
                  "transition-[border-color,box-shadow] duration-100 hover:border-line-strong hover:shadow-md"
                )}
              >
                <div className="w-full flex items-center gap-3 min-w-0">
                  <Avatar name={p.name} size={40} self={p.is_self} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm font-semibold text-ink truncate">{p.name}</span>
                      {p.is_self && <Label size="sm" tone="accent">You</Label>}
                    </div>
                    <div className="text-[13px] text-ink2 truncate">{p.title}</div>
                  </div>
                </div>
                <div className="w-full flex items-center justify-between gap-3">
                  <span className="text-xs text-ink2">Attendance</span>
                  <RateMeter rate={p.attendance_rate} width={96} />
                </div>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <Card>
          <FilterEmpty lf={lf} icon={UserSearch} emptyTitle="No one on your team yet" emptyDescription="People who report to you will appear here." />
        </Card>
      )}
    </div>
  );
}
