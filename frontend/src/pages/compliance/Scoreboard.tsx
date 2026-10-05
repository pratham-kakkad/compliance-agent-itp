import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import { Award, ChevronDown, ChevronRight, ShieldCheck } from "lucide-react";
import { useApi } from "../../lib/useApi";
import type { ScoreboardEntry } from "../../lib/compliance";
import { STATUS_LABEL } from "../../lib/compliance";
import { useCompliance } from "../../lib/ComplianceContext";
import { Card, EmptyState, ErrorState, Label, PageHeader, SegmentedControl, TableSkeleton } from "../../components/ui";
import { PersonCell, PriorityLabel } from "../../components/compliance/common";

type ScoreboardResponse = { days: number; people: ScoreboardEntry[] };

const MEDALS = ["bg-[#c98a5e] text-white", "bg-neutral-bg text-ink2", "bg-neutral-bg text-ink2"];

export function Scoreboard() {
  const { can } = useCompliance();
  const [days, setDays] = useState("90");
  const { data, error, initialLoading, reload } = useApi<ScoreboardResponse>(can("report", "view") ? `/compliance/scoreboard?days=${days}` : null);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div>
      <PageHeader
        title="Defaulter scoreboard"
        description="Who keeps missing deadlines. Each late, overdue or non-compliant item is an incident, weighted by its priority; three or more makes a repeat offender."
        actions={
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
        <Card padding="none" className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">People ranked by compliance incidents</caption>
              <thead>
                <tr className="bg-panel2 border-b border-line text-left text-xs font-semibold text-ink2">
                  <th className="pl-4 pr-2 py-2.5 w-12">#</th>
                  <th className="px-3 py-2.5">Person</th>
                  <th className="px-3 py-2.5 text-right">Score</th>
                  <th className="px-3 py-2.5 text-right">Incidents</th>
                  <th className="px-3 py-2.5 text-right hidden sm:table-cell">Non-compliant</th>
                  <th className="px-3 py-2.5 text-right hidden md:table-cell">Overdue</th>
                  <th className="px-3 py-2.5 text-right hidden md:table-cell">Late</th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {data.people.map((p) => {
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
                        <td className="pr-3 text-ink3">{isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</td>
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
        </Card>
      )}
    </div>
  );
}
