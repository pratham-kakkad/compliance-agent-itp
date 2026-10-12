import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlarmClock, Archive, CirclePause, CirclePlay, ClipboardList, Copy, Flame, Pencil, Plus, Trash2, XCircle, MoreHorizontal } from "lucide-react";
import { Button, Card, DataTable, ErrorState, FilterBar, FilterEmpty, IconButton, Menu, PageHeader, TableSkeleton, type Column, type QuickFilter } from "../../components/ui";
import { DefinitionStatusLabel, PriorityLabel, ProgressCell, DueLabel } from "../../components/compliance/common";
import { availableActions, useDefinitionActions } from "../../components/compliance/library/actions";
import { reviewShort } from "../../components/compliance/library/describe";
import { useCompliance } from "../../lib/ComplianceContext";
import { useApi } from "../../lib/useApi";
import { api } from "../../lib/api";
import { downloadCsv, type CsvColumn } from "../../lib/csv";
import { useListFilters, type FilterField, type SortDef } from "../../lib/useListFilters";
import { DEFINITION_STATUS_LABEL, PRIORITY_LABEL, type ComplianceDef, type DefinitionStatus, type Page, type Priority } from "../../lib/compliance";

const PAGE_SIZE = 50;

const STATUSES = Object.keys(DEFINITION_STATUS_LABEL) as DefinitionStatus[];
const PRIORITIES = Object.keys(PRIORITY_LABEL) as Priority[];

// The server filters and sorts (GET /compliance/definitions); these keys are its `sort` values.
const SORTS: SortDef<ComplianceDef>[] = [
  { key: "created", label: "Newest", value: (d) => d.created_at, firstDir: "desc" },
  { key: "name", label: "Name", value: (d) => d.name.toLowerCase() },
  { key: "status", label: "Status", value: (d) => STATUSES.indexOf(d.status) },
  { key: "priority", label: "Priority", value: (d) => PRIORITIES.indexOf(d.priority), firstDir: "desc" },
  { key: "due", label: "Due date", value: (d) => d.due_at },
  { key: "progress", label: "Progress", value: (d) => (d.progress.required_total ? d.progress.percent : null) },
  { key: "owner", label: "Owner", value: (d) => d.created_by?.name ?? null },
];

const QUICK: QuickFilter[] = [
  { id: "active", label: "Active", field: "status", value: "published" },
  { id: "draft", label: "Drafts", field: "status", value: "draft" },
  { id: "overdue", label: "Overdue", icon: AlarmClock, field: "overdue" },
  { id: "critical", label: "Critical priority", icon: Flame, field: "priority", value: "critical" },
  { id: "month", label: "Due this month", field: "due", value: "month" },
];

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
  const [page, setPage] = useState(0);

  const cats = useApi<string[]>("/compliance/categories");
  const owners = useApi<{ email: string; name: string }[]>("/compliance/owners");
  // The size of the whole library, for "23 of 104".
  const everything = useApi<Page<ComplianceDef>>("/compliance/definitions?limit=1");

  const typeName = (key: string) => meta?.types.find((t) => t.key === key)?.name ?? key;

  const fields = useMemo<FilterField<ComplianceDef>[]>(
    () => [
      { type: "multi", key: "status", label: "Status", options: STATUSES.map((s) => ({ value: s, label: DEFINITION_STATUS_LABEL[s] })) },
      { type: "multi", key: "priority", label: "Priority", options: PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] })) },
      { type: "multi", key: "category", label: "Category", options: (cats.data ?? []).filter(Boolean).map((c) => ({ value: c, label: c })) },
      {
        type: "multi",
        key: "type",
        label: "Type",
        param: "type_key",
        options: (meta?.types ?? []).map((t) => ({ value: t.key, label: t.name })),
      },
      { type: "multi", key: "owner", label: "Owner", options: (owners.data ?? []).map((o) => ({ value: o.email, label: o.name })) },
      {
        type: "date",
        key: "due",
        label: "Due date",
        presets: ["today", "thisweek", "month", "next7", "next30", "custom"],
      },
      { type: "range", key: "progress", label: "Progress", suffix: "%", min: 0, max: 100, hint: "Share of the required people who have finished." },
      {
        type: "toggle",
        key: "overdue",
        label: "Overdue only",
        hint: "Active, past the deadline and not yet met.",
      },
      { type: "toggle", key: "has_review", label: "Has a reviewer", hint: "Evidence is checked before it counts.", chip: (() => "Has a reviewer") as never },
    ],
    [cats.data, owners.data, meta]
  );

  const lf = useListFilters<ComplianceDef>({
    id: "compliance-library",
    fields,
    sorts: SORTS,
    defaultSort: { key: "created", dir: "desc" },
  });

  const baseParams = lf.serverParams().toString();
  // Back to the first page whenever the filters or sort change.
  useEffect(() => setPage(0), [baseParams]);

  const params = new URLSearchParams(baseParams);
  params.set("limit", String(PAGE_SIZE));
  params.set("offset", String(page * PAGE_SIZE));

  const defs = useApi<Page<ComplianceDef>>(`/compliance/definitions?${params.toString()}`);
  const actions = useDefinitionActions(defs.reload);

  const canCreate = can("compliance", "create");

  const csvColumns: CsvColumn<ComplianceDef>[] = [
    { header: "Compliance", value: (c) => c.name },
    { header: "Category", value: (c) => c.category },
    { header: "Type", value: (c) => typeName(c.type_key) },
    { header: "Status", value: (c) => DEFINITION_STATUS_LABEL[c.status] },
    { header: "Priority", value: (c) => PRIORITY_LABEL[c.priority] },
    { header: "Due", value: (c) => c.due_at },
    { header: "Progress (%)", value: (c) => (c.progress.required_total ? c.progress.percent : "") },
    { header: "Completed", value: (c) => c.progress.completed },
    { header: "Required people", value: (c) => c.progress.required_total },
    { header: "Owner", value: (c) => c.created_by?.name },
  ];
  // Every matching row, not just the page on screen.
  async function exportAll(): Promise<number> {
    const rows: ComplianceDef[] = [];
    for (let offset = 0; offset < 5000; offset += 500) {
      const p = new URLSearchParams(baseParams);
      p.set("limit", "500");
      p.set("offset", String(offset));
      const res = await api.get<Page<ComplianceDef>>(`/compliance/definitions?${p.toString()}`);
      rows.push(...res.items);
      if (rows.length >= res.total || res.items.length === 0) break;
    }
    downloadCsv("compliance-library", csvColumns, rows);
    return rows.length;
  }

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

  const empty = (
    <FilterEmpty
      lf={lf}
      icon={ClipboardList}
      emptyTitle="No compliance yet"
      emptyDescription={
        canCreate
          ? "Create your first compliance to ask people to do something and show proof they did it."
          : "Compliance you are asked to run, or that applies to your reports, will appear here."
      }
      emptyAction={canCreate && <Button variant="primary" leadingIcon={Plus} onClick={() => navigate("/compliance/library/new")}>New compliance</Button>}
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

      <FilterBar
        lf={lf}
        noun={["compliance", "compliances"]}
        total={everything.data?.total}
        shown={defs.data ? total : undefined}
        quick={QUICK}
        searchPlaceholder="Search compliance…"
        onExport={exportAll}
      />

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
              sort={lf.sort}
              onSortChange={lf.setSort}
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
