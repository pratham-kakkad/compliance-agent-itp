import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import clsx from "clsx";
import {
  Archive,
  BellRing,
  CirclePause,
  CirclePlay,
  Copy,
  FileCheck2,
  Info,
  ListChecks,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Rocket,
  SearchX,
  Trash2,
  Users,
  UserX,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import {
  Banner,
  Button,
  Card,
  CardHeader,
  DataTable,
  EmptyState,
  ErrorState,
  Label,
  Menu,
  PageHeader,
  SearchInput,
  Select,
  Skeleton,
  Tabs,
  type Column,
} from "../../components/ui";
import { DefinitionStatusLabel, ObligationStatusLabel, ParticipationLabel, PersonCell, PriorityLabel, DueLabel } from "../../components/compliance/common";
import { availableActions, useDefinitionActions } from "../../components/compliance/library/actions";
import {
  audienceTarget,
  completionText,
  constraintText,
  ruleSentence,
  triggerText,
} from "../../components/compliance/library/describe";
import { useLookup } from "../../components/compliance/library/lookup";
import { useCompliance } from "../../lib/ComplianceContext";
import { useCanEmail } from "../../lib/emailTemplates";
import { EmailButton } from "../../components/compliance/email/EmailButton";
import { useApi } from "../../lib/useApi";
import { fmtDateTime } from "../../lib/format";
import {
  EVIDENCE_KIND_LABEL,
  REVIEW_MODE_LABEL,
  STATUS_LABEL,
  type ComplianceDef,
  type Obligation,
  type ObligationStatus,
  type Page,
} from "../../lib/compliance";

type TabKey = "overview" | "progress" | "people" | "proof" | "escalation" | "audience";

const TERMINAL: ObligationStatus[] = ["completed", "waived", "cancelled"];

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold text-ink2">{label}</dt>
      <dd className="text-sm text-ink mt-0.5 break-words">{children}</dd>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <Skeleton className="h-4 w-56 mb-3" />
      <Skeleton className="h-8 w-80 mb-2" />
      <Skeleton className="h-4 w-64 mb-8" />
      <Card>
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-16 w-full mt-4" />
        <Skeleton className="h-4 w-2/3 mt-4" />
      </Card>
    </div>
  );
}

function PanelEmpty({ icon, title, description, action }: { icon: LucideIcon; title: string; description: string; action?: React.ReactNode }) {
  return <EmptyState icon={icon} title={title} description={description} action={action} compact />;
}

export function ComplianceDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useCompliance();
  const [tab, setTab] = useState<TabKey>("overview");

  const defQ = useApi<ComplianceDef>(`/compliance/definitions/${id}`);
  const obsQ = useApi<Page<Obligation>>(`/compliance/obligations?compliance_id=${id}&limit=500`);
  const lk = useLookup();

  const reloadAll = () => {
    defQ.reload();
    obsQ.reload();
  };
  const actions = useDefinitionActions(reloadAll);

  const def = defQ.data;

  if (defQ.error && !def) {
    return (
      <div>
        <PageHeader title="Compliance" breadcrumbs={[{ label: "Compliance library", to: "/compliance/library" }, { label: "Details" }]} />
        <Card>
          <ErrorState title="This compliance couldn't be opened" message={defQ.error.message} onRetry={defQ.reload} />
        </Card>
      </div>
    );
  }
  if (!def) return <DetailSkeleton />;

  const a = availableActions(def, can);
  const busy = actions.busy !== null;
  const hasMore = a.clone || a.close || a.archive || a.remove;
  const finished = def.status === "closed" || def.status === "archived";

  const header = (
    <span className="inline-flex flex-wrap items-center gap-2">
      <DefinitionStatusLabel status={def.status} />
      <PriorityLabel priority={def.priority} size="md" />
      {def.category && <span className="text-ink2">{def.category}</span>}
    </span>
  );

  return (
    <div>
      <PageHeader
        title={def.name}
        description={header}
        breadcrumbs={[{ label: "Compliance library", to: "/compliance/library" }, { label: def.name }]}
        actions={
          <>
            {a.edit && (
              <Button leadingIcon={Pencil} onClick={() => navigate(`/compliance/library/${def.id}/edit`)} disabled={busy}>
                Edit
              </Button>
            )}
            {a.publish && (
              <Button
                variant="primary"
                leadingIcon={Rocket}
                loading={actions.busy === "publish"}
                disabled={busy}
                onClick={() => void actions.publish(def)}
              >
                Publish
              </Button>
            )}
            {a.pause && (
              <Button leadingIcon={CirclePause} loading={actions.busy === "pause"} disabled={busy} onClick={() => actions.status(def, "pause")}>
                Pause
              </Button>
            )}
            {a.resume && (
              <Button variant="primary" leadingIcon={CirclePlay} loading={actions.busy === "resume"} disabled={busy} onClick={() => actions.status(def, "resume")}>
                Resume
              </Button>
            )}
            {hasMore && (
              <Menu.Root>
                <Menu.Trigger asChild>
                  <Button leadingIcon={MoreHorizontal} aria-label="More actions" disabled={busy}>
                    More
                  </Button>
                </Menu.Trigger>
                <Menu.Content>
                  {a.clone && (
                    <Menu.Item onSelect={() => void actions.clone(def)}>
                      <Copy size={14} aria-hidden /> Make a copy
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
                      <Menu.Item danger onSelect={() => actions.remove(def, () => navigate("/compliance/library"))}>
                        <Trash2 size={14} aria-hidden /> Delete draft…
                      </Menu.Item>
                    </>
                  )}
                </Menu.Content>
              </Menu.Root>
            )}
          </>
        }
      />

      {def.status === "draft" && (
        <Banner
          tone="info"
          className="mb-4"
          title="This is a draft"
          action={
            (a.edit || a.publish) && (
              <div className="flex gap-2">
                {a.edit && <Button size="sm" onClick={() => navigate(`/compliance/library/${def.id}/edit`)}>Finish setting up</Button>}
                {a.publish && (
                  <Button size="sm" variant="primary" loading={actions.busy === "publish"} disabled={busy} onClick={() => void actions.publish(def)}>
                    Publish
                  </Button>
                )}
              </div>
            )
          }
        >
          Nobody has been asked to do anything yet. Finish the details, check who it reaches, then publish to assign it.
        </Banner>
      )}
      {def.status === "paused" && (
        <Banner tone="warn" className="mb-4" title="Paused">
          Reminders and escalations are on hold. People can still submit what they were asked for.
        </Banner>
      )}
      {finished && (
        <Banner tone="info" className="mb-4" title={`This compliance is ${def.status}`}>
          It is kept as a record and can't be changed.
        </Banner>
      )}

      <Tabs<TabKey>
        aria-label="Compliance sections"
        value={tab}
        onChange={setTab}
        className="mb-5 overflow-x-auto"
        items={[
          { value: "overview", label: "Overview" },
          { value: "progress", label: "Progress" },
          { value: "people", label: "People", count: obsQ.data?.total },
          { value: "proof", label: "Proof required", count: def.evidence_requirements?.length },
          { value: "escalation", label: "Escalation", count: def.escalation_rules?.length },
          { value: "audience", label: "Audience", count: def.audience?.length },
        ]}
      />

      <div role="tabpanel" aria-label={tab}>
        {tab === "overview" && <Overview def={def} />}
        {tab === "progress" && <ProgressPanel def={def} />}
        {tab === "people" && <People def={def} q={obsQ} />}
        {tab === "proof" && <Proof def={def} />}
        {tab === "escalation" && <Escalation def={def} nameOf={lk.nameOf} />}
        {tab === "audience" && (
          <Audience
            def={def}
            lookup={lk.lookup ?? null}
            lookupError={lk.error?.message ?? null}
            canRefresh={a.resync}
            refreshing={actions.busy === "resync"}
            onRefresh={() => void actions.resync(def)}
            canEdit={a.edit}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- overview

function Overview({ def }: { def: ComplianceDef }) {
  const resub =
    def.review_mode === "none"
      ? "Not applicable: no review"
      : def.max_resubmissions === 0
        ? "None: one try only"
        : `Up to ${def.max_resubmissions} ${def.max_resubmissions === 1 ? "time" : "times"} after changes are asked for`;
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader title="What is asked" icon={Info} />
        <div className="flex flex-col gap-4">
          <div>
            <h4 className="text-xs font-semibold text-ink2">Description</h4>
            <p className="text-sm text-ink mt-0.5 whitespace-pre-wrap">{def.description || <span className="text-ink3">No description</span>}</p>
          </div>
          <div>
            <h4 className="text-xs font-semibold text-ink2">What people have to do</h4>
            <p className="text-sm text-ink mt-0.5 whitespace-pre-wrap">{def.action_text || <span className="text-ink3">Not spelled out</span>}</p>
          </div>
          <dl className="grid sm:grid-cols-2 gap-x-8 gap-y-4 pt-4 border-t border-line">
            <Fact label="Deadline">
              {def.due_at ? (
                <>
                  {fmtDateTime(def.due_at)}
                  <span className="block text-xs"><DueLabel iso={def.due_at} finished={def.status === "closed" || def.status === "archived" || def.progress.satisfied} /></span>
                </>
              ) : (
                <span className="text-ink3">No deadline</span>
              )}
            </Fact>
            <Fact label="Starts">{def.start_at ? fmtDateTime(def.start_at) : <span className="text-ink3">When published</span>}</Fact>
            <Fact label="Review">
              {REVIEW_MODE_LABEL[def.review_mode]}
              {def.review_mode === "named" && def.reviewer && <span className="block text-ink2">{def.reviewer.name}</span>}
            </Fact>
            <Fact label="Resubmissions">{resub}</Fact>
            <Fact label="Counts as met when">{completionText(def)}</Fact>
            <Fact label="Audience">{def.dynamic_audience ? "Kept up to date automatically" : "Fixed when published, refresh it by hand"}</Fact>
          </dl>
        </div>
      </Card>
      <Card>
        <CardHeader title="Record" />
        <dl className="flex flex-col gap-4">
          <Fact label="Version">Version {def.current_version}</Fact>
          <Fact label="Created by">
            <PersonCell person={def.created_by} size={22} />
            <span className="text-xs text-ink2">{fmtDateTime(def.created_at)}</span>
          </Fact>
          <Fact label="Published">{def.published_at ? fmtDateTime(def.published_at) : <span className="text-ink3">Not yet</span>}</Fact>
          <Fact label="Type">{def.type_key.replace(/_/g, " ")}</Fact>
        </dl>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- progress

const STATUS_BAR: Record<string, string> = {
  completed: "bg-good",
  waived: "bg-neutral",
  cancelled: "bg-neutral",
  not_started: "bg-neutral-bg",
  in_progress: "bg-accent",
  submitted: "bg-accent",
  under_review: "bg-accent",
  rejected: "bg-warn",
};

function ProgressPanel({ def }: { def: ComplianceDef }) {
  const p = def.progress;
  const order: ObligationStatus[] = ["not_started", "in_progress", "submitted", "under_review", "rejected", "completed", "waived", "cancelled"];
  const rows = order.filter((s) => (p.by_status[s] ?? 0) > 0);
  const total = rows.reduce((n, s) => n + (p.by_status[s] ?? 0), 0);
  if (p.required_total === 0 && total === 0) {
    return (
      <Card>
        <PanelEmpty
          icon={Users}
          title="Nobody is assigned yet"
          description={def.status === "draft" ? "Progress appears once this is published and people are assigned." : "No one currently matches the audience."}
        />
      </Card>
    );
  }
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader title="Completion" description={`${p.completed} of ${p.required_total} ${p.required_total === 1 ? "person who must act has" : "people who must act have"} finished`} />
        <div className="flex items-end gap-3">
          <span className="text-[44px] leading-none font-semibold tabular text-ink">{Math.round(p.percent)}%</span>
          <Label tone={p.satisfied ? "good" : "neutral"} dot>
            {p.satisfied ? "Completion rule met" : "Completion rule not met yet"}
          </Label>
        </div>
        <div
          className="mt-4 h-2.5 rounded-full bg-neutral-bg overflow-hidden"
          role="meter"
          aria-label="Completion"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(p.percent)}
        >
          <div className={clsx("h-full rounded-full transition-[width] duration-300", p.satisfied ? "bg-good" : "bg-accent")} style={{ width: `${Math.max(0, Math.min(100, p.percent))}%` }} />
        </div>
        <p className="text-[13px] text-ink2 mt-3">The rule: {completionText(def).toLowerCase()}.</p>
      </Card>
      <Card>
        <CardHeader title="Where people are" description="Everyone assigned, by where they are right now" />
        <ul className="flex flex-col gap-2.5">
          {rows.map((s) => {
            const n = p.by_status[s] ?? 0;
            return (
              <li key={s} className="flex items-center gap-3">
                <span className="w-32 text-[13px] text-ink2 flex-none">{STATUS_LABEL[s]}</span>
                <div className="flex-1 h-2 rounded-full bg-neutral-bg overflow-hidden" aria-hidden>
                  <div className={clsx("h-full rounded-full", STATUS_BAR[s])} style={{ width: `${total ? (n / total) * 100 : 0}%` }} />
                </div>
                <span className="w-8 text-right text-sm font-semibold tabular text-ink">{n}</span>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ people

function People({ def, q }: { def: ComplianceDef; q: ReturnType<typeof useApi<Page<Obligation>>> }) {
  const navigate = useNavigate();
  const canEmail = useCanEmail();
  const [status, setStatus] = useState<"" | ObligationStatus>("");
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const items = q.data?.items ?? [];

  // People who can be e-mailed about this compliance: not informational-only, not cancelled.
  const mailable = useMemo(() => items.filter((o) => o.user && o.participation !== "informational" && o.status !== "cancelled"), [items]);
  const togglePick = (email: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(email)) n.delete(email);
      else n.add(email);
      return n;
    });
  const quick = [
    { label: "All overdue", test: (o: Obligation) => o.overdue },
    { label: "All not started", test: (o: Obligation) => o.status === "not_started" },
    { label: "All rejected", test: (o: Obligation) => o.status === "rejected" },
  ].map((r) => ({ ...r, emails: mailable.filter(r.test).map((o) => o.user!.email) }));
  const pickedRows = mailable.filter((o) => picked.has(o.user!.email));
  const allPickedOverdue = pickedRows.length > 0 && pickedRows.every((o) => o.overdue);

  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return items.filter((o) => (!status || o.status === status) && (!s || `${o.user?.name ?? ""} ${o.user?.email ?? ""}`.toLowerCase().includes(s)));
  }, [items, status, search]);

  const columns: Column<Obligation>[] = [
    ...(canEmail
      ? [
          {
            key: "pick",
            header: (
              <input
                type="checkbox"
                aria-label="Select everyone shown"
                checked={rows.length > 0 && rows.filter((o) => mailable.includes(o)).every((o) => picked.has(o.user!.email)) && rows.some((o) => mailable.includes(o))}
                onChange={(e) =>
                  setPicked((s) => {
                    const n = new Set(s);
                    for (const o of rows) if (mailable.includes(o)) (e.target.checked ? n.add(o.user!.email) : n.delete(o.user!.email));
                    return n;
                  })
                }
                className="w-4 h-4 accent-[var(--accent)] align-middle"
              />
            ),
            width: "44px",
            cell: (o: Obligation) =>
              mailable.includes(o) ? (
                <input
                  type="checkbox"
                  aria-label={`Select ${o.user?.name}`}
                  checked={picked.has(o.user!.email)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                  onChange={() => togglePick(o.user!.email)}
                  className="w-4 h-4 accent-[var(--accent)] align-middle"
                />
              ) : null,
          } as Column<Obligation>,
        ]
      : []),
    { key: "person", header: "Person", sortValue: (o) => o.user?.name.toLowerCase(), cell: (o) => <PersonCell person={o.user} showTitle /> },
    { key: "part", header: "Part", hideBelow: "sm", sortValue: (o) => o.participation, cell: (o) => <ParticipationLabel participation={o.participation} /> },
    { key: "status", header: "Status", sortValue: (o) => o.status, cell: (o) => <ObligationStatusLabel o={o} /> },
    {
      key: "due",
      header: "Due",
      hideBelow: "md",
      sortValue: (o) => (o.due_at ? new Date(o.due_at).getTime() : null),
      cell: (o) => <DueLabel iso={o.due_at} finished={TERMINAL.includes(o.status)} />,
    },
    {
      key: "open",
      header: <span className="sr-only">Open</span>,
      align: "right",
      cell: (o) => (
        <Link
          to={`/compliance/obligations/${o.id}`}
          onClick={(e) => e.stopPropagation()}
          className="text-[13px] font-semibold text-accent hover:underline"
          aria-label={`Open ${o.user?.name ?? "item"}'s task`}
        >
          Open
        </Link>
      ),
    },
  ];

  if (q.error && !q.data) {
    return (
      <Card>
        <ErrorState title="The people list couldn't be loaded" message={q.error.message} onRetry={q.reload} />
      </Card>
    );
  }

  const filtered = Boolean(status || search.trim());
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Search people…" className="w-full sm:w-64" aria-label="Search people" />
        <Select value={status} onChange={(e) => setStatus(e.target.value as "" | ObligationStatus)} aria-label="Filter by status">
          <option value="">All statuses</option>
          {(Object.keys(STATUS_LABEL) as ObligationStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
        {q.data && (
          <span className="ml-auto text-[13px] text-ink2 tabular" aria-live="polite">
            {rows.length === q.data.total ? `${q.data.total} ${q.data.total === 1 ? "person" : "people"}` : `${rows.length} of ${q.data.total}`}
          </span>
        )}
      </div>
      {canEmail && mailable.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-3" role="group" aria-label="E-mail the people on this compliance">
          <span className="text-[13px] text-ink2">Select:</span>
          {quick.map((r) => (
            <Button key={r.label} size="sm" disabled={r.emails.length === 0} onClick={() => setPicked(new Set(r.emails))}>
              {r.label} <span className="tabular text-ink3">{r.emails.length}</span>
            </Button>
          ))}
          {picked.size > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>
              Clear
            </Button>
          )}
          <span className="ml-auto flex items-center gap-2">
            <span className="text-[13px] text-ink2 tabular" aria-live="polite">
              {picked.size} selected
            </span>
            <EmailButton
              label={picked.size > 0 ? `Email ${picked.size}` : "Email selected"}
              variant="primary"
              disabled={picked.size === 0}
              onDone={() => setPicked(new Set())}
              target={() => ({
                recipients: { compliance_id: def.id, status: "all", only: Array.from(picked) },
                heading: `Email ${pickedRows.length === 1 ? pickedRows[0].user!.name : `${pickedRows.length} people`}`,
                subtitle: `About ${def.name}. Replies go to you.`,
                defaultKind: allPickedOverdue ? "warning" : "reminder",
              })}
            />
          </span>
        </div>
      )}
      <Card padding="none" className="overflow-hidden">
        <DataTable
          columns={columns}
          rows={rows}
          getRowKey={(o) => o.id}
          onRowClick={(o) => navigate(`/compliance/obligations/${o.id}`)}
          rowLabel={(o) => `Open ${o.user?.name ?? "item"}`}
          loading={q.initialLoading}
          dim={q.loading && items.length > 0}
          caption={`People assigned to ${def.name}`}
          defaultSort={{ key: "status", dir: "asc" }}
          empty={
            filtered ? (
              <EmptyState icon={SearchX} title="No one matches" description="Try a different search or status." action={<Button onClick={() => { setStatus(""); setSearch(""); }}>Clear filters</Button>} />
            ) : (
              <EmptyState
                icon={UserX}
                title="Nobody is assigned"
                description={def.status === "draft" ? "People are assigned when you publish." : "No one matches the audience right now."}
              />
            )
          }
        />
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------- proof

function Proof({ def }: { def: ComplianceDef }) {
  const reqs = def.evidence_requirements ?? [];
  return (
    <Card>
      <CardHeader title="What people must provide" description="Shown to each person as a form when they submit" icon={FileCheck2} />
      {reqs.length === 0 ? (
        <PanelEmpty icon={FileCheck2} title="No proof is asked for" description="People just confirm they have done it." />
      ) : (
        <ol className="flex flex-col divide-y divide-line-soft">
          {reqs.map((r, i) => {
            const extra = constraintText(r);
            return (
              <li key={r.key} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                <span className="w-5 h-5 rounded-full bg-panel2 border border-line text-[11px] font-semibold text-ink2 flex items-center justify-center flex-none mt-0.5" aria-hidden>
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-ink">{r.label}</div>
                  <div className="text-[13px] text-ink2">
                    {EVIDENCE_KIND_LABEL[r.kind]}
                    {extra ? `: ${extra}` : ""}
                  </div>
                </div>
                <Label tone={r.mandatory ? "accent" : "neutral"} variant={r.mandatory ? "subtle" : "outline"} size="sm">
                  {r.mandatory ? "Required" : "Optional"}
                </Label>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

// -------------------------------------------------------------- escalation

function Escalation({ def, nameOf }: { def: ComplianceDef; nameOf: (e: string) => string }) {
  const rules = def.escalation_rules ?? [];
  return (
    <Card>
      <CardHeader title="Reminders and escalation" description="Sent automatically for people who must act and haven't finished" icon={BellRing} />
      {rules.length === 0 ? (
        <PanelEmpty icon={BellRing} title="No automatic follow-up" description="Nobody is reminded, and nobody is marked non-compliant, unless someone adds a rule." />
      ) : (
        <ol className="flex flex-col divide-y divide-line-soft">
          {rules.map((r) => (
            <li key={r.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-ink">{r.name}</span>
                <Label size="sm">{triggerText(r.trigger)}</Label>
              </div>
              <p className="text-sm text-ink2 mt-1">{ruleSentence(r, nameOf)}</p>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- audience

function Audience({
  def,
  lookup,
  lookupError,
  canRefresh,
  refreshing,
  onRefresh,
  canEdit,
}: {
  def: ComplianceDef;
  lookup: ReturnType<typeof useLookup>["lookup"] | null;
  lookupError: string | null;
  canRefresh: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  canEdit: boolean;
}) {
  const rules = def.audience ?? [];
  return (
    <Card>
      <CardHeader
        title="Who it applies to"
        description={def.dynamic_audience ? "Kept up to date automatically: joiners are added and leavers are taken off." : "Fixed when published. Refresh it to pick up changes in teams and departments."}
        icon={ListChecks}
        actions={
          canRefresh && (
            <Button leadingIcon={RefreshCw} loading={refreshing} onClick={onRefresh}>
              Refresh audience
            </Button>
          )
        }
      />
      {lookupError && (
        <Banner tone="warn" className="mb-3" title="Names couldn't be looked up">
          {lookupError}
        </Banner>
      )}
      {rules.length === 0 ? (
        <PanelEmpty
          icon={Users}
          title="No audience rules"
          description="Nobody is chosen yet."
          action={canEdit && <Link to={`/compliance/library/${def.id}/edit`} className="text-sm font-semibold text-accent hover:underline">Choose who it applies to</Link>}
        />
      ) : (
        <ul className="flex flex-col divide-y divide-line-soft">
          {rules.map((r, i) => (
            <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 first:pt-0 last:pb-0">
              <Label tone={r.effect === "include" ? "good" : "crit"} size="sm" className="w-[72px] justify-center">
                {r.effect === "include" ? "Include" : "Exclude"}
              </Label>
              <span className="text-sm text-ink min-w-0 flex-1 break-words">{audienceTarget(r, lookup)}</span>
              {r.effect === "include" && <ParticipationLabel participation={r.participation} />}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-ink2 mt-4">The strongest part wins when a person matches several rules, and a rule that excludes always wins.</p>
    </Card>
  );
}
