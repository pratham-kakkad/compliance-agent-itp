import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Download, History, Play, ShieldCheck } from "lucide-react";
import { api, UnauthorizedError } from "../../lib/api";
import { useCompliance } from "../../lib/ComplianceContext";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { fmtDateTime, getDisplayTimeZone, zoneOffsetMinutes } from "../../lib/format";
import type { AuditEventRow, Page } from "../../lib/compliance";
import { Banner, Button, Card, EmptyState, ErrorState, PageHeader, SearchInput, Select, TableSkeleton, TextInput } from "../../components/ui";
import { Field, toastError } from "../../components/compliance/common";
import { NoAccess, humanize } from "../../components/compliance/admin/parts";

const PAGE = 50;

const ACTION_PREFIXES: { value: string; label: string }[] = [
  { value: "", label: "All activity" },
  { value: "compliance.", label: "Compliance definitions" },
  { value: "obligation.", label: "Assigned items" },
  { value: "submission.", label: "Submissions & reviews" },
  { value: "evidence.", label: "Evidence files" },
  { value: "user.", label: "Users" },
  { value: "role.", label: "Roles" },
  { value: "record_rule.", label: "Record rules" },
  { value: "team.", label: "Teams" },
  { value: "department.", label: "Departments" },
  { value: "escalation.", label: "Escalations" },
  { value: "scheduler.", label: "Scheduler" },
];

const ENTITY_TYPES = ["compliance", "obligation", "submission", "evidence_file", "user", "role", "record_rule", "team", "department", "scheduler", "audit_log"];

/** Start (or end) of a calendar day in the organization's time zone, as an ISO instant. */
function dayBoundary(date: string, end: boolean): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const offset = zoneOffsetMinutes(getDisplayTimeZone(), new Date(Date.UTC(y, mo - 1, d, 12)));
  const start = Date.UTC(y, mo - 1, d) - offset * 60_000;
  return new Date(end ? start + 86_400_000 - 1 : start).toISOString();
}

const shortId = (id: string) => (id.length > 14 && /^[0-9a-f-]{20,}$/i.test(id) ? id.slice(0, 8) : id);

// ------------------------------------------------------------- JSON views

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const json = (v: unknown) => JSON.stringify(v, null, 2);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Pretty JSON where, when `other` is given, the keys (or list items) that differ from it stand out. */
function JsonView({ value, other, tone }: { value: unknown; other?: unknown; tone: "old" | "new" | "plain" }) {
  const mark = tone === "old" ? "bg-crit-bg" : "bg-good-bg";
  const compare = tone !== "plain" && other !== null && other !== undefined;
  const line = (changed: boolean) => clsx("px-2 -mx-2 rounded-sm whitespace-pre-wrap break-words", changed && [mark, "font-semibold text-ink"]);

  let body: React.ReactNode;
  if (isObj(value) && Object.keys(value).length > 0) {
    body = Object.keys(value).map((k) => (
      <div key={k} className={line(compare && (isObj(other) ? !same(value[k], other[k]) : true))}>
        <span className="text-ink2">{k}</span>: {json(value[k])}
      </div>
    ));
  } else if (Array.isArray(value) && value.length > 0) {
    body = value.map((item, i) => (
      <div key={i} className={line(compare && Array.isArray(other) && !other.some((o) => same(o, item)))}>
        {json(item)}
      </div>
    ));
  } else {
    body = <div className="whitespace-pre-wrap break-words">{json(value)}</div>;
  }
  return <div className="font-mono text-xs leading-5 text-ink">{body}</div>;
}

function DetailBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-md border border-line bg-panel p-3">
      <h4 className="text-xs font-semibold text-ink2 mb-2">{title}</h4>
      <div className="max-h-72 overflow-auto">{children}</div>
    </section>
  );
}

function EventDetail({ e }: { e: AuditEventRow }) {
  const hasBefore = e.before !== null && e.before !== undefined;
  const hasAfter = e.after !== null && e.after !== undefined;
  const hasMeta = e.meta !== null && e.meta !== undefined;
  return (
    <div className="flex flex-col gap-3">
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink2">
        <div className="flex gap-1.5">
          <dt>Event</dt>
          <dd className="font-mono text-ink">#{e.id}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt>Actor</dt>
          <dd className="font-mono text-ink break-all">{e.actor}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt>Entity</dt>
          <dd className="font-mono text-ink break-all">
            {e.entity_type} / {e.entity_id}
          </dd>
        </div>
        <div className="flex gap-1.5">
          <dt>At</dt>
          <dd className="font-mono text-ink">{e.at}</dd>
        </div>
      </dl>
      {!hasBefore && !hasAfter && !hasMeta ? (
        <p className="text-[13px] text-ink2">No further detail was recorded for this event.</p>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {hasBefore && (
              <DetailBlock title="Before">
                <JsonView value={e.before} other={hasAfter ? e.after : undefined} tone="old" />
              </DetailBlock>
            )}
            {hasAfter && (
              <DetailBlock title="After">
                <JsonView value={e.after} other={hasBefore ? e.before : undefined} tone={hasBefore ? "new" : "plain"} />
              </DetailBlock>
            )}
            {hasMeta && (
              <DetailBlock title="Details">
                <JsonView value={e.meta} tone="plain" />
              </DetailBlock>
            )}
          </div>
          {hasBefore && hasAfter && <p className="text-xs text-ink3">Highlighted lines changed: red was the old value, green is the new one.</p>}
        </>
      )}
    </div>
  );
}

// -------------------------------------------------------------------- page

export function AdminAudit() {
  const { can, ready } = useCompliance();
  const allowed = can("audit_log", "view");

  const [q, setQ] = useState("");
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [entityType, setEntityType] = useState("");
  const [entityId, setEntityId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const dq = useDebouncedValue(q.trim(), 300);
  const dActor = useDebouncedValue(actor.trim(), 300);
  const dEntityId = useDebouncedValue(entityId.trim(), 300);

  const filterQuery = useMemo(() => {
    const p = new URLSearchParams();
    if (dq) p.set("q", dq);
    if (action) p.set("action", action);
    if (dActor) p.set("actor", dActor.toLowerCase());
    if (entityType) p.set("entity_type", entityType);
    if (dEntityId) p.set("entity_id", dEntityId);
    const since = dayBoundary(from, false);
    const until = dayBoundary(to, true);
    if (since) p.set("since", since);
    if (until) p.set("until", until);
    return p.toString();
  }, [dq, action, dActor, entityType, dEntityId, from, to]);
  const filtered = filterQuery !== "";

  const [items, setItems] = useState<AuditEventRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const seq = useRef(0);

  const load = useCallback(
    async (offset: number) => {
      const id = ++seq.current;
      if (offset === 0) setLoading(true);
      else setLoadingMore(true);
      setError(null);
      try {
        const page = await api.get<Page<AuditEventRow>>(`/compliance/admin/audit?${filterQuery}${filterQuery ? "&" : ""}limit=${PAGE}&offset=${offset}`);
        if (id !== seq.current) return;
        setTotal(page.total);
        setItems((prev) => {
          if (offset === 0) return page.items;
          const have = new Set(prev.map((x) => x.id));
          return [...prev, ...page.items.filter((x) => !have.has(x.id))];
        });
        if (offset === 0) setOpen(new Set());
      } catch (e) {
        if (id !== seq.current || e instanceof UnauthorizedError) return;
        setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        if (id === seq.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [filterQuery]
  );

  useEffect(() => {
    if (allowed) void load(0);
  }, [allowed, load]);

  // ---- actions
  const [verifying, setVerifying] = useState(false);
  const [verdict, setVerdict] = useState<{ ok: boolean; checked: number; first_bad_id: number | null } | null>(null);
  const [ticking, setTicking] = useState(false);

  async function verify() {
    setVerifying(true);
    setVerdict(null);
    try {
      setVerdict(await api.get("/compliance/admin/audit/verify"));
    } catch (e) {
      toastError("Couldn't verify the audit log", e);
    } finally {
      setVerifying(false);
    }
  }

  function exportCsv() {
    const a = document.createElement("a");
    a.href = `/compliance/admin/audit/export${filterQuery ? `?${filterQuery}` : ""}`;
    a.download = "audit-log.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast.success("Exporting the audit log", { description: filtered ? "Your current filters are applied. The export is itself recorded in the log." : "The export is itself recorded in the log." });
  }

  async function runTick() {
    setTicking(true);
    try {
      const r = await api.post<Record<string, number>>("/compliance/admin/run-tick");
      const n = (k: string) => Number(r?.[k] ?? 0);
      toast.success("Deadline check finished", {
        description: `${n("obligations_checked")} items checked · ${n("fired")} escalations fired · ${n("resynced")} audiences re-synced`,
      });
      void load(0);
    } catch (e) {
      toastError("The deadline check failed", e);
    } finally {
      setTicking(false);
    }
  }

  function toggle(id: number) {
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearFilters() {
    setQ("");
    setAction("");
    setActor("");
    setEntityType("");
    setEntityId("");
    setFrom("");
    setTo("");
  }

  if (!ready) {
    return (
      <div>
        <PageHeader title="Audit log" />
        <Card padding="none">
          <TableSkeleton rows={6} columns={4} />
        </Card>
      </div>
    );
  }
  if (!allowed) return <div><PageHeader title="Audit log" /><NoAccess what="read the audit log" /></div>;

  return (
    <div>
      <PageHeader
        title="Audit log"
        description="A tamper-evident record of who did what. Every change to compliance, people, roles and settings is written here and can't be edited."
        actions={
          <>
            {can("settings", "configure") && (
              <Button leadingIcon={Play} loading={ticking} onClick={() => void runTick()}>
                Run deadline check now
              </Button>
            )}
            <Button leadingIcon={ShieldCheck} loading={verifying} onClick={() => void verify()}>
              Verify integrity
            </Button>
            {can("audit_log", "export") && (
              <Button leadingIcon={Download} onClick={exportCsv}>
                Export CSV
              </Button>
            )}
          </>
        }
      />

      {verdict && (
        <Banner
          className="mb-4"
          tone={verdict.ok ? "good" : "crit"}
          title={verdict.ok ? "The audit log is intact" : "The audit log has been tampered with"}
          onDismiss={() => setVerdict(null)}
        >
          {verdict.ok
            ? `All ${verdict.checked.toLocaleString()} events were checked and every one matches its recorded fingerprint.`
            : `Event #${verdict.first_bad_id} doesn't match its fingerprint (${verdict.checked.toLocaleString()} earlier events were fine). Treat the log from that point as untrustworthy and investigate.`}
        </Banner>
      )}

      <Card padding="none" className="overflow-hidden">
        <div className="p-3 border-b border-line grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Search" className="lg:col-span-2">
            {() => <SearchInput value={q} onChange={setQ} placeholder="Action, person or record id…" aria-label="Search the audit log" />}
          </Field>
          <Field label="Activity">
            {(id) => <Select id={id} value={action} onChange={(e) => setAction(e.target.value)} options={ACTION_PREFIXES} className="w-full" />}
          </Field>
          <Field label="Record type">
            {(id) => (
              <Select
                id={id}
                value={entityType}
                onChange={(e) => setEntityType(e.target.value)}
                className="w-full"
                options={[{ value: "", label: "Any" }, ...ENTITY_TYPES.map((t) => ({ value: t, label: humanize(t) }))]}
              />
            )}
          </Field>
          <Field label="Done by">
            {(id) => <TextInput id={id} type="search" value={actor} onChange={(e) => setActor(e.target.value)} placeholder="person@company.com" onClear={() => setActor("")} />}
          </Field>
          <Field label="Record id">
            {(id) => <TextInput id={id} type="search" value={entityId} onChange={(e) => setEntityId(e.target.value)} placeholder="Exact id" onClear={() => setEntityId("")} />}
          </Field>
          <Field label="From">
            {(id) => <input id={id} type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="field h-8 px-3 text-sm" />}
          </Field>
          <Field label="To">
            {(id) => <input id={id} type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="field h-8 px-3 text-sm" />}
          </Field>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 h-10 border-b border-line bg-panel2 text-[13px] text-ink2" aria-live="polite">
          <span>
            {loading && items.length === 0 ? "Loading…" : `${total.toLocaleString()} ${total === 1 ? "event" : "events"}${filtered ? " match your filters" : ""}`}
          </span>
          {filtered && (
            <button type="button" onClick={clearFilters} className="text-accent hover:underline">
              Clear filters
            </button>
          )}
        </div>

        {error && items.length === 0 ? (
          <ErrorState message={error.message} onRetry={() => void load(0)} />
        ) : loading && items.length === 0 ? (
          <TableSkeleton rows={8} columns={4} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={History}
            title={filtered ? "No events match" : "Nothing recorded yet"}
            description={filtered ? "Try widening the dates or clearing a filter." : "Events appear here as soon as someone changes something."}
            action={filtered ? <Button size="sm" onClick={clearFilters}>Clear filters</Button> : undefined}
          />
        ) : (
          <>
            <div className={clsx("overflow-x-auto transition-opacity", loading && "opacity-60")}>
              <table className="w-full border-collapse text-sm">
                <caption className="sr-only">Audit events, newest first</caption>
                <thead>
                  <tr className="bg-panel2 border-b border-line text-left text-xs font-semibold text-ink2">
                    <th scope="col" className="w-10 pl-3 py-2.5">
                      <span className="sr-only">Details</span>
                    </th>
                    <th scope="col" className="px-3 py-2.5 whitespace-nowrap">When</th>
                    <th scope="col" className="px-3 py-2.5">What happened</th>
                    <th scope="col" className="px-3 py-2.5 hidden sm:table-cell">Done by</th>
                    <th scope="col" className="px-3 py-2.5 hidden md:table-cell">Record</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((e) => {
                    const isOpen = open.has(e.id);
                    return (
                      <Fragment key={e.id}>
                        <tr onClick={() => toggle(e.id)} className={clsx("mc-row border-b border-line-soft cursor-pointer hover:bg-panel2", isOpen && "bg-panel2")}>
                          <td className="pl-3 py-2.5 align-top">
                            <button
                              type="button"
                              aria-expanded={isOpen}
                              aria-controls={`audit-detail-${e.id}`}
                              aria-label={`${isOpen ? "Hide" : "Show"} details of ${e.action}`}
                              onClick={(ev) => {
                                ev.stopPropagation();
                                toggle(e.id);
                              }}
                              className="w-6 h-6 rounded flex items-center justify-center text-ink3 hover:text-ink hover:bg-panel3"
                            >
                              {isOpen ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
                            </button>
                          </td>
                          <td className="px-3 py-2.5 align-top whitespace-nowrap text-[13px] text-ink2 tabular">{fmtDateTime(e.at)}</td>
                          <td className="px-3 py-2.5 align-top min-w-0">
                            <div className="font-medium text-ink">{humanize(e.action)}</div>
                            <div className="font-mono text-[11px] text-ink3 break-all">{e.action}</div>
                            <div className="sm:hidden text-xs text-ink2 mt-0.5 truncate">{e.actor}</div>
                          </td>
                          <td className="px-3 py-2.5 align-top hidden sm:table-cell text-[13px] text-ink break-all">{e.actor}</td>
                          <td className="px-3 py-2.5 align-top hidden md:table-cell">
                            <div className="text-[13px] text-ink">{humanize(e.entity_type)}</div>
                            <div className="font-mono text-[11px] text-ink3" title={e.entity_id}>
                              {shortId(e.entity_id)}
                            </div>
                          </td>
                        </tr>
                        {isOpen && (
                          <tr id={`audit-detail-${e.id}`} className="bg-panel2 border-b border-line-soft">
                            <td />
                            <td colSpan={4} className="px-3 pb-4 pt-1">
                              <EventDetail e={e} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-t border-line">
              <span className="text-[13px] text-ink2" aria-live="polite">
                Showing {items.length.toLocaleString()} of {total.toLocaleString()}
              </span>
              {error && <span role="alert" className="text-[13px] text-crit">{error.message}</span>}
              {items.length < total && (
                <Button loading={loadingMore} onClick={() => void load(items.length)}>
                  Load more
                </Button>
              )}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
