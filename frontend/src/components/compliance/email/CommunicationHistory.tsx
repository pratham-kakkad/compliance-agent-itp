import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, Mail } from "lucide-react";
import clsx from "clsx";
import { useApi } from "../../../lib/useApi";
import { fmtDateTime } from "../../../lib/format";
import { useCanSeeEmailHistory, type SentEmailRow } from "../../../lib/emailTemplates";
import { Card, CardHeader, EmptyState, ErrorState, Label, Skeleton } from "../../ui";
import { KindChip } from "./KindChip";

const STATUS: Record<SentEmailRow["status"], { tone: "good" | "crit" | "neutral" | "accent"; text: string }> = {
  sent: { tone: "good", text: "Sent" },
  failed: { tone: "crit", text: "Didn't send" },
  queued: { tone: "accent", text: "Sending" },
  skipped: { tone: "neutral", text: "Skipped" },
};

/**
 * What was e-mailed to someone about compliance, newest first. `query` filters it, e.g. `obligation_id=…` or
 * `person=…`. Shows nothing at all to people who may not read sent mail. `refresh` changes to reload it.
 */
export function CommunicationHistory({
  query,
  title = "Communication history",
  description,
  refresh = 0,
  showPerson,
  className,
}: {
  query: string;
  title?: string;
  description?: string;
  refresh?: number;
  /** Name the recipient on each row (when the history covers more than one person). */
  showPerson?: boolean;
  className?: string;
}) {
  const allowed = useCanSeeEmailHistory();
  const { data, error, initialLoading, reload } = useApi<{ total: number; items: SentEmailRow[] }>(allowed ? `/compliance/emails/history?${query}&limit=50` : null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (refresh > 0) reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  if (!allowed) return null;
  const items = data?.items ?? [];

  return (
    <Card as="section" padding="none" className={clsx("overflow-hidden", className)}>
      <div className="p-4 pb-3">
        <CardHeader
          icon={Mail}
          title={title}
          description={description ?? "E-mails sent about this from Encop."}
          className="!mb-0"
          actions={data && data.total > 0 ? <span className="text-xs text-ink2 tabular">{data.total}</span> : undefined}
        />
      </div>
      <div className="border-t border-line">
        {error && !data ? (
          <ErrorState compact title="Couldn't load the history" message={error.message} onRetry={reload} />
        ) : initialLoading ? (
          <div className="p-4 flex flex-col gap-3" aria-busy="true">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState compact icon={Mail} title="Nothing has been e-mailed yet" description="Messages sent from the Email button are listed here with who sent them and when." />
        ) : (
          <ul className="divide-y divide-line-soft">
            {items.map((m) => {
              const isOpen = open === m.id;
              const st = STATUS[m.status];
              return (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => setOpen(isOpen ? null : m.id)}
                    aria-expanded={isOpen}
                    className="w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-panel2 focus-visible:bg-panel2 focus-visible:outline-none"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-ink break-words min-w-0">{m.subject}</span>
                        <KindChip kind={m.kind} size="sm" />
                        <Label tone={st.tone} size="sm" dot>
                          {st.text}
                        </Label>
                      </div>
                      <p className="text-xs text-ink2 mt-1">
                        {showPerson && (
                          <>
                            To <span className="text-ink">{m.recipient.name || m.recipient.email}</span> ·{" "}
                          </>
                        )}
                        {m.sent_by ? `Sent by ${m.sent_by.name}` : "Sent"} · {fmtDateTime(m.created_at)}
                        {m.cc.length > 0 && ` · cc ${m.cc.join(", ")}`}
                      </p>
                    </div>
                    <ChevronDown size={16} className={clsx("text-ink3 mt-1 flex-none transition-transform", isOpen && "rotate-180")} aria-hidden />
                  </button>
                  {isOpen && (
                    <div className="px-4 pb-4">
                      {m.error && <p className="text-[13px] text-crit mb-2">{m.error}</p>}
                      <pre className="whitespace-pre-wrap break-words rounded-lg border border-line bg-panel2 p-3 text-[13px] leading-5 text-ink font-sans">{m.body}</pre>
                      <p className="text-xs text-ink2 mt-2">
                        Template: {m.template_name || "written by hand"}
                        {m.obligation_id && (
                          <>
                            {" · "}
                            <Link to={`/compliance/obligations/${m.obligation_id}`} className="text-accent hover:underline">
                              {m.compliance ?? "Open the item"}
                            </Link>
                          </>
                        )}
                      </p>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}
