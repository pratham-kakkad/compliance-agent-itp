import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { LogoScene } from "../three/LogoScene";
import { LogoMark } from "./Logo";
import { SPLASH_SEEN_KEY, setSplash } from "../../lib/splash";

const AFTER_READY_MS = 2900; // how long the splash holds once the 3D scene is on screen
const MAX_WAIT_MS = 6000; // never keep the splash longer than this, whatever happens
const EXIT_MS = 800;

function Letters({ text, className, start, step = 55 }: { text: string; className?: string; start: number; step?: number }) {
  return (
    <span aria-label={text}>
      {Array.from(text).map((ch, i) => (
        <span
          key={i}
          aria-hidden
          className={`splash-letter inline-block ${className ?? ""}`}
          style={{ animationDelay: `${start + i * step}ms` }}
        >
          {ch === " " ? " " : ch}
        </span>
      ))}
    </span>
  );
}

/**
 * Full-screen brand intro: the 3D INT Comply mark spins in over a particle field, the name types in, then
 * the whole thing lifts away to reveal the app. Plays once per browser session; click, Esc or Enter skips it.
 * The boot script in index.html sets `data-splash` before first paint (and hides this with CSS when it should
 * not play); a CSS failsafe lifts it after ~7 s even if scripts fail.
 */
export function Splash() {
  const [phase, setPhase] = useState<"show" | "exit" | "gone">(() =>
    document.documentElement.dataset.splash === "on" ? "show" : "gone",
  );
  const [ready, setReady] = useState(false);

  const finish = useCallback(() => {
    setPhase((p) => (p === "show" ? "exit" : p));
  }, []);

  useEffect(() => {
    if (phase !== "show") return;
    try {
      sessionStorage.setItem(SPLASH_SEEN_KEY, "1");
    } catch {
      /* private mode: it just plays again next time */
    }
    const t = window.setTimeout(finish, MAX_WAIT_MS);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter" || e.key === " ") finish();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [phase, finish]);

  useEffect(() => {
    if (!ready || phase !== "show") return;
    const t = window.setTimeout(finish, AFTER_READY_MS);
    return () => window.clearTimeout(t);
  }, [ready, phase, finish]);

  useEffect(() => {
    if (phase !== "exit") return;
    setSplash("off"); // the app's entrance animations start as the splash lifts
    const t = window.setTimeout(() => setPhase("gone"), EXIT_MS);
    return () => window.clearTimeout(t);
  }, [phase]);

  if (phase === "gone") return null;

  return createPortal(
    <div
      className={`splash fixed inset-0 z-[300] flex items-center justify-center overflow-hidden ${phase === "exit" ? "splash-exit" : ""}`}
      onClick={finish}
      role="presentation"
    >
      <div className="splash-bg absolute inset-0" />
      <LogoScene
        variant="splash"
        onReady={() => setReady(true)}
        className="absolute inset-0"
        fallback={<LogoMark size={220} tone="dark" intro className="absolute left-1/2 top-[38%] -translate-x-1/2 -translate-y-1/2" />}
      />
      <div className="pointer-events-none absolute inset-x-0 bottom-[11%] flex flex-col items-center px-6 text-center">
        <h1 className="text-[clamp(30px,6vw,64px)] font-extrabold leading-none tracking-[0.04em]">
          <Letters text="INT" start={1000} className="text-[#8db3f5]" />{" "}
          <Letters text="COMPLY" start={1250} className="text-copper" />
        </h1>
        <p className="splash-tag mt-4 text-[clamp(10px,1.5vw,14px)] font-bold uppercase tracking-[0.34em] text-[#aab4c8]">
          Integrated Compliance Solutions
        </p>
        <div className="splash-bar mt-8 h-[3px] w-[min(280px,60vw)] overflow-hidden rounded-full bg-white/10">
          <span
            className="block h-full origin-left rounded-full"
            style={{ background: "var(--copper-grad)", animation: `splash-load ${AFTER_READY_MS + 400}ms cubic-bezier(0.2,0.6,0.2,1) both` }}
          />
        </div>
      </div>
      <button
        type="button"
        onClick={finish}
        className="absolute right-5 top-5 rounded-full border border-white/15 bg-white/5 px-3.5 py-1.5 text-[12px] font-bold uppercase tracking-[0.14em] text-white/70 backdrop-blur transition hover:bg-white/15 hover:text-white"
      >
        Skip
      </button>
    </div>,
    document.body,
  );
}
