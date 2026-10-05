import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { toast } from "sonner";
import { Crown, Filter, Info, Lock, Pencil, Plus, Shield, Trash2, Users } from "lucide-react";
import { useApi } from "../../lib/useApi";
import type { ApiState } from "../../lib/useApi";
import { api } from "../../lib/api";
import { useCompliance } from "../../lib/ComplianceContext";
import type { AdminRole } from "../../lib/compliance";
import { Banner, Button, Card, CardHeader, EmptyState, ErrorState, Label, PageHeader, Select, Skeleton, Tabs, TextInput } from "../../components/ui";
import { useOverlay } from "../../components/Modal";
import { Field, Textarea, errText, toastError } from "../../components/compliance/common";
import { RecordRulesPanel } from "../../components/compliance/admin/RecordRules";
import { ACTION_ORDER, NoAccess, SCOPE_ORDER, actionLabel, scopeShort, useConfirm } from "../../components/compliance/admin/parts";

const grantKey = (resource: string, action: string) => `${resource}:${action}`;

// ------------------------------------------------------------- role badges

function RoleBadges({ role }: { role: AdminRole }) {
  return (
    <>
      {role.is_super && (
        <Label tone="accent" size="sm" icon={Crown}>
          Super
        </Label>
      )}
      {role.is_system && (
        <Label size="sm" variant="outline">
          Built-in
        </Label>
      )}
      {role.auto_assign && (
        <Label size="sm" tone="good" variant="outline">
          Automatic: {role.auto_assign === "all" ? "everyone" : "managers"}
        </Label>
      )}
    </>
  );
}

// ------------------------------------------------------------- role dialog

function RoleDialog({ role, onSaved }: { role?: AdminRole; onSaved: (id: string) => void }) {
  const { close } = useOverlay();
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [auto, setAuto] = useState<string>(role?.auto_assign ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const saved = role
        ? await api.patch<AdminRole>(`/compliance/admin/roles/${role.id}`, { name: name.trim(), description: description.trim() })
        : await api.post<AdminRole>("/compliance/admin/roles", { name: name.trim(), description: description.trim(), auto_assign: auto || null });
      toast.success(role ? "Role updated" : `Role "${saved.name}" created`, { description: role ? undefined : "Now choose what it can do." });
      onSaved(saved.id);
      close();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      <div className="pr-6">
        <h2 className="text-lg font-semibold text-ink">{role ? `Edit ${role.name}` : "New role"}</h2>
        {!role && <p className="text-sm text-ink2 mt-1">A new role starts with no permissions. Set them in the grid afterwards.</p>}
      </div>
      <Field label="Role name" required>
        {(id) => <TextInput id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Auditor" />}
      </Field>
      <Field label="Description" hint="Shown to administrators when they assign roles.">
        {(id) => <Textarea id={id} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />}
      </Field>
      {!role && (
        <Field label="Who holds it" hint="Automatic roles are held without being assigned. Leave on Assigned to give it to people one by one.">
          {(id) => (
            <Select
              id={id}
              value={auto}
              onChange={(e) => setAuto(e.target.value)}
              className="w-full"
              options={[
                { value: "", label: "Assigned to people individually" },
                { value: "all", label: "Automatic: everyone" },
                { value: "managers", label: "Automatic: anyone with direct reports" },
              ]}
            />
          )}
        </Field>
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
        <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>
          {role ? "Save" : "Create role"}
        </Button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------ permission grid

function RoleEditor({
  role,
  canConfigure,
  onDirty,
  onSaved,
}: {
  role: AdminRole;
  canConfigure: boolean;
  onDirty: (dirty: boolean) => void;
  onSaved: () => void;
}) {
  const { meta } = useCompliance();
  const initial = useMemo(() => {
    const m: Record<string, string> = {};
    for (const g of role.grants) m[grantKey(g.resource, g.action)] = g.scope;
    return m;
  }, [role.grants]);
  const [draft, setDraft] = useState<Record<string, string>>(initial);
  const [busy, setBusy] = useState(false);

  const resources = meta?.resources ?? [];
  const scopeKeys = meta?.scopes.length ? meta.scopes.map((s) => s.key as string) : SCOPE_ORDER;
  const actions = useMemo(() => {
    const present = new Set(resources.flatMap((r) => r.actions));
    return [...ACTION_ORDER.filter((a) => present.has(a)), ...[...present].filter((a) => !ACTION_ORDER.includes(a)).sort()];
  }, [resources]);

  const readOnly = role.is_super || !canConfigure;
  const changes = useMemo(() => {
    const keys = new Set([...Object.keys(initial), ...Object.keys(draft)]);
    return [...keys].filter((k) => (draft[k] ?? "") !== (initial[k] ?? "")).length;
  }, [initial, draft]);

  useEffect(() => {
    onDirty(changes > 0);
    return () => onDirty(false);
  }, [changes, onDirty]);

  async function save() {
    setBusy(true);
    try {
      const grants = Object.entries(draft)
        .filter(([, scope]) => scope)
        .map(([k, scope]) => {
          const [resource, action] = k.split(":");
          return { resource, action, scope };
        });
      await api.put(`/compliance/admin/roles/${role.id}/grants`, { grants });
      toast.success(`${role.name} permissions saved`);
      onSaved();
    } catch (err) {
      toastError("Couldn't save the permissions", err);
    } finally {
      setBusy(false);
    }
  }

  if (!meta) return <Skeleton className="h-64 w-full" />;

  return (
    <div>
      {role.is_super ? (
        <div className="p-4 pb-0">
          <Banner icon={Lock} title="Super Admin has every permission">
            Super Admins can do everything, across the whole organization, so there is nothing to configure. The grid below is for reference.
          </Banner>
        </div>
      ) : !canConfigure ? (
        <div className="p-4 pb-0">
          <Banner icon={Lock} tone="warn">
            You can view this role but need the Roles &amp; access "configure" permission to change it.
          </Banner>
        </div>
      ) : null}

      <div className="overflow-x-auto mt-4 border-t border-line">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Permissions granted by the {role.name} role</caption>
          <thead>
            <tr className="bg-panel2 border-b border-line">
              <th scope="col" className="sticky left-0 z-10 bg-panel2 h-9 px-4 text-left text-xs font-semibold text-ink2 whitespace-nowrap">
                Area
              </th>
              {actions.map((a) => (
                <th key={a} scope="col" className="h-9 px-1.5 text-left text-xs font-semibold text-ink2 whitespace-nowrap">
                  {actionLabel(a)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {resources.map((r) => (
              <tr key={r.key} className="border-b border-line-soft last:border-0">
                <th scope="row" className="sticky left-0 z-10 bg-panel px-4 py-2 text-left align-middle min-w-[170px]">
                  <span className="block font-medium text-ink">{r.label}</span>
                  {r.navigation_only && <span className="block text-[11px] font-normal text-ink3">Controls the menu only</span>}
                </th>
                {actions.map((a) => {
                  if (!r.actions.includes(a)) {
                    return (
                      <td key={a} className="px-1.5 py-1.5 text-center text-ink3" aria-label="Not applicable">
                        <span aria-hidden>·</span>
                      </td>
                    );
                  }
                  const k = grantKey(r.key, a);
                  const value = role.is_super ? "org" : draft[k] ?? "";
                  const known = scopeKeys.includes(value);
                  return (
                    <td key={a} className="px-1.5 py-1.5">
                      <Select
                        size="sm"
                        aria-label={`${r.label}: ${actionLabel(a)}`}
                        title={value ? meta.scopes.find((s) => s.key === value)?.label : "No access"}
                        value={value}
                        disabled={readOnly || busy}
                        onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
                        className={clsx("w-full min-w-[8.5rem]", value && "[&_select]:border-accent [&_select]:bg-accent-soft [&_select]:text-accent-strong [&_select]:font-medium")}
                      >
                        <option value="">No access</option>
                        {!known && value && <option value={value}>{scopeShort(value)}</option>}
                        {scopeKeys.map((s) => (
                          <option key={s} value={s}>
                            {scopeShort(s)}
                          </option>
                        ))}
                      </Select>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!readOnly && (
        <div
          className={clsx("flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-t border-line transition-colors", changes > 0 ? "bg-warn-bg" : "bg-panel2")}
          role="status"
          aria-live="polite"
        >
          <span className={clsx("text-[13px]", changes > 0 ? "text-ink font-semibold" : "text-ink2")}>
            {changes > 0 ? `${changes} unsaved ${changes === 1 ? "change" : "changes"}` : "No unsaved changes"}
          </span>
          <div className="flex items-center gap-2">
            <Button onClick={() => setDraft(initial)} disabled={changes === 0 || busy}>
              Discard
            </Button>
            <Button variant="primary" loading={busy} disabled={changes === 0} onClick={() => void save()}>
              Save permissions
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------- roles tab

function ScopeLegend() {
  const { meta } = useCompliance();
  return (
    <Card>
      <CardHeader title="What the scopes mean" icon={Info} description="Each permission reaches a set of people's records. If someone holds several roles they get the widest reach." />
      <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-2.5 text-[13px]">
        <div>
          <dt className="font-semibold text-ink">No access</dt>
          <dd className="text-ink2">The permission isn't granted.</dd>
        </div>
        {(meta?.scopes ?? []).map((s) => (
          <div key={s.key}>
            <dt className="font-semibold text-ink">{scopeShort(s.key)}</dt>
            <dd className="text-ink2">
              {s.label}
              {s.key === "created_by_me" ? ". Applies to compliance definitions." : ""}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-ink2 mt-3">
        A deny in a person's access overrides always beats any role. Areas marked "controls the menu only" decide what appears in the navigation; the Meetings and Attendance pages keep
        their own rules.
      </p>
    </Card>
  );
}

function RolesTab({ roles, dirtyRef, reload }: { roles: ApiState<AdminRole[]>; dirtyRef: React.MutableRefObject<boolean>; reload: () => void }) {
  const { can } = useCompliance();
  const { openModal } = useOverlay();
  const confirm = useConfirm();
  const [selected, setSelected] = useState<string | null>(null);
  const list = roles.data ?? [];
  const role = list.find((r) => r.id === selected) ?? list[0] ?? null;
  const setDirty = useCallback(
    (d: boolean) => {
      dirtyRef.current = d;
    },
    [dirtyRef]
  );

  function choose(id: string) {
    if (id === role?.id) return;
    if (dirtyRef.current) {
      confirm({
        title: "Discard unsaved changes?",
        description: <p>You have unsaved permission changes on {role?.name}. Switching roles will lose them.</p>,
        confirm: "Discard and switch",
        tone: "primary",
        onConfirm: async () => {
          setSelected(id);
        },
      });
    } else setSelected(id);
  }

  function remove(r: AdminRole) {
    confirm({
      title: `Delete the ${r.name} role?`,
      description: (
        <p>
          {r.members > 0 ? `${r.members} ${r.members === 1 ? "person holds" : "people hold"} it and will lose the access it gives. ` : ""}
          Record rules that apply only to this role are removed with it. This can't be undone.
        </p>
      ),
      confirm: "Delete role",
      onConfirm: async () => {
        await api.delete(`/compliance/admin/roles/${r.id}`);
        toast.success(`Role "${r.name}" deleted`);
        setSelected(null);
        reload();
      },
    });
  }

  if (roles.error && !roles.data) return <Card><ErrorState message={roles.error.message} onRetry={roles.reload} /></Card>;
  if (roles.initialLoading || !roles.data) {
    return (
      <div className="grid lg:grid-cols-[280px_minmax(0,1fr)] gap-4" aria-busy="true">
        <Card><Skeleton className="h-64 w-full" /></Card>
        <Card><Skeleton className="h-64 w-full" /></Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid lg:grid-cols-[300px_minmax(0,1fr)] gap-4 items-start">
        <Card padding="none" className="overflow-hidden">
          <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-line">
            <h2 className="text-sm font-semibold text-ink">Roles</h2>
            {can("role", "create") && (
              <Button size="sm" leadingIcon={Plus} onClick={() => openModal(<RoleDialog onSaved={(id) => { reload(); setSelected(id); }} />)}>
                New role
              </Button>
            )}
          </div>
          {list.length === 0 ? (
            <EmptyState compact icon={Shield} title="No roles" />
          ) : (
            <ul className="p-1.5 flex flex-col gap-0.5">
              {list.map((r) => {
                const on = r.id === role?.id;
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => choose(r.id)}
                      aria-current={on ? "true" : undefined}
                      className={clsx(
                        "w-full text-left rounded-md px-3 py-2.5 transition-colors border",
                        on ? "bg-accent-soft border-accent" : "border-transparent hover:bg-panel2"
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className={clsx("text-sm font-semibold truncate", on ? "text-accent-strong" : "text-ink")}>{r.name}</span>
                        <span className="inline-flex items-center gap-1 text-xs text-ink2 tabular flex-none" title={r.auto_assign ? "Held automatically" : `${r.members} assigned`}>
                          <Users size={12} aria-hidden />
                          {r.auto_assign ? "auto" : r.members}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        <RoleBadges role={r} />
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {role && (
          <Card padding="none" className="overflow-hidden min-w-0">
            <div className="p-4">
              <CardHeader
                title={role.name}
                className="!mb-0"
                description={role.description || "No description."}
                actions={
                  <>
                    {can("role", "edit") && (
                      <Button size="sm" leadingIcon={Pencil} onClick={() => openModal(<RoleDialog role={role} onSaved={() => reload()} />)}>
                        Edit
                      </Button>
                    )}
                    {can("role", "delete") && !role.is_system && (
                      <Button size="sm" variant="danger" leadingIcon={Trash2} onClick={() => remove(role)}>
                        Delete
                      </Button>
                    )}
                  </>
                }
              />
              <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
                <RoleBadges role={role} />
                <span className="text-xs text-ink2 ml-1">
                  {role.auto_assign ? (role.auto_assign === "all" ? "Held by everyone" : "Held by anyone with direct reports") : `${role.members} ${role.members === 1 ? "person" : "people"} assigned`}
                </span>
                {role.is_system && !role.is_super && <span className="text-xs text-ink3">Built-in roles can't be deleted, but their permissions can be edited.</span>}
              </div>
            </div>
            <RoleEditor
              key={`${role.id}|${JSON.stringify(role.grants)}`}
              role={role}
              canConfigure={can("role", "configure")}
              onDirty={setDirty}
              onSaved={reload}
            />
          </Card>
        )}
      </div>
      <ScopeLegend />
    </div>
  );
}

// -------------------------------------------------------------------- page

export function AdminAccess() {
  const { can, ready } = useCompliance();
  const confirm = useConfirm();
  const [tab, setTab] = useState<"roles" | "rules">("roles");
  const dirtyRef = useRef(false);
  const allowed = can("role", "view");
  const roles = useApi<AdminRole[]>(allowed ? "/compliance/admin/roles" : null);

  function changeTab(next: "roles" | "rules") {
    if (next === tab) return;
    if (dirtyRef.current) {
      confirm({
        title: "Discard unsaved changes?",
        description: <p>You have unsaved permission changes. Leaving this tab will lose them.</p>,
        confirm: "Discard and leave",
        tone: "primary",
        onConfirm: async () => {
          dirtyRef.current = false;
          setTab(next);
        },
      });
    } else setTab(next);
  }

  if (!ready) {
    return (
      <div>
        <PageHeader title="Roles & access" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (!allowed) return <div><PageHeader title="Roles & access" /><NoAccess what="manage roles and access" /></div>;

  return (
    <div>
      <PageHeader title="Roles & access" description="Decide what each role can do and whose records it reaches. Changes apply to everyone holding the role straight away, and every change is recorded in the audit log." />
      <Tabs
        aria-label="Roles and access"
        value={tab}
        onChange={changeTab}
        className="mb-4"
        items={[
          { value: "roles", label: "Roles", icon: Shield, count: roles.data?.length },
          { value: "rules", label: "Record rules", icon: Filter },
        ]}
      />
      <div role="tabpanel" aria-label={tab === "roles" ? "Roles" : "Record rules"}>
        {tab === "roles" ? (
          <RolesTab roles={roles} dirtyRef={dirtyRef} reload={roles.reload} />
        ) : roles.data ? (
          <RecordRulesPanel roles={roles.data} />
        ) : roles.error ? (
          <Card><ErrorState message={roles.error.message} onRetry={roles.reload} /></Card>
        ) : (
          <Skeleton className="h-48 w-full" />
        )}
      </div>
    </div>
  );
}
