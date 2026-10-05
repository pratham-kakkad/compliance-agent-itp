import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Building2, Check, Pencil, Plus, Trash2, Users2, X } from "lucide-react";
import { useApi } from "../../lib/useApi";
import type { ApiState } from "../../lib/useApi";
import { api } from "../../lib/api";
import { useCompliance } from "../../lib/ComplianceContext";
import type { AdminDepartment, AdminTeam, Lookup } from "../../lib/compliance";
import { Avatar, Banner, Button, Card, CardHeader, DataTable, EmptyState, ErrorState, IconButton, PageHeader, Select, Skeleton, Tabs, TextInput } from "../../components/ui";
import type { Column } from "../../components/ui";
import { useOverlay } from "../../components/Modal";
import { Field, errText, toastError } from "../../components/compliance/common";
import { NoAccess, PeoplePicker, PersonSelect, useConfirm, useLookup } from "../../components/compliance/admin/parts";

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

// ------------------------------------------------------------- departments

function DepartmentsPanel({ depts, reload }: { depts: ApiState<AdminDepartment[]>; reload: () => void }) {
  const { can } = useCompliance();
  const confirm = useConfirm();
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [renaming, setRenaming] = useState(false);

  const canCreate = can("team", "create");
  const canEdit = can("team", "edit");
  const canDelete = can("team", "delete");

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setAdding(true);
    try {
      await api.post("/compliance/admin/departments", { name: name.trim() });
      toast.success(`Department "${name.trim()}" added`);
      setName("");
      reload();
    } catch (err) {
      toastError("Couldn't add the department", err);
    } finally {
      setAdding(false);
    }
  }

  async function rename(d: AdminDepartment) {
    if (!draft.trim() || draft.trim() === d.name) {
      setEditing(null);
      return;
    }
    setRenaming(true);
    try {
      await api.patch(`/compliance/admin/departments/${d.id}`, { name: draft.trim() });
      toast.success("Department renamed");
      setEditing(null);
      reload();
    } catch (err) {
      toastError("Couldn't rename the department", err);
    } finally {
      setRenaming(false);
    }
  }

  function remove(d: AdminDepartment) {
    confirm({
      title: `Delete the ${d.name} department?`,
      description: (
        <p>
          {d.members > 0 ? `${d.members} ${d.members === 1 ? "person is" : "people are"} in it and will be left without a department. ` : ""}
          Teams linked to it keep existing but lose the link. This can't be undone.
        </p>
      ),
      confirm: "Delete department",
      onConfirm: async () => {
        await api.delete(`/compliance/admin/departments/${d.id}`);
        toast.success(`Department "${d.name}" deleted`);
        reload();
      },
    });
  }

  const columns: Column<AdminDepartment>[] = [
    {
      key: "name",
      header: "Department",
      sortValue: (d) => d.name.toLowerCase(),
      cell: (d) =>
        editing === d.id ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void rename(d);
            }}
            className="flex items-center gap-1.5"
          >
            <TextInput
              aria-label={`New name for ${d.name}`}
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setEditing(null)}
              size="sm"
              className="w-56 max-w-full"
            />
            <IconButton icon={Check} label="Save name" type="submit" variant="secondary" size="sm" disabled={renaming || !draft.trim()} />
            <IconButton icon={X} label="Cancel rename" size="sm" onClick={() => setEditing(null)} />
          </form>
        ) : (
          <span className="font-semibold text-ink">{d.name}</span>
        ),
    },
    { key: "members", header: "People", align: "right", sortValue: (d) => d.members, cell: (d) => <span className="tabular text-ink2">{d.members}</span> },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      width: "96px",
      cell: (d) => (
        <div className="flex justify-end gap-1">
          {canEdit && <IconButton icon={Pencil} label={`Rename ${d.name}`} size="sm" onClick={() => { setEditing(d.id); setDraft(d.name); }} />}
          {canDelete && <IconButton icon={Trash2} label={`Delete ${d.name}`} size="sm" onClick={() => remove(d)} />}
        </div>
      ),
    },
  ];

  return (
    <Card padding="none" className="overflow-hidden">
      <div className="p-4 pb-3">
        <CardHeader title="Departments" description="Used for scoping access ('everyone in my department') and for reporting." className="!mb-0" />
      </div>
      {canCreate && (
        <form onSubmit={(e) => void add(e)} className="flex flex-wrap items-center gap-2 px-4 pb-4">
          <TextInput aria-label="New department name" placeholder="New department name" value={name} onChange={(e) => setName(e.target.value)} className="w-full sm:w-72" />
          <Button type="submit" variant="primary" leadingIcon={Plus} loading={adding} disabled={!name.trim()}>
            Add department
          </Button>
        </form>
      )}
      <div className="border-t border-line">
        {depts.error && !depts.data ? (
          <ErrorState message={depts.error.message} onRetry={depts.reload} />
        ) : (
          <DataTable
            caption="Departments"
            columns={columns}
            rows={depts.data ?? []}
            getRowKey={(d) => d.id}
            loading={depts.initialLoading}
            dim={depts.loading && !depts.initialLoading}
            defaultSort={{ key: "name", dir: "asc" }}
            skeletonRows={4}
            empty={<EmptyState icon={Building2} title="No departments yet" description={canCreate ? "Add the first one above." : "An administrator can add departments."} />}
          />
        )}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------- teams

function TeamDialog({ team, onSaved }: { team?: AdminTeam; onSaved: () => void }) {
  const { close } = useOverlay();
  const { can } = useCompliance();
  const canMembers = can("team", "edit");
  const lookup = useLookup();
  const [savedId, setSavedId] = useState<string | null>(team?.id ?? null);
  const [name, setName] = useState(team?.name ?? "");
  const [department, setDepartment] = useState(team?.department_id ?? "");
  const [lead, setLead] = useState(team?.lead_email ?? "");
  const [members, setMembers] = useState<string[]>(team?.members ?? []);
  const [baseMembers, setBaseMembers] = useState<string[]>(team?.members ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    const body = { name: name.trim(), department_id: department || null, lead_email: lead || null };
    try {
      const saved = savedId ? await api.patch<AdminTeam>(`/compliance/admin/teams/${savedId}`, body) : await api.post<AdminTeam>("/compliance/admin/teams", body);
      setSavedId(saved.id);
      onSaved();
      if (canMembers && !sameSet(members, baseMembers)) {
        try {
          await api.put(`/compliance/admin/teams/${saved.id}/members`, { emails: members });
          setBaseMembers(members);
        } catch (err) {
          setError(`The team was saved, but its members weren't: ${errText(err)}`);
          setBusy(false);
          return;
        }
      }
      toast.success(team ? "Team updated" : `Team "${name.trim()}" created`);
      close();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      <div className="pr-6">
        <h2 className="text-lg font-semibold text-ink">{team ? `Edit ${team.name}` : "New team"}</h2>
        <p className="text-sm text-ink2 mt-1">Team members can be given access to each other's compliance records ("my teams" scope).</p>
      </div>
      <Field label="Team name" required>
        {(id) => <TextInput id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />}
      </Field>

      {lookup.error && !lookup.data ? (
        <Banner tone="warn" title="Couldn't load people and departments" action={<Button size="sm" onClick={lookup.reload}>Retry</Button>}>
          {lookup.error.message}
        </Banner>
      ) : (
        <>
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="Department">
              {(id) =>
                lookup.initialLoading ? (
                  <Skeleton className="h-8 w-full" />
                ) : (
                  <Select id={id} value={department} onChange={(e) => setDepartment(e.target.value)} className="w-full" options={[{ value: "", label: "No department" }, ...(lookup.data?.departments ?? []).map((d) => ({ value: d.id, label: d.name }))]} />
                )
              }
            </Field>
            <Field label="Team lead">
              {(id) => (lookup.initialLoading ? <Skeleton className="h-8 w-full" /> : <PersonSelect id={id} value={lead} onChange={setLead} users={lookup.data?.users ?? []} none="No lead" />)}
            </Field>
          </div>
          {canMembers && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-semibold text-ink">Members</span>
              {lookup.initialLoading ? <Skeleton className="h-40 w-full" /> : <PeoplePicker label="Team members" people={lookup.data?.users ?? []} value={members} onChange={setMembers} />}
            </div>
          )}
        </>
      )}

      {error && (
        <p role="alert" className="text-sm text-crit">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={close} disabled={busy}>
          {savedId && !team ? "Close" : "Cancel"}
        </Button>
        <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>
          {team || savedId ? "Save team" : "Create team"}
        </Button>
      </div>
    </form>
  );
}

function TeamsPanel({ teams, depts, lookup, reload }: { teams: ApiState<AdminTeam[]>; depts: AdminDepartment[]; lookup: Lookup | null; reload: () => void }) {
  const { can } = useCompliance();
  const { openModal } = useOverlay();
  const confirm = useConfirm();
  const canCreate = can("team", "create");
  const canEdit = can("team", "edit");
  const canDelete = can("team", "delete");

  const people = useMemo(() => new Map((lookup?.users ?? []).map((u) => [u.email, u.name])), [lookup]);
  const deptName = useMemo(() => new Map(depts.map((d) => [d.id, d.name])), [depts]);
  const who = (email: string) => people.get(email) ?? email;

  function remove(t: AdminTeam) {
    confirm({
      title: `Delete the ${t.name} team?`,
      description: <p>The people in it are not affected, but anything scoped to "my teams" stops reaching them through this team. This can't be undone.</p>,
      confirm: "Delete team",
      onConfirm: async () => {
        await api.delete(`/compliance/admin/teams/${t.id}`);
        toast.success(`Team "${t.name}" deleted`);
        reload();
      },
    });
  }

  const columns: Column<AdminTeam>[] = [
    { key: "name", header: "Team", sortValue: (t) => t.name.toLowerCase(), cell: (t) => <span className="font-semibold text-ink">{t.name}</span> },
    {
      key: "dept",
      header: "Department",
      hideBelow: "sm",
      sortValue: (t) => (t.department_id ? deptName.get(t.department_id) : null),
      cell: (t) => (t.department_id ? <span className="text-[13px]">{deptName.get(t.department_id) ?? "—"}</span> : <span className="text-ink3">—</span>),
    },
    {
      key: "lead",
      header: "Lead",
      hideBelow: "md",
      sortValue: (t) => (t.lead_email ? who(t.lead_email) : null),
      cell: (t) =>
        t.lead_email ? (
          <div className="flex items-center gap-2 min-w-0">
            <Avatar name={who(t.lead_email)} size={22} />
            <span className="text-[13px] truncate">{who(t.lead_email)}</span>
          </div>
        ) : (
          <span className="text-ink3">—</span>
        ),
    },
    {
      key: "members",
      header: "Members",
      sortValue: (t) => t.members.length,
      cell: (t) =>
        t.members.length === 0 ? (
          <span className="text-ink3 text-[13px]">No members</span>
        ) : (
          <div className="flex items-center gap-2" title={t.members.map(who).join(", ")}>
            <div className="flex">
              {t.members.slice(0, 4).map((m) => (
                <Avatar key={m} name={who(m)} size={24} className="-ml-1.5 first:ml-0 ring-2 ring-[var(--surface)]" />
              ))}
            </div>
            <span className="text-[13px] text-ink2 tabular">{t.members.length}</span>
          </div>
        ),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      width: "130px",
      cell: (t) => (
        <div className="flex justify-end gap-1">
          {canEdit && (
            <Button size="sm" leadingIcon={Pencil} onClick={() => openModal(<TeamDialog team={t} onSaved={reload} />)} aria-label={`Edit ${t.name}`}>
              Edit
            </Button>
          )}
          {canDelete && <IconButton icon={Trash2} label={`Delete ${t.name}`} size="sm" onClick={() => remove(t)} className="h-7" />}
        </div>
      ),
    },
  ];

  return (
    <Card padding="none" className="overflow-hidden">
      <div className="p-4 pb-3">
        <CardHeader
          title="Teams"
          description="Groups of people with an optional lead, used for scoping access and for reporting."
          className="!mb-0"
          actions={
            canCreate && (
              <Button variant="primary" leadingIcon={Plus} onClick={() => openModal(<TeamDialog onSaved={reload} />)}>
                New team
              </Button>
            )
          }
        />
      </div>
      <div className="border-t border-line">
        {teams.error && !teams.data ? (
          <ErrorState message={teams.error.message} onRetry={teams.reload} />
        ) : (
          <DataTable
            caption="Teams"
            columns={columns}
            rows={teams.data ?? []}
            getRowKey={(t) => t.id}
            loading={teams.initialLoading}
            dim={teams.loading && !teams.initialLoading}
            defaultSort={{ key: "name", dir: "asc" }}
            skeletonRows={4}
            empty={<EmptyState icon={Users2} title="No teams yet" description={canCreate ? "Create a team to group people together." : "An administrator can create teams."} action={canCreate ? <Button variant="primary" size="sm" leadingIcon={Plus} onClick={() => openModal(<TeamDialog onSaved={reload} />)}>New team</Button> : undefined} />}
          />
        )}
      </div>
    </Card>
  );
}

// -------------------------------------------------------------------- page

export function AdminOrg() {
  const { can, ready } = useCompliance();
  const [tab, setTab] = useState<"departments" | "teams">("departments");
  const allowed = can("team", "view");
  const depts = useApi<AdminDepartment[]>(allowed ? "/compliance/admin/departments" : null);
  const teams = useApi<AdminTeam[]>(allowed ? "/compliance/admin/teams" : null);
  const lookup = useLookup(allowed);

  if (!ready) {
    return (
      <div>
        <PageHeader title="Teams & departments" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (!allowed) return <div><PageHeader title="Teams & departments" /><NoAccess what="manage teams and departments" /></div>;

  return (
    <div>
      <PageHeader title="Teams & departments" description="Organize people into departments and teams. Both can be used to decide whose compliance records someone can see." />
      <Tabs
        aria-label="Organization"
        value={tab}
        onChange={setTab}
        className="mb-4"
        items={[
          { value: "departments", label: "Departments", icon: Building2, count: depts.data?.length },
          { value: "teams", label: "Teams", icon: Users2, count: teams.data?.length },
        ]}
      />
      <div role="tabpanel" aria-label={tab === "departments" ? "Departments" : "Teams"}>
        {tab === "departments" ? (
          <DepartmentsPanel depts={depts} reload={() => { depts.reload(); teams.reload(); lookup.reload(); }} />
        ) : (
          <TeamsPanel teams={teams} depts={depts.data ?? []} lookup={lookup.data} reload={() => { teams.reload(); lookup.reload(); }} />
        )}
      </div>
    </div>
  );
}
