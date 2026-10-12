import { Fragment, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AlertTriangle, Award, Building2, ChevronDown, ChevronRight, ShieldCheck } from "lucide-react";
import { useApi } from "../../lib/useApi";
import { downloadCsv, type CsvColumn } from "../../lib/csv";
import { useListFilters, type FilterField, type SortDef } from "../../lib/useListFilters";
import type { ScoreboardEntry } from "../../lib/compliance";
import { PRIORITY_LABEL, STATUS_LABEL, type Priority } from "../../lib/compliance";
import { useCompliance } from "../../lib/ComplianceContext";
import { Card, EmptyState, ErrorState, FilterBar, FilterEmpty, Label, PageHeader, SegmentedControl, SortHeader, TableSkeleton, ariaSortFor, type QuickFilter } from "../../components/ui";
import { PersonCell, PriorityLabel } from "../../components/compliance/common";
import { EmailButton } from "../../components/compliance/email/EmailButton";

type ScoreboardResponse = { days: number; people: ScoreboardEntry[] };

const UNASSIGNED = "Unassigned";
const PRIORITIES = Object.keys(PRIORITY_LABEL) as Priority[];

const SORTS: SortDef<ScoreboardEntry>[] = [
  { key: "score", label: "Score", value: (p) => p.score, firstDir: "desc" },
  { key: "incidents", label: "Incidents", value: (p) => p.incidents, firstDir: "desc" },
  { key: "non_compliant", label: "Non-compliant", value: (p) => p.non_compliant, firstDir: "desc" },
  { key: "overdue", label: "Overdue", value: (p) => p.overdue, firstDir: "desc" },
  { key: "late", label: "Late", value: (p) => p.late, firstDir: "desc" },
  { key: "name", label: "Name", value: (p) => p.name.toLowerCase() },
  { key: "department", label: "Department", value: (p) => p.department },
];

const QUICK: QuickFilter[] = [
  { id: "repeat", label: "Repeat offenders", icon: Award, field: "repeat" },
  { id: "three", label: "3+ incidents", field: "min_incidents", value: 3 },
  { id: "nc", label: "Has non-compliant items", field: "non_compliant" },
];

const CSV_COLUMNS: CsvColumn<ScoreboardEntry>[] = [
  { header: "Rank", value: (p) => p.rank },
  { header: "Name", value: (p) => p.name },
  { header: "Email", value: (p) => p.email },
  { header: "Department", value: (p) => p.department },
  { header: "Score", value: (p) => p.score },
  { header: "Incidents", value: (p) => p.incidents },
  { header: "Non-compliant", value: (p) => p.non_compliant },
  { header: "Overdue", value: (p) => p.overdue },
  { header: "Late", value: (p) => p.late },
  { header: "Repeat offender", value: (p) => (p.repeat_offender ? "Yes" : "No") },
];

const MEDALS = ["bg-accent-emphasis text-white", "bg-neutral-bg text-ink2", "bg-neutral-bg text-ink2"];

export function Scoreboard() {
  const { can } = useCompliance();
  const [params, setParams] = useSearchParams();
  const days = ["30", "90", "180", "365"].includes(params.get("days") ?? "") ? params.get("days")! : "90";
  const setDays = (v: string) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (v === "90") next.delete("days");
        else next.set("days", v);
        return next;
      },
      { replace: true }
    );
  const { data, error, initialLoading, reload } = useApi<ScoreboardResponse>(can("report", "view") ? `/compliance/scoreboard?days=${days}` : null);
  const [open, setOpen] = useState<string | null>(null);

  const people = data?.people;
  const fields = useMemo<FilterField<ScoreboardEntry>[]>(() => {
    const depts = new Map<string, number>();
    for (const p of people ?? []) depts.set(p.department || UNASSIGNED, (depts.get(p.department || UNASSIGNED) ?? 0) + 1);
    return [
      {
        type: "multi",
        key: "department",
        label: "Department",
        icon: Building2,
        options: Array.from(depts, ([value, count]) => ({ value, label: value, count })).sort((a, b) => a.label.localeCompare(b.label)),
        get: (p) => p.department || UNASSIGNED,
      },
      {
        type: "multi",
        key: "priority",
        label: "Incident priority",
        options: PRIORITIES.map((v) => ({ value: v, label: PRIORITY_LABEL[v] })),
        hint: "People with an incident at one of these priorities.",
        get: (p) => p.items.map((i) => i.priority),
      },
      { type: "range", key: "score", label: "Score", min: 0 },
      {
        type: "number",
        key: "min_incidents",
        label: "Minimum incidents",
        suffix: "or more",
        chip: ((n: number) => `${n}+ incidents`) as never,
        test: (p, n) => p.incidents >= n,
      },
      { type: "toggle", key: "repeat", label: "Repeat offenders only", hint: "Three or more incidents.", test: (p) => p.repeat_offender },
      { type: "toggle", key: "non_compliant", label: "Has non-compliant items", test: (p) => p.non_compliant > 0 },
      { type: "toggle", key: "overdue", label: "Has overdue items", test: (p) => p.overdue > 0 },
    ];
  }, [people]);
  const lf = useListFilters<ScoreboardEntry>({
    id: "scoreboard",
    fields,
    sorts: SORTS,
    defaultSort: { key: "score", dir: "desc" },
    tieBreak: [{ key: "incidents", dir: "desc" }, { key: "name", dir: "asc" }],
    searchText: (p) => `${p.name} ${p.email} ${p.department ?? ""}`,
  });
  const rows = useMemo(() => (people ? lf.apply(people) : []), [people, lf.apply]);
  // Whoever the scoreboard shows as a repeat offender, for the "Email repeat offenders" action (the server re-checks who may be reached).
  const repeaters = useMemo(() => (people ?? []).filter((p) => p.repeat_offender), [people]);

  return (
    <div>
      <PageHeader
        title="Defaulter scoreboard"
        description="Who keeps missing deadlines. Each late, overdue or non-compliant item is an incident, weighted by its priority; three or more makes a repeat offender."
        actions={
          <>
            {repeaters.length > 0 && (
              <EmailButton
                label={`Email repeat offenders (${repeaters.length})`}
                icon={AlertTriangle}
                target={() => ({
                  recipients: { emails: repeaters.map((p) => p.email) },
                  heading: `Email ${repeaters.length} repeat ${repeaters.length === 1 ? "offender" : "offenders"}`,
                  subtitle: "Each person gets a summary of their own open items. Replies go to you.",
                  defaultKind: "warning",
                })}
              />
            )}
            <SegmentedControl
              aria-label="Period"
              value={days}
              onChange={setDays}
              options={[
                { value: "30", label: "30 days" },
                { value: "90", label: "90 days" },
                { value: "180", label: "6 months" },
                { value: "365", label: "1 year" },
              ]}
            />
          </>
        }
      />

      {error && !data ? (
        <Card>
          <ErrorState message={error.message} onRetry={reload} />
        </Card>
      ) : initialLoading || !data ? (
        <Card padding="none">
          <TableSkeleton rows={6} columns={5} />
        </Card>
      ) : data.people.length === 0 ? (
        <Card>
          <EmptyState icon={ShieldCheck} title="Nobody is missing deadlines" description={`No late, overdue or non-compliant items in the last ${data.days} days among the people you can see.`} />
        </Card>
      ) : (
        <>
        <FilterBar
          lf={lf}
          noun={["person", "people"]}
          total={data.people.length}
          shown={rows.length}
          quick={QUICK}
          searchPlaceholder="Search name or department…"
          onExport={() => downloadCsv("scoreboard", CSV_COLUMNS, rows)}
        />
        <Card padding="none" className="overflow-hidden">
          {rows.length === 0 ? (
            <FilterEmpty lf={lf} icon={ShieldCheck} emptyTitle="Nobody is missing deadlines" />
          ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">People ranked by compliance incidents</caption>
              <thead>
                <tr className="bg-panel2 border-b border-line text-left text-xs font-semibold text-ink2">
                  <th className="pl-4 pr-2 py-2.5 w-12" title="Rank by score over the whole period">#</th>
                  <th scope="col" aria-sort={ariaSortFor(lf, "name")} className="px-3 py-2.5"><SortHeader lf={lf} sortKey="name">Person</SortHeader></th>
                  <th scope="col" aria-sort={ariaSortFor(lf, "score")} className="px-3 py-2.5 text-right"><SortHeader lf={lf} sortKey="score" align="right">Score</SortHeader></th>
                  <th scope="col" aria-sort={ariaSortFor(lf, "incidents")} className="px-3 py-2.5 text-right"><SortHeader lf={lf} sortKey="incidents" align="right">Incidents</SortHeader></th>
                  <th scope="col" aria-sort={ariaSortFor(lf, "non_compliant")} className="px-3 py-2.5 text-right hidden sm:table-cell"><SortHeader lf={lf} sortKey="non_compliant" align="right">Non-compliant</SortHeader></th>
                  <th scope="col" aria-sort={ariaSortFor(lf, "overdue")} className="px-3 py-2.5 text-right hidden md:table-cell"><SortHeader lf={lf} sortKey="overdue" align="right">Overdue</SortHeader></th>
                  <th scope="col" aria-sort={ariaSortFor(lf, "late")} className="px-3 py-2.5 text-right hidden md:table-cell"><SortHeader lf={lf} sortKey="late" align="right">Late</SortHeader></th>
                  <th className="w-20" />
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const isOpen = open === p.email;
                  return (
                    <Fragment key={p.email}>
                      <tr
                        onClick={() => setOpen(isOpen ? null : p.email)}
                        className="mc-row border-b border-line-soft hover:bg-panel2 cursor-pointer"
                      >
                        <td className="pl-4 pr-2 py-3">
                          <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-semibold tabular ${MEDALS[p.rank - 1] ?? "text-ink2"}`}>{p.rank}</span>
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex items-center gap-2 flex-wrap">
                            <PersonCell person={{ email: p.email, name: p.name, title: "", department: p.department }} showTitle size={28} />
                            {p.repeat_offender && <Label tone="crit" size="sm" icon={Award}>Repeat offender</Label>}
                          </div>
                        </td>
                        <td className="px-3 py-3 text-right font-semibold tabular text-ink">{p.score}</td>
                        <td className="px-3 py-3 text-right tabular">{p.incidents}</td>
                        <td className="px-3 py-3 text-right tabular hidden sm:table-cell">{p.non_compliant || "—"}</td>
                        <td className="px-3 py-3 text-right tabular hidden md:table-cell">{p.overdue || "—"}</td>
                        <td className="px-3 py-3 text-right tabular hidden md:table-cell">{p.late || "—"}</td>
                        <td className="pr-3 text-ink3">
                          <span className="flex items-center justify-end gap-1">
                            <EmailButton
                              iconOnly
                              label={`Email ${p.name}`}
                              target={() => ({
                                recipients: { emails: [p.email] },
                                heading: `Email ${p.name}`,
                                subtitle: `${p.incidents} ${p.incidents === 1 ? "incident" : "incidents"} in this period. Replies go to you.`,
                                defaultKind: p.repeat_offender || p.overdue > 0 ? "warning" : "reminder",
                              })}
                            />
                            {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                          </span>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="bg-panel2 border-b border-line-soft">
                          <td />
                          <td colSpan={7} className="px-3 py-3">
                            <ul className="flex flex-col gap-1.5">
                              {p.items.map((it) => (
                                <li key={it.obligation_id} className="flex items-center gap-3 text-[13px]">
                                  <Link to={`/compliance/obligations/${it.obligation_id}`} className="font-semibold text-ink hover:text-accent hover:underline">
                                    {it.compliance}
                                  </Link>
                                  <PriorityLabel priority={it.priority} />
                                  <span className="text-ink2">{STATUS_LABEL[it.status]}</span>
                                </li>
                              ))}
                            </ul>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          )}
        </Card>
        </>
      )}
    </div>
  );
}
