import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AlertCircle, LinkIcon } from "lucide-react";
import { useAuth } from "../../auth/AuthContext";
import { authApi } from "../../auth/authApi";
import { Banner, Button, Skeleton } from "../../components/ui";
import { PasswordField, PasswordHint, MIN_LENGTH } from "../../components/auth/PasswordField";
import { Field } from "../../components/compliance/common";

type Mode = "invite" | "reset";
type Invite = { name: string; email: string };

/**
 * Choose a password from a one-time link. "invite": a new account's first
 * password (and the person is signed in afterwards); "reset": a forgotten one
 * (then back to the sign-in page).
 */
export function SetPassword({ mode }: { mode: Mode }) {
  const { token = "" } = useParams();
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [invite, setInvite] = useState<Invite | null>(null);
  const [checking, setChecking] = useState(mode === "invite");
  const [badLink, setBadLink] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = (mode === "invite" ? "Set your password" : "Reset your password") + " · Encop";
  }, [mode]);

  // An invite link can be checked up front, so a dead link says so instead of after typing a password.
  useEffect(() => {
    if (mode !== "invite") return;
    let live = true;
    authApi
      .get<Invite>(`/auth/invite/${encodeURIComponent(token)}`)
      .then((i) => live && setInvite(i))
      .catch((e) => live && setBadLink(e instanceof Error ? e.message : "This link isn't valid."))
      .finally(() => live && setChecking(false));
    return () => {
      live = false;
    };
  }, [mode, token]);

  const longEnough = password.length >= MIN_LENGTH;
  const matches = password === confirm;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    setError(null);
    if (!longEnough || !matches) return;
    setBusy(true);
    try {
      if (mode === "invite") {
        await authApi.post("/auth/invite/accept", { token, password });
        navigate("/", { replace: true });
        await refresh(); // the server signed them in
      } else {
        await authApi.post("/auth/reset-password", { token, password });
        navigate("/login", { replace: true, state: { notice: "Password updated. Sign in with your new password." } });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Couldn't save the password.";
      if (/link is invalid|expired|already used/i.test(msg)) setBadLink(msg);
      else setError(msg);
      setBusy(false);
    }
  }

  if (checking) {
    return (
      <div className="glass rounded-2xl p-6 sm:p-8" aria-busy="true">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="mt-3 h-4 w-64" />
        <Skeleton className="mt-6 h-10 w-full" />
        <Skeleton className="mt-4 h-10 w-full" />
      </div>
    );
  }

  if (badLink) {
    return (
      <div className="glass rounded-2xl p-6 sm:p-8 text-center">
        <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-warn-bg text-warn">
          <LinkIcon size={20} aria-hidden />
        </span>
        <h1 className="text-xl font-semibold tracking-[-0.01em] text-ink">This link no longer works</h1>
        <p className="mt-2 text-sm text-ink2">{badLink}</p>
        <div className="mt-6 flex flex-col gap-2">
          <Link to="/forgot" className="btn-primary inline-flex h-10 items-center justify-center rounded-md px-4 text-sm font-semibold text-white">
            Get a new link
          </Link>
          <Link to="/login" className="text-sm font-medium text-accent hover:underline">
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  const title = mode === "invite" ? `Welcome${invite ? `, ${invite.name.split(" ")[0]}` : ""}` : "Choose a new password";
  const intro = mode === "invite" ? "Set a password to finish creating your account." : "Pick a password you haven't used before.";

  return (
    <div className="glass rounded-2xl p-6 sm:p-8">
      <h1 className="text-xl font-semibold tracking-[-0.01em] text-ink">{title}</h1>
      <p className="mt-1 text-sm text-ink2">{intro}</p>
      {invite && (
        <p className="mt-3 rounded-md border border-line bg-panel2 px-3 py-2 text-[13px] text-ink2">
          Signing in as <strong className="text-ink">{invite.email}</strong>
        </p>
      )}

      <form onSubmit={(e) => void submit(e)} noValidate className="mt-5 flex flex-col gap-4">
        {/* Lets password managers file the new password under the right account. */}
        {invite && <input type="text" name="username" autoComplete="username" value={invite.email} readOnly hidden />}
        <Field label="New password" error={touched && !longEnough ? `Use at least ${MIN_LENGTH} characters.` : null}>
          {(id) => (
            <>
              <PasswordField id={id} value={password} onChange={setPassword} autoComplete="new-password" autoFocus invalid={touched && !longEnough} disabled={busy} describedBy={`${id}-hint`} />
              <PasswordHint id={`${id}-hint`} value={password} />
            </>
          )}
        </Field>
        <Field label="Confirm password" error={touched && longEnough && !matches ? "The two passwords don't match." : null}>
          {(id) => <PasswordField id={id} value={confirm} onChange={setConfirm} autoComplete="new-password" invalid={touched && !matches} disabled={busy} />}
        </Field>

        {error && (
          <Banner tone="crit" icon={AlertCircle} className="!px-3 !py-2.5 text-[13px]">
            {error}
          </Banner>
        )}

        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          {mode === "invite" ? "Set password and continue" : "Save new password"}
        </Button>
      </form>

      {mode === "reset" && (
        <div className="mt-5 text-center">
          <Link to="/login" className="text-sm font-medium text-accent hover:underline">
            Back to sign in
          </Link>
        </div>
      )}
    </div>
  );
}
