import { useMemo, useState } from "react";
import clsx from "clsx";
import { UserSearch } from "lucide-react";
import { useApi } from "../lib/useApi";
import type { PersonListItem } from "../types";
import { Avatar, Button, Card, EmptyState, ErrorState, Label, PageHeader, RateMeter, SearchInput, SegmentedControl, Skeleton } from "../components/ui";
import { usePersonModal } from "../components/PersonModal";

type Sort = "rate-asc" | "name";

const GRID = "grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4";

export function Team() {
  const { data: people, error, reload } = useApi<PersonListItem[]>("/people");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort>("rate-asc");
  const openPerson = usePersonModal();

  const list = useMemo(() => {
    if (!people) return [];
    const q = search.trim().toLowerCase();
    return people
      .filter((p) => !q || `${p.name} ${p.email} ${p.title}`.toLowerCase().includes(q))
      .sort((a, b) =>
        sort === "name" ? a.name.localeCompare(b.name) : (a.attendance_rate ?? 2) - (b.attendance_rate ?? 2) || a.name.localeCompare(b.name)
      );
  }, [people, search, sort]);

  return (
    <div>
      <PageHeader title="Team" description="You and everyone reporting to you, directly or indirectly" />

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <SearchInput value={search} onChange={setSearch} placeholder="Search people…" className="w-full sm:w-72" />
        <SegmentedControl
          aria-label="Sort"
          value={sort}
          onChange={setSort}
          options={[
            { value: "rate-asc", label: "Lowest rate first" },
            { value: "name", label: "Name" },
          ]}
        />
        {people && (
          <span className="ml-auto text-[13px] text-ink2 tabular" aria-live="polite">
            {list.length} {list.length === 1 ? "person" : "people"}
          </span>
        )}
      </div>

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
          <EmptyState
            icon={UserSearch}
            title="No one matches your search"
            description="Try a name, email or job title."
            action={<Button onClick={() => setSearch("")}>Clear search</Button>}
          />
        </Card>
      )}
    </div>
  );
}
