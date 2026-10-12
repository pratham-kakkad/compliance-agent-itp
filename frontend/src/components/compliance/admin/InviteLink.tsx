import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Check, Copy, MailCheck } from "lucide-react";
import { api } from "../../../lib/api";
import { fmtDateTime } from "../../../lib/format";
import { useCompliance } from "../../../lib/ComplianceContext";
import type { AdminUser } from "../../../lib/compliance";
import { Banner, Button, Label, TextInput } from "../../ui";
import { useOverlay } from "../../Modal";
import { toastError } from "../common";

/** What the server returns when it makes an invite or password-reset link. */
export interface LinkResult {
  link_kind: "invite" | "reset";
  invite_url: string;
  expires_at: string | null;
  email_sent: boolean;
  email_error: string | null;
  smtp_configured: boolean;
}

/** The sign-in state shown next to a person. */
export function StatusLabel({ user }: { user: Pick<AdminUser, "status" | "is_active"> }) {
  const status = user.status ?? (user.is_active ? "active" : "disabled");
  if (status === "invited") return <Label tone="warn" size="sm" dot>Invited</Label>;
  if (status === "disabled") return <Label tone="neutral" size="sm" dot>Disabled</Label>;
  return <Label tone="good" size="sm" dot>Active</Label>;
}

/** "5 Oct, 14:02", or a dash when they've never signed in. */
export function lastSignIn(iso: string | null | undefined): string {
  return iso ? fmtDateTime(iso) : "Never";
}

function copyText(text: string, input: HTMLInputElement | null): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => false
    );
  }
  // Plain-http hosts have no clipboard API: select the field and use the old command.
  try {
    input?.focus();
    input?.select();
    return Promise.resolve(document.execCommand("copy"));
  } catch {
    return Promise.resolve(false);
  }
}

/** The link, a Copy button, and a plain explanation of whether it was e-mailed. */
export function InviteLinkBox({ name, email, result }: { name: string; email: string; result: LinkResult }) {
  const { can } = useCompliance();
  const ref = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const isInvite = result.link_kind === "invite";

  async function copy() {
    const ok = await copyText(result.invite_url, ref.current);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } else {
      ref.current?.select();
      toast.error("Couldn't copy automatically", { description: "The link is selected: press Ctrl+C." });
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {result.email_sent ? (
        <Banner tone="good" icon={MailCheck} title={`E-mailed to ${email}`}>
          {name} has the link in their inbox. You can also copy it below.
        </Banner>
      ) : !result.smtp_configured ? (
        <Banner tone="warn" title="No e-mail was sent">
          E-mail isn't set up on this server, so send {name} the link below yourself (chat, text, anything private).{" "}
          {can("settings", "configure") && (
            <>
              Set it up under{" "}
              <Link to="/settings" className="text-accent underline">
                Settings &gt; Email (SMTP)
              </Link>
              .
            </>
          )}
        </Banner>
      ) : (
        <Banner tone="warn" title="The e-mail couldn't be sent">
          {result.email_error ?? "The mail server didn't accept it."} Send {name} the link below yourself, or fix the e-mail settings and send it again.
        </Banner>
      )}

      <div className="flex flex-col gap-1.5">
        <label htmlFor="invite-link" className="text-[13px] font-semibold text-ink">
          {isInvite ? "Invite link" : "Password reset link"}
        </label>
        <div className="flex items-center gap-2">
          <TextInput
            id="invite-link"
            ref={ref}
            readOnly
            value={result.invite_url}
            onFocus={(e) => e.currentTarget.select()}
            className="flex-1 min-w-0"
            spellCheck={false}
          />
          <Button variant="primary" leadingIcon={copied ? Check : Copy} onClick={() => void copy()} aria-live="polite">
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <p className="text-xs text-ink2">
          Works once{result.expires_at ? `, until ${fmtDateTime(result.expires_at)}` : ""}. Anyone holding it can set {name}'s password, so share it only with {name}.
        </p>
      </div>
    </div>
  );
}

/** A dialog that shows a freshly made link. */
export function LinkDialog({ title, name, email, result }: { title: string; name: string; email: string; result: LinkResult }) {
  const { close } = useOverlay();
  return (
    <div className="flex flex-col gap-4">
      <div className="pr-6">
        <h2 className="text-lg font-semibold text-ink">{title}</h2>
        <p className="text-sm text-ink2 mt-1">
          {name} · {email}
        </p>
      </div>
      <InviteLinkBox name={name} email={email} result={result} />
      <div className="flex justify-end">
        <Button variant="primary" onClick={close}>
          Done
        </Button>
      </div>
    </div>
  );
}

const userPath = (email: string) => `/compliance/admin/users/${encodeURIComponent(email)}`;

/** "Resend invite" / "Send reset link": call the server, then show the link in a dialog. */
export function useLinkActions(onDone?: () => void) {
  const { openModal } = useOverlay();
  const { can } = useCompliance();
  const canEdit = can("user", "edit");

  async function make(user: Pick<AdminUser, "email" | "name">, path: "invite" | "reset-password", title: string) {
    try {
      const result = await api.post<LinkResult>(`${userPath(user.email)}/${path}`);
      openModal(<LinkDialog title={title} name={user.name} email={user.email} result={result} />);
      onDone?.();
    } catch (err) {
      toastError(path === "invite" ? "Couldn't resend the invite" : "Couldn't make a reset link", err);
    }
  }

  return {
    canEdit,
    /** Someone who has never set a password and isn't signed in yet. */
    canInvite: (u: Pick<AdminUser, "status" | "is_demo" | "is_active">) => canEdit && u.is_active && !u.is_demo && u.status === "invited",
    /** Anyone real and active; for an invitee this makes a fresh invite instead. */
    canReset: (u: Pick<AdminUser, "status" | "is_demo" | "is_active">) => canEdit && u.is_active && !u.is_demo,
    resendInvite: (u: Pick<AdminUser, "email" | "name">) => make(u, "invite", "New invite link"),
    sendReset: (u: Pick<AdminUser, "email" | "name">) => make(u, "reset-password", "Password reset link"),
  };
}
