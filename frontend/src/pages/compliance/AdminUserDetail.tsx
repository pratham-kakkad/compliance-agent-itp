import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";
import { ArrowLeft, Eye, Plus, Trash2, UserCheck, UserX } from "lucide-react";
import { useApi } from "../../lib/useApi";
import { api } from "../../lib/api";
import { useCompliance } from "../../lib/ComplianceContext";
import { STATUS_LABEL } from "../../lib/compliance";
import type { AdminRole, AdminUserDetail as UserDetail, Obligation, ObligationStatus } from "../../lib/compliance";
import { Avatar, Banner, Button, Card, CardHeader, DataTable, EmptyState, ErrorState, IconButton, Label, PageHeader, Select, Skeleton, TextInput } from "../../components/ui";
import type { Column } from "../../components/ui";
import { DueLabel, Field, ObligationStatusLabel, PriorityLabel, toastError } from "../../components/compliance/common";
import { Chip, NoAccess, PersonSelect, RoleChecklist, ACTION_ORDER, actionLabel, humanize, scopeShort, SCOPE_ORDER, useConfirm, useLookup } from "../../components/compliance/admin/parts";

const userPath = (email: string) => `/compliance/admin/users/${encodeURIComponent(email)}`;
const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

type Access = { email: string; is_super: boolean; roles: { key: string; name: string }[]; permissions: Record<string, Record<string, string[]>> };

// ----------------------------------------------------------------- profile

function ProfileCard({ user, onSaved }: { user: UserDetail; onSaved: () => void }) {
  const { can } = useCompliance();
  const canEdit = can("user", "edit");
  const lookup = useLookup(canEdit);
  const [name, setName] = useState(user.name);
  const [title, setTitle] = useState(user.title);
  const [manager, setManager] = useState(user.manager_email ?? "");
  const [department, setDepartment] = useState(user.department_id ?? "");
  const [busy, setBusy] = useState(false);

  const dirty = name !== user.name || title !== user.title || manager !== (user.manager_email ?? "") || department !== (user.department_id ?? "");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!dirty || !name.trim()) return;
    const body: Record<string, unknown> = {};
    if (name !== user.name) body.name = name.trim();
    if (title !== user.title) body.title = title;
    if (manager !== (user.manager_email ?? "")) {
      if (manager) body.manager_email = manager;
      else body.clear_manager = true;
    }
    if (department !== (user.department_id ?? "")) {
      if (department) body.department_id = department;
      else body.clear_department = true;
    }
    setBusy(true);
    try {
      await api.patch(userPath(user.email), body);
      toast.success("Profile saved");
      onSaved();
    } catch (err) {
      toastError("Couldn't save the profile", err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="h-full">
      <CardHeader title="Profile" description={canEdit ? "Name, title and where this person sits in the organization." : "You can view but not edit this profile."} />
      <form onSubmit={(e) => void save(e)} className="flex flex-col gap-4">
        <Field label="Full name" required>
          {(id) => <TextInput id={id} value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} invalid={!name.trim()} />}
        </Field>
        <Field label="Job title">
          {(id) => <TextInput id={id} value={title} onChange={(e) => setTitle(e.target.value)} disabled={!canEdit} />}
        </Field>
        <Field label="Manager" hint="Changing the manager changes who can see and review this person's compliance.">
          {(id) =>
            lookup.initialLoading ? (
              <Skeleton className="h-8 w-full" />
            ) : (
              <PersonSelect id={id} value={manager} onChange={setManager} users={lookup.data?.users ?? []} none="No manager" exclude={user.email} disabled={!canEdit} />
            )
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
                disabled={!canEdit}
                className="w-full"
                options={[{ value: "", label: "No department" }, ...(lookup.data?.departments ?? []).map((d) => ({ value: d.id, label: d.name }))]}
              />
            )
          }
        </Field>
        {lookup.error && !lookup.data && canEdit && (
          <p className="text-xs text-crit">
            Couldn't load the manager and department lists: {lookup.error.message}{" "}
            <button type="button" onClick={lookup.reload} className="underline">
              Retry
            </button>
          </p>
        )}

        <div>
          <div className="text-[13px] font-semibold text-ink mb-1.5">Teams</div>
          {user.teams.length === 0 ? (
            <p className="text-[13px] text-ink2">Not in any team. Teams are managed under Teams &amp; departments.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {user.teams.map((t) => (
                <Chip key={t.id}>{t.name}</Chip>
              ))}
            </div>
          )}
        </div>

        {canEdit && (
          <div className="flex items-center justify-end gap-2">
            {dirty && (
              <Button
                onClick={() => {
                  setName(user.name);
                  setTitle(user.title);
                  setManager(user.manager_email ?? "");
                  setDepartment(user.department_id ?? "");
                }}
                disabled={busy}
              >
                Discard
              </Button>
            )}
            <Button type="submit" variant="primary" loading={busy} disabled={!dirty || !name.trim()}>
              Save profile
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}

// ------------------------------------------------------------------- roles

function RolesCard({ user, onSaved }: { user: UserDetail; onSaved: () => void }) {
  const { can, me } = useCompliance();
  const canView = can("role", "view");
  const canEdit = can("role", "configure");
  const roles = useApi<AdminRole[]>(canView ? "/compliance/admin/roles" : null);
  const held = useMemo(() => user.roles.map((r) => r.key), [user.roles]);
  const [sel, setSel] = useState<string[]>(held);
  const [busy, setBusy] = useState(false);
  const dirty = !sameSet(sel, held);

  const explicit = (roles.data ?? []).filter((r) => r.auto_assign === null);
  const implicit = (roles.data ?? []).filter((r) => r.auto_assign !== null);
  const locked = me?.is_super ? [] : explicit.filter((r) => r.is_super).map((r) => r.key);

  async function save() {
    setBusy(true);
    try {
      await api.put(`${userPath(user.email)}/roles`, { role_keys: sel });
      toast.success("Roles updated");
      onSaved();
    } catch (err) {
      toastError("Couldn't update roles", err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="h-full">
      <CardHeader title="Roles" description="What this person can do comes from the roles they hold, plus any overrides below." />
      {!canView ? (
        <div className="flex flex-wrap gap-1.5">
          {user.roles.length === 0 ? <p className="text-[13px] text-ink2">No extra roles.</p> : user.roles.map((r) => <Label key={r.key}>{r.name}</Label>)}
        </div>
      ) : roles.error && !roles.data ? (
        <ErrorState compact message={roles.error.message} onRetry={roles.reload} />
      ) : roles.initialLoading || !roles.data ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <RoleChecklist roles={explicit} value={sel} onChange={setSel} disabled={!canEdit || busy} lockedKeys={locked} />
          {locked.length > 0 && canEdit && <p className="text-xs text-ink2">Only a Super Admin can make someone a Super Admin.</p>}
          {implicit.length > 0 && (
            <div>
              <div className="text-[13px] font-semibold text-ink mb-1.5">Held automatically</div>
              <div className="flex flex-wrap gap-1.5">
                {implicit.map((r) => (
                  <span key={r.key} title={r.description}>
                    <Label tone="accent" variant="outline">
                      {r.name} · {r.auto_assign === "all" ? "everyone" : "anyone with direct reports"}
                    </Label>
                  </span>
                ))}
              </div>
            </div>
          )}
          {!canEdit && <p className="text-xs text-ink2">You need the Roles &amp; access "configure" permission to change roles.</p>}
          {canEdit && (
            <div className="flex items-center justify-end gap-2">
              {dirty && (
                <Button onClick={() => setSel(held)} disabled={busy}>
                  Discard
                </Button>
              )}
              <Button variant="primary" loading={busy} disabled={!dirty} onClick={() => void save()}>
                Save roles
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// --------------------------------------------------------------- overrides

type OverrideRow = { resource: string; action: string; effect: "allow" | "deny"; scope: string | null };

function OverridesCard({ user, onSaved }: { user: UserDetail; onSaved: () => void }) {
  const { can, meta } = useCompliance();
  const canEdit = can("role", "configure");
  const original = useMemo<OverrideRow[]>(() => user.overrides.map((o) => ({ ...o, scope: o.effect === "allow" ? o.scope ?? "self" : null })), [user.overrides]);
  const [rows, setRows] = useState<OverrideRow[]>(original);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resources = meta?.resources ?? [];
  const resLabel = (key: string) => resources.find((r) => r.key === key)?.label ?? humanize(key);
  const dirty = JSON.stringify(rows) !== JSON.stringify(original);

  function patch(i: number, change: Partial<OverrideRow>) {
    setError(null);
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...change } : r)));
  }

  function add() {
    const first = resources[0];
    if (!first) return;
    setError(null);
    setRows((rs) => [...rs, { resource: first.key, action: first.actions[0], effect: "allow", scope: "self" }]);
  }

  async function save() {
    const seen = new Set<string>();
    for (const r of rows) {
      const k = `${r.resource}:${r.action}`;
      if (seen.has(k)) {
        setError(`${resLabel(r.resource)} · ${actionLabel(r.action)} is listed twice. Keep one.`);
        return;
      }
      seen.add(k);
    }
    setBusy(true);
    setError(null);
    try {
      await api.put(`${userPath(user.email)}/overrides`, {
        overrides: rows.map((r) => ({ resource: r.resource, action: r.action, effect: r.effect, scope: r.effect === "allow" ? r.scope ?? "self" : null })),
      });
      toast.success("Access overrides saved");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Access overrides"
        description="Grant or take away a single permission for this person only. A deny always wins, even over a role that allows it."
        actions={
          canEdit && (
            <Button size="sm" leadingIcon={Plus} onClick={add} disabled={!meta || busy}>
              Add override
            </Button>
          )
        }
      />
      {!meta ? (
        <Skeleton className="h-16 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState compact icon={Eye} title="No overrides" description="This person's access comes entirely from their roles." />
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((r, i) => {
            const res = resources.find((x) => x.key === r.resource);
            const label = `${resLabel(r.resource)} ${actionLabel(r.action)}`;
            return (
              <li key={i} className="grid grid-cols-2 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,1.2fr)_auto] gap-2 items-center p-2 rounded-md border border-line bg-panel2">
                <Select
                  aria-label={`Override ${i + 1} resource`}
                  value={r.resource}
                  disabled={!canEdit || busy}
                  onChange={(e) => {
                    const next = resources.find((x) => x.key === e.target.value);
                    if (next) patch(i, { resource: next.key, action: next.actions.includes(r.action) ? r.action : next.actions[0] });
                  }}
                  options={resources.map((x) => ({ value: x.key, label: x.label }))}
                  className="w-full"
                />
                <Select
                  aria-label={`Override ${i + 1} action`}
                  value={r.action}
                  disabled={!canEdit || busy}
                  onChange={(e) => patch(i, { action: e.target.value })}
                  options={(res?.actions ?? [r.action]).map((a) => ({ value: a, label: actionLabel(a) }))}
                  className="w-full"
                />
                <Select
                  aria-label={`Override ${i + 1} effect`}
                  value={r.effect}
                  disabled={!canEdit || busy}
                  onChange={(e) => {
                    const effect = e.target.value as "allow" | "deny";
                    patch(i, { effect, scope: effect === "allow" ? r.scope ?? "self" : null });
                  }}
                  options={[
                    { value: "allow", label: "Allow" },
                    { value: "deny", label: "Deny" },
                  ]}
                  className="w-full"
                />
                {r.effect === "allow" ? (
                  <Select
                    aria-label={`Override ${i + 1} scope`}
                    value={r.scope ?? "self"}
                    disabled={!canEdit || busy}
                    onChange={(e) => patch(i, { scope: e.target.value })}
                    options={(meta.scopes.length ? meta.scopes.map((s) => s.key as string) : SCOPE_ORDER).map((k) => ({ value: k, label: scopeShort(k) }))}
                    className="w-full"
                  />
                ) : (
                  <span className="text-[13px] text-ink2 px-1">Blocked, whatever their roles allow</span>
                )}
                {canEdit ? (
                  <IconButton icon={Trash2} label={`Remove override: ${label}`} onClick={() => setRows((rs) => rs.filter((_, idx) => idx !== i))} disabled={busy} className="justify-self-end" />
                ) : (
                  <span />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-sm text-crit mt-3">
          {error}
        </p>
      )}
      {canEdit && (dirty || error) && (
        <div className="flex items-center justify-end gap-2 mt-3">
          <Button
            onClick={() => {
              setRows(original);
              setError(null);
            }}
            disabled={busy}
          >
            Discard
          </Button>
          <Button variant="primary" loading={busy} disabled={!dirty} onClick={() => void save()}>
            Save overrides
          </Button>
        </div>
      )}
      {!canEdit && <p className="text-xs text-ink2 mt-3">You need the Roles &amp; access "configure" permission to change overrides.</p>}
    </Card>
  );
}

// ------------------------------------------------------------------ access

function AccessCard({ email }: { email: string }) {
  const { meta } = useCompliance();
  const { data, error, initialLoading, reload } = useApi<Access>(`${userPath(email)}/access`);

  const resources = meta?.resources ?? [];
  const actions = useMemo(() => {
    const present = new Set(resources.flatMap((r) => r.actions));
    const known = ACTION_ORDER.filter((a) => present.has(a));
    return [...known, ...[...present].filter((a) => !ACTION_ORDER.includes(a)).sort()];
  }, [resources]);

  const widest = (scopes: string[]) => [...scopes].sort((a, b) => SCOPE_ORDER.indexOf(b) - SCOPE_ORDER.indexOf(a))[0];

  return (
    <Card padding="none" className="overflow-hidden">
      <div className="p-4 pb-0">
        <CardHeader
          title="What this person can do"
          description="Exactly what the system will allow them, after roles and overrides. Each cell shows how far the permission reaches."
          icon={Eye}
        />
      </div>
      {error && !data ? (
        <ErrorState compact message={error.message} onRetry={reload} />
      ) : initialLoading || !data || !meta ? (
        <div className="p-4 pt-0 flex flex-col gap-2">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : (
        <>
          <div className="px-4 pb-3 flex flex-wrap items-center gap-1.5">
            <span className="text-[13px] text-ink2 mr-1">Roles held:</span>
            {data.roles.map((r) => (
              <Label key={r.key} tone={r.key === "super_admin" ? "accent" : "neutral"} size="sm">
                {r.name}
              </Label>
            ))}
            {data.roles.length === 0 && <span className="text-[13px] text-ink3">none</span>}
          </div>
          {data.is_super && (
            <div className="px-4 pb-3">
              <Banner tone="info" title="Super Admin">
                Has every permission across the whole organization.
              </Banner>
            </div>
          )}
          <div className="overflow-x-auto border-t border-line">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">Permissions of {email}</caption>
              <thead>
                <tr className="bg-panel2 border-b border-line">
                  <th scope="col" className="sticky left-0 bg-panel2 h-9 px-4 text-left text-xs font-semibold text-ink2 whitespace-nowrap">
                    Area
                  </th>
                  {actions.map((a) => (
                    <th key={a} scope="col" className="h-9 px-2 text-left text-xs font-semibold text-ink2 whitespace-nowrap">
                      {actionLabel(a)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {resources.map((r) => (
                  <tr key={r.key} className="border-b border-line-soft last:border-0">
                    <th scope="row" className="sticky left-0 bg-panel px-4 py-2 text-left font-medium text-ink whitespace-nowrap">
                      {r.label}
                      {r.navigation_only && <span className="ml-2 text-[11px] text-ink3 font-normal">menu only</span>}
                    </th>
                    {actions.map((a) => {
                      if (!r.actions.includes(a)) {
                        return (
                          <td key={a} className="px-2 py-2 text-ink3" aria-label="Not applicable">
                            <span aria-hidden>·</span>
                          </td>
                        );
                      }
                      const scopes = data.permissions[r.key]?.[a];
                      if (!scopes || scopes.length === 0) {
                        return (
                          <td key={a} className="px-2 py-2 text-ink3" aria-label="No access">
                            <span aria-hidden>—</span>
                          </td>
                        );
                      }
                      return (
                        <td key={a} className="px-2 py-2">
                          <span title={scopes.map(scopeShort).join(", ")}>
                            <Label tone="good" size="sm">
                              {scopeShort(widest(scopes))}
                            </Label>
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}

// ----------------------------------------------------------------- history

function HistoryCard({ user }: { user: UserDetail }) {
  const { counts, items } = user.history;
  const finished = (o: Obligation) => ["completed", "waived", "cancelled"].includes(o.status);
  const columns: Column<Obligation>[] = [
    {
      key: "name",
      header: "Compliance",
      cell: (o) => (
        <Link to={`/compliance/obligations/${o.id}`} className="font-semibold text-ink hover:text-accent hover:underline">
          {o.compliance.name}
        </Link>
      ),
    },
    { key: "priority", header: "Priority", hideBelow: "sm", cell: (o) => <PriorityLabel priority={o.compliance.priority} /> },
    { key: "status", header: "Status", cell: (o) => <ObligationStatusLabel o={o} size="sm" /> },
    { key: "due", header: "Due", hideBelow: "sm", cell: (o) => <DueLabel iso={o.due_at} finished={finished(o)} /> },
  ];
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);

  return (
    <Card padding="none" className="overflow-hidden">
      <div className="p-4 pb-3">
        <CardHeader title="Compliance history" description="Items assigned to this person that you are allowed to see." className="!mb-3" />
        {entries.length > 0 && (
          <div className="flex flex-wrap gap-2" aria-label="Items by status">
            {entries.map(([status, n]) => (
              <Label key={status} tone={status === "completed" ? "good" : status === "rejected" ? "warn" : "neutral"}>
                {STATUS_LABEL[status as ObligationStatus] ?? humanize(status)} · {n}
              </Label>
            ))}
          </div>
        )}
      </div>
      <div className="border-t border-line">
        <DataTable
          caption="Recent compliance items"
          columns={columns}
          rows={items}
          getRowKey={(o) => o.id}
          dense
          empty={<EmptyState compact title="No compliance items" description="Nothing has been assigned to this person, or you can't see it." />}
        />
      </div>
      {items.length >= 30 && <p className="text-xs text-ink2 px-4 py-2 border-t border-line">Showing the 30 most recent items.</p>}
    </Card>
  );
}

// -------------------------------------------------------------------- page

export function AdminUserDetail() {
  const { email: param } = useParams();
  const email = param ?? "";
  const { can, ready, me, reload: reloadMe } = useCompliance();
  const confirm = useConfirm();
  const allowed = can("user", "view");
  const { data, error, initialLoading, reload } = useApi<UserDetail>(allowed && email ? userPath(email) : null);

  const isSelf = (me?.user?.email ?? "").toLowerCase() === email.toLowerCase();
  const refresh = () => {
    reload();
    if (isSelf) void reloadMe();
  };

  const back = (
    <Link to="/compliance/admin/users" className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline">
      <ArrowLeft size={14} aria-hidden /> All users
    </Link>
  );

  if (!ready) {
    return (
      <div>
        <PageHeader title="User" breadcrumbs={[{ label: "Users", to: "/compliance/admin/users" }, { label: email }]} />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (!allowed) return <div><PageHeader title="User" /><NoAccess what="manage users" /></div>;

  if (error && !data) {
    return (
      <div>
        <PageHeader title="User" breadcrumbs={[{ label: "Users", to: "/compliance/admin/users" }, { label: email }]} />
        <Card>
          <ErrorState message={error.message} onRetry={reload} />
          <div className="flex justify-center pb-4">{back}</div>
        </Card>
      </div>
    );
  }
  if (initialLoading || !data) {
    return (
      <div>
        <PageHeader title="User" breadcrumbs={[{ label: "Users", to: "/compliance/admin/users" }, { label: email }]} />
        <div className="grid lg:grid-cols-2 gap-4" aria-busy="true">
          <Card><Skeleton className="h-72 w-full" /></Card>
          <Card><Skeleton className="h-72 w-full" /></Card>
        </div>
      </div>
    );
  }

  const user = data;
  const canDeactivate = can("user", "delete") && !(isSelf && user.is_active);

  function toggleActive() {
    if (user.is_active) {
      confirm({
        title: `Deactivate ${user.name}?`,
        description: (
          <>
            <p>They will no longer be able to sign in or appear in pickers.</p>
            <p>
              <strong className="text-ink">Their open compliance items will be cancelled</strong> (anything not started, in progress, submitted or under review). Completed items are kept.
            </p>
          </>
        ),
        confirm: "Deactivate",
        onConfirm: async () => {
          await api.patch(userPath(user.email), { is_active: false });
          toast.success(`${user.name} deactivated`);
          refresh();
        },
      });
    } else {
      confirm({
        title: `Reactivate ${user.name}?`,
        description: <p>They will be able to sign in again. Compliance items cancelled when they were deactivated stay cancelled.</p>,
        confirm: "Reactivate",
        tone: "primary",
        onConfirm: async () => {
          await api.patch(userPath(user.email), { is_active: true });
          toast.success(`${user.name} reactivated`);
          refresh();
        },
      });
    }
  }

  return (
    <div>
      <PageHeader
        title={user.name}
        breadcrumbs={[{ label: "Users", to: "/compliance/admin/users" }, { label: user.name }]}
        description={
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <Avatar name={user.name} size={20} />
            <span>
              {user.email}
              {user.title ? ` · ${user.title}` : ""}
              {user.department ? ` · ${user.department}` : ""}
            </span>
            {user.is_active ? <Label tone="good" size="sm" dot>Active</Label> : <Label tone="neutral" size="sm" dot>Deactivated</Label>}
            {user.is_demo && <Label tone="accent" variant="outline" size="sm">Demo</Label>}
          </span>
        }
        actions={
          canDeactivate && (
            <Button variant={user.is_active ? "danger" : "secondary"} leadingIcon={user.is_active ? UserX : UserCheck} onClick={toggleActive}>
              {user.is_active ? "Deactivate" : "Reactivate"}
            </Button>
          )
        }
      />

      {!user.is_active && (
        <Banner tone="warn" title="This user is deactivated" className="mb-4">
          They can't sign in. Reactivate them to restore access.
        </Banner>
      )}

      <div className="flex flex-col gap-4">
        <div className="grid lg:grid-cols-2 gap-4 items-start">
          <ProfileCard key={`${user.name}|${user.title}|${user.manager_email}|${user.department_id}`} user={user} onSaved={refresh} />
          <RolesCard key={`roles|${user.roles.map((r) => r.key).join(",")}`} user={user} onSaved={refresh} />
        </div>
        <OverridesCard key={`ov|${JSON.stringify(user.overrides)}`} user={user} onSaved={refresh} />
        {can("role", "view") && <AccessCard key={`access|${user.roles.map((r) => r.key).join(",")}|${JSON.stringify(user.overrides)}|${user.is_active}`} email={user.email} />}
        <HistoryCard user={user} />
      </div>
    </div>
  );
}
