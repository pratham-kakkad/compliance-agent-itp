/**
 * Evidence display + review actions shared by the obligation page and the review queue:
 * what a person submitted (text, links, ticks, files with preview), a "who decided what" trail,
 * and the Approve / Request changes calls.
 */
import { useState } from "react";
import clsx from "clsx";
import { toast } from "sonner";
import { CheckCircle2, Circle, Download, ExternalLink, FileText, Link2, TriangleAlert } from "lucide-react";
import { api } from "../../lib/api";
import { fmtBytes, fmtDateTime } from "../../lib/format";
import type { EvidenceItem, EvidenceRequirement, ReviewDecision, Submission } from "../../lib/compliance";
import { Label } from "../ui";
import { toastError, useReasonPrompt } from "./common";

export function isImageMime(mime: string | undefined): boolean {
  return Boolean(mime && mime.startsWith("image/"));
}

export function downloadUrl(fileId: string, inline = false): string {
  return `/compliance/evidence/${fileId}/download${inline ? "?inline=true" : ""}`;
}

/** The newest submission (highest version), or null. */
export function latestSubmission(subs: Submission[] | undefined): Submission | null {
  if (!subs || subs.length === 0) return null;
  return subs.reduce((a, b) => (b.version > a.version ? b : a));
}

function isWebLink(s: string | null): s is string {
  return Boolean(s && /^https?:\/\/\S+$/i.test(s));
}

function ItemValue({ item, showSameFileNote }: { item: EvidenceItem; showSameFileNote: boolean }) {
  const [imgFailed, setImgFailed] = useState(false);
  if (item.kind === "file") {
    const f = item.file;
    if (!f) return <span className="text-ink3 text-sm">No file</span>;
    return (
      <div className="flex flex-col gap-2 min-w-0">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <FileText size={16} className="text-ink2 flex-none" aria-hidden />
          <a
            href={downloadUrl(f.id)}
            className="text-sm font-medium text-accent hover:underline truncate max-w-full"
            download={f.name}
          >
            {f.name}
          </a>
          <span className="text-xs text-ink3 tabular">{fmtBytes(f.size)}</span>
          <a
            href={downloadUrl(f.id)}
            download={f.name}
            aria-label={`Download ${f.name}`}
            className="inline-flex items-center gap-1 text-xs text-ink2 hover:text-ink"
          >
            <Download size={13} aria-hidden /> Download
          </a>
        </div>
        {isImageMime(f.mime) && !imgFailed && (
          <a href={downloadUrl(f.id, true)} target="_blank" rel="noopener noreferrer" className="block w-fit">
            <img
              src={downloadUrl(f.id, true)}
              alt={`Preview of ${f.name}`}
              loading="lazy"
              onError={() => setImgFailed(true)}
              className="max-h-48 max-w-full rounded-md border border-line object-contain bg-panel2"
            />
          </a>
        )}
        {showSameFileNote && f.same_file_used_by_others > 0 && (
          <p className="flex items-start gap-1.5 text-[13px] text-warn" role="note">
            <TriangleAlert size={14} className="mt-0.5 flex-none" aria-hidden />
            <span>
              The same file was used by {f.same_file_used_by_others} other {f.same_file_used_by_others === 1 ? "person" : "people"} for this
              compliance. Worth a closer look.
            </span>
          </p>
        )}
      </div>
    );
  }
  if (item.kind === "attestation") {
    return item.checked ? (
      <span className="inline-flex items-center gap-1.5 text-sm text-good"><CheckCircle2 size={16} aria-hidden /> Confirmed</span>
    ) : (
      <span className="inline-flex items-center gap-1.5 text-sm text-ink3"><Circle size={16} aria-hidden /> Not confirmed</span>
    );
  }
  if (item.kind === "url") {
    if (isWebLink(item.text)) {
      return (
        <a href={item.text} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline break-all">
          <Link2 size={14} className="flex-none" aria-hidden />
          {item.text}
          <ExternalLink size={12} className="flex-none" aria-hidden />
        </a>
      );
    }
    return <span className="text-sm text-ink break-all">{item.text}</span>;
  }
  return <p className="text-sm text-ink whitespace-pre-wrap break-words">{item.text}</p>;
}

/** The evidence in one submission, labelled with the requirement each item answers. */
export function EvidenceList({
  items,
  requirements,
  showSameFileNote = false,
  compact = false,
}: {
  items: EvidenceItem[];
  requirements?: EvidenceRequirement[];
  showSameFileNote?: boolean;
  compact?: boolean;
}) {
  if (items.length === 0) return <p className="text-sm text-ink3">Nothing was attached.</p>;
  const label = (key: string) => requirements?.find((r) => r.key === key)?.label ?? key;
  return (
    <dl className={clsx("flex flex-col", compact ? "gap-2" : "gap-3")}>
      {items.map((it) => (
        <div key={it.key} className="min-w-0">
          <dt className="text-xs font-medium text-ink2 mb-0.5">{label(it.key)}</dt>
          <dd className="min-w-0"><ItemValue item={it} showSameFileNote={showSameFileNote} /></dd>
        </div>
      ))}
    </dl>
  );
}

/** One reviewer decision: who, when, what and why. */
export function DecisionLine({ d }: { d: ReviewDecision }) {
  const approved = d.decision === "approved";
  return (
    <div
      className={clsx(
        "rounded-md border px-3 py-2 text-sm",
        approved ? "bg-good-bg border-transparent" : "bg-warn-bg border-transparent"
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <Label tone={approved ? "good" : "warn"} size="sm">{approved ? "Approved" : "Changes requested"}</Label>
        <span className="text-ink2 text-[13px]">
          by {d.reviewer?.name ?? "a reviewer"} · {fmtDateTime(d.decided_at)}
        </span>
      </div>
      {d.reason && <p className="mt-1.5 text-ink whitespace-pre-wrap break-words">{d.reason}</p>}
    </div>
  );
}

/** Approve / Request changes calls. Each resolves true when the server accepted the decision. */
export function useReviewActions() {
  const askReason = useReasonPrompt();

  async function approve(sub: Submission, name?: string): Promise<boolean> {
    try {
      await api.post(`/compliance/submissions/${sub.id}/review`, { decision: "approved", reason: "" });
      toast.success(name ? `Approved ${name}` : "Approved");
      return true;
    } catch (e) {
      toastError("Couldn't approve", e);
      return false;
    }
  }

  /** Opens the reason dialog; `onDone` runs after the server accepted the decision. */
  function requestChanges(sub: Submission, onDone: () => void, who?: string) {
    askReason({
      title: "Request changes",
      description: who ? `${who} will be asked to fix this and submit again.` : "They will be asked to fix this and submit again.",
      label: "What needs to change?",
      confirm: "Request changes",
      tone: "danger",
      onSubmit: async (reason) => {
        await api.post(`/compliance/submissions/${sub.id}/review`, { decision: "rejected", reason });
        toast.success("Changes requested");
        onDone();
      },
    });
  }

  return { approve, requestChanges };
}
