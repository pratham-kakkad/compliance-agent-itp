import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Info, UserPlus, Users } from "lucide-react";
import { useApi } from "../../lib/useApi";
import { api } from "../../lib/api";
import { useCompliance } from "../../lib/ComplianceContext";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import type { AdminRole, AdminUser } from "../../lib/compliance";
import { Avatar, Banner, Button, Card, DataTable, EmptyState, ErrorState, Label, PageHeader, SearchInput, SegmentedControl, Select, Skeleton, TextInput } from "../../components/ui";
import type { Column } from "../../components/ui";
import { useOverlay } from "../../components/Modal";
import { Field, errText } from "../../components/compliance/common";
import { NoAccess, PersonSelect, RoleChecklist, useLookup } from "../../components/compliance/admin/parts";

type UsersResponse = { total: number; items: AdminUser[] };

const userPath = (email: string) => `/compliance/admin/users/${encodeURIComponent(email)}`;

// ------------------------------------------------------------- add dialog

function AddUserDialog({ onCreated }: { onCreated: () => void }) {
  const { close } = useOverlay();
  const { can, me } = useCompliance();
  const canRoles = can("role", "configure");
  const lookup = useLookup();
  const roles = useApi<AdminRole[]>(canRoles ? "/compliance/admin/roles" : null);

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [manager, setManager] = useState("");
  const [department, setDepartment] = useState("");
  const [roleKeys, setRoleKeys] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const explicitRoles = useMemo(() => (roles.data ?? []).filter((r) => r.auto_assign === null), [roles.data]);
  const lockedKeys = useMemo(() => (me?.is_super ? [] : explicitRoles.filter((r) => r.is_super).map((r) => r.key)), [me, explicitRoles]);
  const emailOk = /^\S+@\S+$/.test(email.trim());
  const ready = emailOk && name.trim().length > 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await api.post("/compliance/admin/users", {
        email: email.trim().toLowerCase(),
        name: name.trim(),
        title: title.trim(),
        manager_email: manager || null,
        department_id: department || null,
        role_keys: canRoles ? roleKeys : [],
      });
      toast.success(`${name.trim()} added`, { description: "They can sign in with their Microsoft work account." });
      onCreated();
      close();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      <div className="pr-6">
        <h2 className="text-lg font-semibold text-ink">Add a user</h2>
        <p className="text-sm text-ink2 mt-1">Pre-provision someone so they have the right access the first time they sign in.</p>
      </div>

      <Field label="Work e-mail" required hint="Must match the Microsoft account they sign in with.">
        {(id) => <TextInput id={id} type="email" autoFocus autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />}
      </Field>
      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Full name" required>
          {(id) => <TextInput id={id} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />}
        </Field>
        <Field label="Job title">
          {(id) => <TextInput id={id} value={title} onChange={(e) => setTitle(e.target.value)} autoComplete="off" />}
        </Field>
      </div>

      {lookup.error && !lookup.data ? (
        <Banner tone="warn" title="Couldn't load the manager and department lists" action={<Button size="sm" onClick={lookup.reload}>Retry</Button>}>
          {lookup.error.message}
        </Banner>
      ) : (
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Manager" hint="Only people you can see are listed.">
            {(id) =>
              lookup.initialLoading ? <Skeleton className="h-8 w-full" /> : <PersonSelect id={id} value={manager} onChange={setManager} users={lookup.data?.users ?? []} none="No manager" />
            }
          </Field>
          <Field label="Department">
            {(id) =>
              lookup.initialLoading ? (
                <Skeleton className="h-8 w-full" />
              ) : (
                <Select
                  id={id}
                  value={department}
                  onChange={(e) => setDepartment(e.target.value)}
                  className="w-full"
                  options={[{ value: "", label: "No department" }, ...(lookup.data?.departments ?? []).map((d) => ({ value: d.id, label: d.name }))]}
                />
              )
            }
          </Field>
        </div>
      )}

      {canRoles && (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-[13px] font-semibold text-ink mb-1">Roles</legend>
          <p className="text-xs text-ink2 -mt-0.5 mb-1">Employee and Manager are held automatically (everyone is an Employee; anyone with direct reports is a Manager), so they aren't listed.</p>
          {roles.initialLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : roles.error && !roles.data ? (
            <p className="text-sm text-crit">{roles.error.message}</p>
          ) : (
            <RoleChecklist roles={explicitRoles} value={roleKeys} onChange={setRoleKeys} lockedKeys={lockedKeys} />
          )}
        </fieldset>
      )}

      {error && (
        <p role="alert" className="text-sm text-crit">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={close} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" leadingIcon={UserPlus} loading={busy} disabled={!ready}>
          Add user
        </Button>
      </div>
    </form>
  );
}

// -------------------------------------------------------------------- page

export function AdminUsers() {
  const { can, ready } = useCompliance();
  const navigate = useNavigate();
  const { openModal } = useOverlay();
  const [q, setQ] = useState("");
  const dq = useDebouncedValue(q.trim(), 250);
  const [show, setShow] = useState<"active" | "all">("active");

  const allowed = can("user", "view");
  const path = useMemo(() => {
    const p = new URLSearchParams({ include_inactive: String(show === "all") });
    if (dq) p.set("q", dq);
    return `/compliance/admin/users?${p.toString()}`;
  }, [dq, show]);
  const { data, error, initialLoading, loading, reload } = useApi<UsersResponse>(allowed ? path : null);

  const names = useMemo(() => new Map((data?.items ?? []).map((u) => [u.email, u.name])), [data]);

  const columns: Column<AdminUser>[] = [
    {
      key: "name",
      header: "Person",
      sortValue: (u) => u.name.toLowerCase(),
      cell: (u) => (
        <div className="flex items-center gap-2.5 min-w-0">
          <Avatar name={u.name} size={32} />
          <div className="min-w-0">
            <div className="font-semibold text-ink truncate">{u.name}</div>
            <div className="text-xs text-ink2 truncate">{u.email}</div>
            {u.title && <div className="text-xs text-ink3 truncate">{u.title}</div>}
          </div>
        </div>
      ),
    },
    { key: "department", header: "Department", hideBelow: "md", sortValue: (u) => u.department, cell: (u) => (u.department ? <span className="text-[13px] text-ink">{u.department}</span> : <span className="text-ink3">—</span>) },
    {
      key: "manager",
      header: "Manager",
      hideBelow: "lg",
      sortValue: (u) => (u.manager_email ? names.get(u.manager_email) ?? u.manager_email : null),
      cell: (u) => (u.manager_email ? <span className="text-[13px] text-ink">{names.get(u.manager_email) ?? u.manager_email}</span> : <span className="text-ink3">—</span>),
    },
    {
      key: "roles",
      header: "Roles",
      hideBelow: "sm",
      cell: (u) =>
        u.roles.length === 0 ? (
          <span className="text-[13px] text-ink3">Default access</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {u.roles.slice(0, 3).map((r) => (
              <Label key={r.key} size="sm" tone={r.key === "super_admin" ? "accent" : "neutral"}>
                {r.name}
              </Label>
            ))}
            {u.roles.length > 3 && <Label size="sm" variant="outline">+{u.roles.length - 3}</Label>}
          </div>
        ),
    },
    {
      key: "status",
      header: "Status",
      sortValue: (u) => (u.is_active ? 0 : 1),
      cell: (u) => (
        <div className="flex flex-wrap items-center gap-1">
          {u.is_active ? <Label tone="good" size="sm" dot>Active</Label> : <Label tone="neutral" size="sm" dot>Deactivated</Label>}
          {u.is_demo && <Label tone="accent" variant="outline" size="sm">Demo</Label>}
        </div>
      ),
    },
  ];

  if (!ready) {
    return (
      <div>
        <PageHeader title="Users" />
        <Card padding="none">
          <DataTable columns={columns} rows={[]} getRowKey={(u) => u.email} loading />
        </Card>
      </div>
    );
  }
  if (!allowed) return <div><PageHeader title="Users" /><NoAccess what="manage users" /></div>;

  const hasFilter = Boolean(dq) || show === "all";

  return (
    <div>
      <PageHeader
        title="Users"
        description="Everyone who can sign in, their place in the organization and the roles they hold."
        actions={
          can("user", "create") && (
            <Button variant="primary" leadingIcon={UserPlus} onClick={() => openModal(<AddUserDialog onCreated={reload} />)}>
              Add user
            </Button>
          )
        }
      />

      <Banner icon={Info} className="mb-4">
        People sign in with their Microsoft work account (or the demo login); there are no local passwords. Adding a user pre-provisions them: their roles, manager and department are
        ready the first time they sign in.
      </Banner>

      <Card padding="none" className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 p-3 border-b border-line">
          <SearchInput value={q} onChange={setQ} placeholder="Search name, e-mail or title…" aria-label="Search users" className="w-full sm:w-72" />
          <SegmentedControl
            aria-label="Which users to show"
            value={show}
            onChange={setShow}
            options={[
              { value: "active", label: "Active" },
              { value: "all", label: "All" },
            ]}
          />
          {data && (
            <span className="text-[13px] text-ink2 sm:ml-auto" aria-live="polite">
              {data.total} {data.total === 1 ? "person" : "people"}
            </span>
          )}
        </div>

        {error && !data ? (
          <ErrorState message={error.message} onRetry={reload} />
        ) : (
          <DataTable
            caption="Users"
            columns={columns}
            rows={data?.items ?? []}
            getRowKey={(u) => u.email}
            loading={initialLoading}
            dim={loading && !initialLoading}
            defaultSort={{ key: "name", dir: "asc" }}
            onRowClick={(u) => navigate(userPath(u.email))}
            rowLabel={(u) => `Open ${u.name}`}
            empty={
              <EmptyState
                icon={Users}
                title={hasFilter ? "No one matches" : "No users yet"}
                description={hasFilter ? "Try a different search, or show deactivated users too." : "Add the first user to get started."}
                action={
                  hasFilter ? (
                    <Button
                      size="sm"
                      onClick={() => {
                        setQ("");
                        setShow("active");
                      }}
                    >
                      Clear filters
                    </Button>
                  ) : undefined
                }
              />
            }
          />
        )}
      </Card>
    </div>
  );
}
