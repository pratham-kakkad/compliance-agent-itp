import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { AlertCircle, ChevronRight } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { api } from "../lib/api";
import { authApi } from "../auth/authApi";
import { Avatar, Banner, Button, Skeleton, Spinner, TextInput } from "../components/ui";
import { PasswordField } from "../components/auth/PasswordField";
import { Field } from "../components/compliance/common";
import type { DirectoryEntry } from "../types";

function MicrosoftLogo() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <rect x="0" y="0" width="7.5" height="7.5" fill="#F25022" />
      <rect x="8.5" y="0" width="7.5" height="7.5" fill="#7FBA00" />
      <rect x="0" y="8.5" width="7.5" height="7.5" fill="#00A4EF" />
      <rect x="8.5" y="8.5" width="7.5" height="7.5" fill="#FFB900" />
    </svg>
  );
}

function Divider({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 my-6" role="separator">
      <span className="h-px flex-1 bg-line" />
      <span className="text-xs text-ink2">{children}</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

type DirStatus = "idle" | "loading" | "loaded" | "error";

export function Login() {
  const { config, refresh } = useAuth();
  const navigate = useNavigate();
  const { pathname, state } = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [directory, setDirectory] = useState<DirectoryEntry[]>([]);
  const [status, setStatus] = useState<DirStatus>("idle");
  const [pending, setPending] = useState<string | null>(null);
  const notice = (state as { notice?: string } | null)?.notice;

  useEffect(() => {
    document.title = "Sign in · Encop";
  }, []);

  const loadDirectory = useCallback(() => {
    setStatus("loading");
    api
      .get<DirectoryEntry[]>("/auth/dev-login-directory")
      .then((entries) => {
        setDirectory(entries);
        setStatus("loaded");
      })
      .catch(() => setStatus("error"));
  }, []);

  useEffect(() => {
    if (config?.demo_login_enabled) loadDirectory();
  }, [config?.demo_login_enabled, loadDirectory]);

  const emailProblem = !email.trim() ? "Enter your e-mail address." : !/^\S+@\S+$/.test(email.trim()) ? "That doesn't look like an e-mail address." : null;
  const passwordProblem = !password ? "Enter your password." : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    setError(null);
    if (emailProblem || passwordProblem) return;
    setBusy(true);
    try {
      await authApi.post("/auth/password-login", { email: email.trim(), password });
      // Deep links keep their URL; /login itself goes to the dashboard.
      if (pathname === "/login") navigate("/", { replace: true });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't sign in. Try again.");
      setBusy(false);
    }
  }

  const go = (key: string, url: string) => {
    setPending(key);
    window.location.href = url;
  };

  const showMicrosoft = Boolean(config?.microsoft_configured);
  const showDemo = Boolean(config?.demo_login_enabled);

  return (
    <>
      <div className="glass rounded-2xl p-6 sm:p-8">
        <h1 className="text-xl font-semibold tracking-[-0.01em] text-ink">Sign in</h1>
        <p className="mt-1 text-sm text-ink2">Use the e-mail address and password for your Encop account.</p>

        {notice && (
          <Banner tone="good" className="mt-4 !px-3 !py-2.5 text-[13px]">
            {notice}
          </Banner>
        )}

        <form onSubmit={(e) => void submit(e)} noValidate className="mt-5 flex flex-col gap-4">
          <Field label="E-mail" error={touched ? emailProblem : null}>
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
                invalid={touched && Boolean(emailProblem)}
                placeholder="name@company.com"
                disabled={busy}
              />
            )}
          </Field>
          <Field label="Password" error={touched ? passwordProblem : null}>
            {(id) => <PasswordField id={id} value={password} onChange={setPassword} invalid={touched && Boolean(passwordProblem)} disabled={busy} />}
          </Field>

          <div className="-mt-2 flex justify-end">
            <Link to="/forgot" state={{ email: email.trim() }} className="text-[13px] font-medium text-accent hover:underline">
              Forgot password?
            </Link>
          </div>

          {error && (
            <Banner tone="crit" icon={AlertCircle} className="!px-3 !py-2.5 text-[13px]">
              {error}
            </Banner>
          )}

          <Button type="submit" variant="primary" size="lg" block loading={busy}>
            Sign in
          </Button>
        </form>

        {showMicrosoft && (
          <>
            <Divider>or</Divider>
            <Button size="lg" block loading={pending === "ms"} onClick={() => go("ms", "/auth/login")} className="!bg-[var(--glass-strong)]">
              {pending !== "ms" && <MicrosoftLogo />}
              Sign in with Microsoft
            </Button>
          </>
        )}

        {showDemo && (
          <>
            <Divider>or explore with a demo account</Divider>

            {status === "loading" && (
              <div className="flex flex-col gap-2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex items-center gap-3 h-14 px-3 border border-line rounded-lg">
                    <Skeleton className="w-8 h-8 !rounded-full" />
                    <div className="flex-1">
                      <Skeleton className="h-3.5 w-28" />
                      <Skeleton className="h-3 w-40 mt-1.5" />
                    </div>
                  </div>
                ))}
              </div>
            )}

            {status === "error" && (
              <Banner tone="crit" action={<Button size="sm" onClick={loadDirectory}>Retry</Button>}>
                Couldn't load demo accounts.
              </Banner>
            )}

            {status === "loaded" && directory.length === 0 && <p className="text-[13px] text-ink2 text-center">No demo accounts are available right now.</p>}

            {status === "loaded" && directory.length > 0 && (
              <ul className="flex flex-col gap-2" aria-label="Demo accounts">
                {directory.map((p) => (
                  <li key={p.email}>
                    <button
                      type="button"
                      disabled={pending !== null}
                      onClick={() => go(p.email, `/auth/dev-login?email=${encodeURIComponent(p.email)}`)}
                      className="group w-full flex items-center gap-3 h-14 px-3 border border-line rounded-lg text-left hover:bg-panel2 hover:border-line-strong transition-colors duration-100 disabled:opacity-60"
                    >
                      <Avatar name={p.name} size={32} />
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm font-semibold text-ink truncate">{p.name}</span>
                        <span className="block text-[13px] text-ink2 truncate">{p.title}</span>
                      </span>
                      {pending === p.email ? (
                        <Spinner size={16} className="text-ink2" />
                      ) : (
                        <ChevronRight size={16} className="text-ink3 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-ink2" aria-hidden />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </>
  );
}
