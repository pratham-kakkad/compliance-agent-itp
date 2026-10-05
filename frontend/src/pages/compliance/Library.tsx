import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Archive, CirclePause, CirclePlay, ClipboardList, Copy, Pencil, Plus, SearchX, Trash2, XCircle, MoreHorizontal } from "lucide-react";
import { Button, Card, DataTable, EmptyState, ErrorState, IconButton, Menu, PageHeader, SearchInput, SegmentedControl, Select, TableSkeleton, type Column } from "../../components/ui";
import { DefinitionStatusLabel, PriorityLabel, ProgressCell, DueLabel } from "../../components/compliance/common";
import { availableActions, useDefinitionActions } from "../../components/compliance/library/actions";
import { reviewShort } from "../../components/compliance/library/describe";
import { useCompliance } from "../../lib/ComplianceContext";
import { useApi } from "../../lib/useApi";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import type { ComplianceDef, Page } from "../../lib/compliance";

type StatusFilter = "all" | "draft" | "published" | "paused" | "closed" | "archived";

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "published", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "closed", label: "Closed" },
  { value: "archived", label: "Archived" },
];

const PAGE_SIZE = 50;

function RowMenu({ def, actions }: { def: ComplianceDef; actions: ReturnType<typeof useDefinitionActions> }) {
  const navigate = useNavigate();
  const { can } = useCompliance();
  const a = availableActions(def, can);
  const any = a.edit || a.clone || a.pause || a.resume || a.close || a.archive || a.remove;
  if (!any) return null;
  return (
    // The row opens the compliance on click or Enter; keep the menu's own clicks and keys from doing that too.
    <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} className="inline-flex">
      <Menu.Root>
        <Menu.Trigger asChild>
          <IconButton icon={MoreHorizontal} label={`Actions for ${def.name}`} size="sm" disabled={actions.busy !== null} />
        </Menu.Trigger>
        <Menu.Content>
          {a.edit && (
            <Menu.Item onSelect={() => navigate(`/compliance/library/${def.id}/edit`)}>
              <Pencil size={14} aria-hidden /> Edit
            </Menu.Item>
          )}
          {a.clone && (
            <Menu.Item onSelect={() => void actions.clone(def)}>
              <Copy size={14} aria-hidden /> Make a copy
            </Menu.Item>
          )}
          {(a.pause || a.resume || a.close || a.archive) && (a.edit || a.clone) && <Menu.Separator />}
          {a.pause && (
            <Menu.Item onSelect={() => actions.status(def, "pause")}>
              <CirclePause size={14} aria-hidden /> Pause
            </Menu.Item>
          )}
          {a.resume && (
            <Menu.Item onSelect={() => actions.status(def, "resume")}>
              <CirclePlay size={14} aria-hidden /> Resume
            </Menu.Item>
          )}
          {a.close && (
            <Menu.Item onSelect={() => actions.status(def, "close")}>
              <XCircle size={14} aria-hidden /> Close…
            </Menu.Item>
          )}
          {a.archive && (
            <Menu.Item onSelect={() => actions.status(def, "archive")}>
              <Archive size={14} aria-hidden /> Archive…
            </Menu.Item>
          )}
          {a.remove && (
            <>
              <Menu.Separator />
              <Menu.Item danger onSelect={() => actions.remove(def)}>
                <Trash2 size={14} aria-hidden /> Delete draft…
              </Menu.Item>
            </>
          )}
        </Menu.Content>
      </Menu.Root>
    </div>
  );
}

export function Library() {
  const navigate = useNavigate();
  const { can, meta } = useCompliance();
  const [status, setStatus] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [page, setPage] = useState(0);
  const q = useDebouncedValue(search.trim(), 250);

  useEffect(() => setPage(0), [status, q, category]);

  const params = new URLSearchParams();
  if (status !== "all") params.set("status", status);
  if (q) params.set("q", q);
  if (category) params.set("category", category);
  params.set("limit", String(PAGE_SIZE));
  params.set("offset", String(page * PAGE_SIZE));

  const defs = useApi<Page<ComplianceDef>>(`/compliance/definitions?${params.toString()}`);
  const cats = useApi<string[]>("/compliance/categories");
  const actions = useDefinitionActions(defs.reload);

  const typeName = (key: string) => meta?.types.find((t) => t.key === key)?.name ?? key;
  const canCreate = can("compliance", "create");
  const filtered = status !== "all" || Boolean(q) || Boolean(category);
  const clear = () => {
    setStatus("all");
    setSearch("");
    setCategory("");
  };

  const open = (d: ComplianceDef) => navigate(`/compliance/library/${d.id}`);

  const columns: Column<ComplianceDef>[] = [
    {
      key: "name",
      header: "Compliance",
      sortValue: (d) => d.name.toLowerCase(),
      cell: (d) => (
        <div className="min-w-0 max-w-[420px]">
          <div className="font-semibold text-ink truncate">{d.name}</div>
          <div className="text-xs text-ink2 truncate">
            {[d.category, typeName(d.type_key)].filter(Boolean).join(" · ")}
          </div>
        </div>
      ),
    },
    { key: "status", header: "Status", sortValue: (d) => d.status, cell: (d) => <DefinitionStatusLabel status={d.status} /> },
    {
      key: "priority",
      header: "Priority",
      hideBelow: "sm",
      sortValue: (d) => ["low", "medium", "high", "critical"].indexOf(d.priority),
      cell: (d) => <PriorityLabel priority={d.priority} />,
    },
    {
      key: "due",
      header: "Due",
      hideBelow: "md",
      sortValue: (d) => (d.due_at ? new Date(d.due_at).getTime() : null),
      cell: (d) => <DueLabel iso={d.due_at} finished={d.status === "closed" || d.status === "archived" || d.progress.satisfied} />,
    },
    {
      key: "progress",
      header: "Progress",
      hideBelow: "md",
      sortValue: (d) => (d.progress.required_total ? d.progress.percent : null),
      cell: (d) => <ProgressCell progress={d.progress} def={d} />,
    },
    { key: "review", header: "Review", hideBelow: "lg", cell: (d) => <span className="text-ink2 text-[13px]">{reviewShort(d)}</span> },
    {
      key: "owner",
      header: "Owner",
      hideBelow: "lg",
      sortValue: (d) => d.created_by?.name ?? null,
      cell: (d) => <span className="text-ink2 text-[13px]">{d.created_by?.name ?? "—"}</span>,
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      width: "48px",
      cell: (d) => <RowMenu def={d} actions={actions} />,
    },
  ];

  const total = defs.data?.total ?? 0;
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const to = Math.min(total, (page + 1) * PAGE_SIZE);
  const categories = cats.data ?? [];

  const empty = filtered ? (
    <EmptyState
      icon={SearchX}
      title="No compliance matches your filters"
      description="Try a different search, or clear the filters to see everything."
      action={<Button onClick={clear}>Clear filters</Button>}
    />
  ) : (
    <EmptyState
      icon={ClipboardList}
      title="No compliance yet"
      description={
        canCreate
          ? "Create your first compliance to ask people to do something and show proof they did it."
          : "Compliance you are asked to run, or that applies to your reports, will appear here."
      }
      action={canCreate && <Button variant="primary" leadingIcon={Plus} onClick={() => navigate("/compliance/library/new")}>New compliance</Button>}
    />
  );

  return (
    <div>
      <PageHeader
        title="Compliance library"
        description="Everything you can see or manage: what is asked, of whom, by when, and how far along it is"
        actions={
          canCreate && (
            <Button variant="primary" leadingIcon={Plus} onClick={() => navigate("/compliance/library/new")}>
              New compliance
            </Button>
          )
        }
      />

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <SegmentedControl aria-label="Status" value={status} onChange={setStatus} options={STATUS_OPTIONS} className="max-w-full overflow-x-auto" />
        <SearchInput value={search} onChange={setSearch} placeholder="Search compliance…" className="w-full sm:w-64" aria-label="Search compliance" />
        {categories.length > 0 && (
          <Select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
            <option value="">All categories</option>
            {categories.filter(Boolean).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        )}
        {defs.data && (
          <span className="ml-auto text-[13px] text-ink2 tabular" aria-live="polite">
            {total} {total === 1 ? "compliance" : "compliances"}
          </span>
        )}
      </div>

      <Card padding="none" className="overflow-hidden">
        {defs.error && !defs.data ? (
          <ErrorState message={defs.error.message} onRetry={defs.reload} />
        ) : defs.initialLoading ? (
          <TableSkeleton rows={6} columns={5} />
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={defs.data?.items ?? []}
              getRowKey={(d) => d.id}
              onRowClick={open}
              rowLabel={(d) => `Open ${d.name}`}
              loading={defs.loading}
              dim={defs.loading}
              empty={empty}
              caption="Compliance library"
            />
            {total > PAGE_SIZE && (
              <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-line text-[13px] text-ink2">
                <span className="tabular">
                  {from}–{to} of {total}
                </span>
                <div className="flex gap-2">
                  <Button size="sm" disabled={page === 0 || defs.loading} onClick={() => setPage((p) => p - 1)}>
                    Previous
                  </Button>
                  <Button size="sm" disabled={to >= total || defs.loading} onClick={() => setPage((p) => p + 1)}>
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
