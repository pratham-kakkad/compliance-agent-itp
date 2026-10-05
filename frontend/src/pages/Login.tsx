import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { BarChart3, Blocks, ChevronRight, MoonStar, ShieldCheck, Sun } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { api } from "../lib/api";
import { useTheme } from "../lib/useTheme";
import { duration, ease } from "../lib/motion";
import { Avatar, Banner, Button, IconButton, Skeleton, Spinner } from "../components/ui";
import { LogoScene } from "../components/three/LogoScene";
import { LogoMark } from "../components/brand/Logo";
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

const FEATURES = [
  { icon: Blocks, text: "Pluggable compliance agents — Meetings and Attendance today" },
  { icon: BarChart3, text: "Org-aware trends, scoring and the people who need a nudge" },
  { icon: ShieldCheck, text: "Single sign-on with your Microsoft work account" },
];

type Status = "idle" | "loading" | "loaded" | "error";

export function Login() {
  const { config } = useAuth();
  const { theme, toggle } = useTheme();
  const [directory, setDirectory] = useState<DirectoryEntry[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Sign in · INT Comply";
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

  const go = (key: string, url: string) => {
    setPending(key);
    window.location.href = url;
  };

  return (
    <div className="min-h-screen bg-canvas flex flex-col">
      <div className="flex justify-end p-4">
        <IconButton icon={theme === "dark" ? Sun : MoonStar} label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} onClick={toggle} />
      </div>

      <main className="flex-1 flex flex-col items-center px-4 pb-12 pt-4 sm:pt-10">
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: duration.medium, ease: ease.decelerate }}
          className="w-full max-w-[400px]"
        >
          <div
            className="relative mb-6 overflow-hidden rounded-2xl border border-white/10 text-center shadow-lg"
            style={{ background: "radial-gradient(80% 90% at 50% 30%, #123a86 0%, #0a1d4d 55%, #050d26 100%)" }}
          >
            <LogoScene
              variant="hero"
              className="h-[220px] w-full"
              fallback={
                <div className="flex h-full items-center justify-center">
                  <LogoMark size={120} tone="dark" intro />
                </div>
              }
            />
            <div className="relative -mt-4 px-6 pb-6">
              <p className="text-[11.5px] font-bold uppercase tracking-[0.2em] text-[color:var(--copper-light)]">INT Comply</p>
              <h1 className="mt-2 text-2xl font-semibold tracking-[-0.01em] text-white">Sign in to INT Comply</h1>
              <p className="mt-1.5 text-sm text-white/65">Every compliance signal across your org, in one place.</p>
            </div>
          </div>

          <div className="bg-panel border border-line rounded-xl shadow-sm p-6 sm:p-8">
            <Button
              size="lg"
              block
              loading={pending === "ms"}
              onClick={() => go("ms", "/auth/login")}
              className="!bg-panel hover:!bg-panel2"
            >
              {pending !== "ms" && <MicrosoftLogo />}
              Sign in with Microsoft
            </Button>

            {config && !config.microsoft_configured && (
              <Banner tone="info" className="mt-4 !px-3 !py-2.5 text-[13px]">
                Microsoft sign-in isn't configured in this environment yet. Use a demo account below.
              </Banner>
            )}

            {config?.demo_login_enabled && (
              <>
                <div className="flex items-center gap-3 my-6" role="separator">
                  <span className="h-px flex-1 bg-line" />
                  <span className="text-xs text-ink2">or explore with a demo account</span>
                  <span className="h-px flex-1 bg-line" />
                </div>

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

          <ul className="stagger mt-8 flex flex-col gap-3 px-2">
            {FEATURES.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3 text-[13px] text-ink2">
                <Icon size={16} className="text-ink3 flex-none" aria-hidden />
                {text}
              </li>
            ))}
          </ul>
        </motion.div>
      </main>

      <footer className="py-6 text-center text-xs text-ink3">INT Comply · Integrated Compliance Solutions · Secured with Microsoft Entra ID</footer>
    </div>
  );
}
