import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { AlertCircle, ArrowLeft, MailCheck } from "lucide-react";
import { useAuth } from "../../auth/AuthContext";
import { authApi } from "../../auth/authApi";
import { Banner, Button, TextInput } from "../../components/ui";
import { Field } from "../../components/compliance/common";

/** Ask for a password reset link. The answer is always the same, so it never says whether the address has an account. */
export function ForgotPassword() {
  const { config } = useAuth();
  const { state } = useLocation();
  const [email, setEmail] = useState((state as { email?: string } | null)?.email ?? "");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    document.title = "Reset your password · Encop";
  }, []);

  const problem = !email.trim() ? "Enter your e-mail address." : !/^\S+@\S+$/.test(email.trim()) ? "That doesn't look like an e-mail address." : null;
  const smtpOff = config?.smtp_configured === false;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    setError(null);
    if (problem) return;
    setBusy(true);
    try {
      await authApi.post("/auth/forgot-password", { email: email.trim() });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send the request. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="glass rounded-2xl p-6 sm:p-8 text-center">
        <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-info-bg text-info">
          <MailCheck size={20} aria-hidden />
        </span>
        <h1 className="text-xl font-semibold tracking-[-0.01em] text-ink">Check your e-mail</h1>
        <p className="mt-2 text-sm text-ink2">
          If <strong className="text-ink">{email.trim()}</strong> has an Encop account, a link to choose a new password is on its way. It works once and expires in an hour.
        </p>
        {smtpOff && (
          <Banner tone="warn" className="mt-4 text-left !px-3 !py-2.5 text-[13px]">
            This server can't send e-mail yet. Ask an administrator to send you a reset link from Administration &gt; Users.
          </Banner>
        )}
        <Link to="/login" className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline">
          <ArrowLeft size={14} aria-hidden /> Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="glass rounded-2xl p-6 sm:p-8">
      <h1 className="text-xl font-semibold tracking-[-0.01em] text-ink">Forgot your password?</h1>
      <p className="mt-1 text-sm text-ink2">Enter your e-mail address and we'll send you a link to choose a new one.</p>

      {smtpOff && (
        <Banner tone="warn" className="mt-4 !px-3 !py-2.5 text-[13px]">
          E-mail isn't set up on this server, so no message can be sent. Ask an administrator to send you a reset link.
        </Banner>
      )}

      <form onSubmit={(e) => void submit(e)} noValidate className="mt-5 flex flex-col gap-4">
        <Field label="E-mail" error={touched ? problem : null}>
          {(id) => (
            <TextInput
              id={id}
              type="email"
              size="lg"
              autoFocus
              autoComplete="username"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              invalid={touched && Boolean(problem)}
              placeholder="name@company.com"
              disabled={busy}
            />
          )}
        </Field>
        {error && (
          <Banner tone="crit" icon={AlertCircle} className="!px-3 !py-2.5 text-[13px]">
            {error}
          </Banner>
        )}
        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          Send reset link
        </Button>
      </form>

      <div className="mt-5 text-center">
        <Link to="/login" className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline">
          <ArrowLeft size={14} aria-hidden /> Back to sign in
        </Link>
      </div>
    </div>
  );
}
