import { useState } from "react";
import { toast } from "sonner";
import { AlertCircle } from "lucide-react";
import { useAuth } from "../../auth/AuthContext";
import { api } from "../../lib/api";
import { Banner, Button } from "../ui";
import { useOverlay } from "../Modal";
import { Field } from "../compliance/common";
import { MIN_LENGTH, PasswordField, PasswordHint } from "./PasswordField";

/** Change your own password. Accounts that sign in with Microsoft only (no password yet) can set one without a current password. */
export function ChangePasswordDialog() {
  const { close } = useOverlay();
  const { me, refresh } = useAuth();
  const hasPassword = me?.has_password !== false;
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const longEnough = next.length >= MIN_LENGTH;
  const matches = next === confirm;
  const needCurrent = hasPassword && !current;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    setError(null);
    if (needCurrent || !longEnough || !matches) return;
    setBusy(true);
    try {
      await api.post("/auth/change-password", { current_password: current, new_password: next });
      toast.success("Password changed");
      void refresh();
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't change the password.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
      <div className="pr-6">
        <h2 className="text-lg font-semibold text-ink">{hasPassword ? "Change password" : "Set a password"}</h2>
        <p className="text-sm text-ink2 mt-1">{hasPassword ? "You stay signed in on this device." : "Lets you sign in with your e-mail and a password as well."}</p>
      </div>

      {hasPassword && (
        <Field label="Current password" error={touched && needCurrent ? "Enter your current password." : null}>
          {(id) => <PasswordField id={id} size="md" value={current} onChange={setCurrent} autoFocus invalid={touched && needCurrent} disabled={busy} />}
        </Field>
      )}
      <Field label="New password" error={touched && !longEnough ? `Use at least ${MIN_LENGTH} characters.` : null}>
        {(id) => (
          <>
            <PasswordField id={id} size="md" value={next} onChange={setNext} autoComplete="new-password" autoFocus={!hasPassword} invalid={touched && !longEnough} disabled={busy} describedBy={`${id}-hint`} />
            <PasswordHint id={`${id}-hint`} value={next} />
          </>
        )}
      </Field>
      <Field label="Confirm new password" error={touched && longEnough && !matches ? "The two passwords don't match." : null}>
        {(id) => <PasswordField id={id} size="md" value={confirm} onChange={setConfirm} autoComplete="new-password" invalid={touched && !matches} disabled={busy} />}
      </Field>

      {error && (
        <Banner tone="crit" icon={AlertCircle} className="!px-3 !py-2.5 text-[13px]">
          {error}
        </Banner>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={close} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={busy}>
          {hasPassword ? "Change password" : "Set password"}
        </Button>
      </div>
    </form>
  );
}
