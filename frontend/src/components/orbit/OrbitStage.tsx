import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { LogoScene, SceneDriver } from "../three/LogoScene";
import { LogoMark } from "../brand/Logo";
import { useTheme } from "../../lib/useTheme";
import type { DeckBlock } from "./types";

/** Every panel is laid out at this width and then scaled to fit the ring, so their content never reflows. */
const NATURAL_W = 640;
const TAU = Math.PI * 2;
const PERSPECTIVE = 1800;

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => t * t * (3 - 2 * t);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const mod = (n: number, m: number) => ((n % m) + m) % m;
/** Signed distance (in panels) from the front of the ring, wrapped into [-N/2, N/2). */
const around = (x: number, n: number) => mod(x + n / 2, n) - n / 2;
/** Angle between neighbouring panels. Capped so a short list still reads as a gentle arc, not a hard-turning cylinder. */
const visualStep = (n: number) => Math.min(TAU / n, 0.78);
/** Camera elevation: how far the whole scene is tipped so the floor dial is seen from above. */
const TILT_DEG = 14;
/** Strip at the bottom of the stage kept free of the 3D scene for the controls. */
const CONTROLS_H = 86;

/** Opacity of a panel `s` steps away from the front of the ring. */
function ringOpacity(s: number) {
  if (s < 0.5) return 1;
  if (s < 1) return lerp(1, 0.62, (s - 0.5) / 0.5);
  if (s < 2) return lerp(0.62, 0.26, s - 1);
  if (s < 3) return lerp(0.26, 0, s - 2);
  return 0;
}

type Engine = {
  N: number;
  theta: number;
  vel: number;
  target: number;
  k: number; // 1 = ring, 0 = unrolled flat strip
  kFrom: number;
  kTo: number;
  kStart: number;
  kDur: number;
  intro: number;
  introStart: number;
  introDur: number;
  W: number;
  H: number;
  cw: number;
  R: number;
  floorY: number;
  step: number;
  tagOffset: number;
  natH: number[];
  scale: number[];
  raf: number;
  last: number;
  active: number;
  unrolled: boolean;
  unrolling: boolean;
  reduce: boolean;
};

export function OrbitStage({
  blocks,
  height,
  from,
  unrolling,
  onUnrolled,
  onToggle,
}: {
  blocks: DeckBlock[];
  height: number;
  /** "flat": the panels sweep in from an unrolled strip (re-wrapping); "burst": first appearance. */
  from: "flat" | "burst";
  unrolling: boolean;
  onUnrolled: () => void;
  onToggle: () => void;
}) {
  const N = blocks.length;
  const rootRef = useRef<HTMLDivElement>(null);
  const bgRef = useRef<HTMLDivElement>(null);
  const hudRef = useRef<HTMLDivElement>(null);
  const dialRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const innerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const tagRefs = useRef<(HTMLDivElement | null)[]>([]);
  const { theme } = useTheme();
  const [driver] = useState(() => new SceneDriver());
  const [active, setActive] = useState(0);
  const onUnrolledRef = useRef(onUnrolled);
  useEffect(() => {
    onUnrolledRef.current = onUnrolled;
  });

  const E = useRef<Engine | null>(null);
  if (E.current === null) {
    const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    E.current = {
      N,
      theta: 0,
      vel: 0,
      target: 0,
      k: from === "flat" ? 0 : 1,
      kFrom: 0,
      kTo: 1,
      kStart: 0,
      kDur: 1200,
      intro: from === "burst" && !reduce ? 0 : 1,
      introStart: 0,
      introDur: 1500,
      W: 1000,
      H: height,
      cw: 520,
      R: 700,
      floorY: 260,
      step: visualStep(N),
      tagOffset: 200,
      natH: [],
      scale: [],
      raf: 0,
      last: 0,
      active: 0,
      unrolled: false,
      unrolling: false,
      reduce,
    };
  }

  /* ---------- drawing ---------- */
  const apply = useCallback(() => {
    const e = E.current!;
    const { step, k, theta } = e;
    const introE = easeOutCubic(e.intro);
    const Reff = e.R * (1 + (1 - introE) * 0.7);
    const kk = Math.max(k, 0.0001);
    const rho = Reff / kk;
    const ringBlend = smooth(k);

    for (let i = 0; i < e.N; i++) {
      const el = cardRefs.current[i];
      if (!el) continue;
      const d = around(i - theta, e.N);
      const phi = d * step + (1 - introE) * -1.5;
      const phiP = phi * kk;
      const x = rho * Math.sin(phiP);
      const z = rho * (Math.cos(phiP) - 1);
      const s = Math.abs(d);
      const flatOp = clamp(1 - Math.max(0, Math.abs(x) - e.W * 0.4) / (e.W * 0.22), 0, 1);
      const fade = Math.min(1, Math.max(0, (e.N / 2 - s) / 0.35)); // a short list: hide the panel as it crosses the back
      const op = lerp(flatOp, ringOpacity(s), ringBlend) * introE * fade;
      const grow = (1 + 0.04 * (1 - Math.min(1, s)) * ringBlend) * (1 - 0.1 * Math.min(1, s / 1.5) * ringBlend);
      el.style.transform = `translate3d(${x.toFixed(2)}px,0,${z.toFixed(2)}px) rotateY(${phiP.toFixed(4)}rad) scale(${(grow * (0.84 + 0.16 * introE)).toFixed(4)})`;
      el.style.opacity = op.toFixed(3);
      el.style.setProperty("--dim", (clamp(s * 0.38, 0, 0.7) * ringBlend).toFixed(3));
      el.style.setProperty("--glow", (clamp(1 - s * 1.4, 0, 1) * 0.5 * ringBlend).toFixed(3));
      el.style.pointerEvents = op < 0.04 ? "none" : "auto";

      const tag = tagRefs.current[i];
      if (tag) {
        const tx = x + e.tagOffset * Math.sin(phiP);
        const tz = z + e.tagOffset * Math.cos(phiP);
        tag.style.transform = `translate3d(${tx.toFixed(2)}px,${e.floorY}px,${tz.toFixed(2)}px) rotateX(90deg) translate(-50%,-50%)`;
        tag.style.opacity = (ringOpacity(s) * ringBlend * introE * fade).toFixed(3);
        tag.dataset.on = s < 0.5 ? "true" : "false";
      }
    }

    const dialA = ringBlend * introE;
    const deg = ((theta * step) / Math.PI) * 180;
    if (dialRef.current) {
      dialRef.current.style.transform = `translate3d(0,${e.floorY}px,${-Reff}px) rotateX(90deg) rotateZ(${deg.toFixed(3)}deg)`;
      dialRef.current.style.opacity = dialA.toFixed(3);
    }
    if (pointerRef.current) {
      pointerRef.current.style.transform = `translate3d(0,${e.floorY}px,${-Reff}px) rotateX(90deg)`;
      pointerRef.current.style.opacity = dialA.toFixed(3);
    }
    const chrome = smooth(clamp((k - 0.15) / 0.6, 0, 1));
    if (bgRef.current) bgRef.current.style.opacity = chrome.toFixed(3);
    if (hudRef.current) hudRef.current.style.opacity = (chrome * introE).toFixed(3);
    if (rootRef.current) rootRef.current.style.setProperty("--chrome", chrome.toFixed(3));

    driver.setProgress(theta);
    const idx = mod(Math.round(theta), e.N);
    if (idx !== e.active) {
      e.active = idx;
      setActive(idx);
    }
  }, [driver]);

  /* ---------- geometry (sizes, radius) ---------- */
  const layout = useCallback(() => {
    const e = E.current!;
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    e.N = N;
    e.W = Math.max(320, rect.width);
    e.H = Math.max(420, rect.height - CONTROLS_H);
    e.cw = clamp(e.W * 0.5, 340, NATURAL_W);
    const maxH = e.H * 0.7;
    e.step = visualStep(e.N);
    e.R = Math.max((e.cw * 0.52) / Math.sin(e.step / 2), e.cw * 0.8);
    e.floorY = maxH / 2 + 16;
    e.tagOffset = Math.max(60, e.cw * 0.14);
    for (let i = 0; i < e.N; i++) {
      const inner = innerRefs.current[i];
      const el = cardRefs.current[i];
      if (!inner || !el) continue;
      const natH = inner.offsetHeight || e.natH[i] || 420;
      e.natH[i] = natH;
      // Shrink a tall panel to fit, but never below 78% of the normal scale; past that it scrolls inside itself.
      const base = e.cw / NATURAL_W;
      const sc = Math.max(Math.min(base, maxH / natH), base * 0.78);
      const visH = Math.min(natH * sc, maxH);
      e.scale[i] = sc;
      el.style.width = `${NATURAL_W * sc}px`;
      el.style.height = `${visH}px`;
      el.style.marginLeft = `${(-NATURAL_W * sc) / 2}px`;
      el.style.marginTop = `${-visH / 2}px`;
      const sizer = inner.parentElement;
      if (sizer) {
        sizer.style.width = `${NATURAL_W * sc}px`;
        sizer.style.height = `${natH * sc}px`;
      }
      inner.style.transform = `scale(${sc})`;
    }
    const dial = dialRef.current;
    const ptr = pointerRef.current;
    const Rd = e.R + e.cw * 0.2;
    for (const d of [dial, ptr]) {
      if (!d) continue;
      d.style.width = d.style.height = `${Rd * 2}px`;
      d.style.marginLeft = d.style.marginTop = `${-Rd}px`;
    }
    apply();
  }, [apply, N]);

  /* ---------- animation loop ---------- */
  const kick = useCallback(() => {
    const e = E.current!;
    if (e.raf) return;
    e.last = performance.now();
    const tick = (now: number) => {
      e.raf = 0;
      const dt = Math.min(0.1, (now - e.last) / 1000);
      e.last = now;
      let busy = false;

      // spring toward the target card (critically damped)
      const diff = e.target - e.theta;
      const w = 7.5;
      e.vel += (w * w * diff - 2 * w * e.vel) * dt;
      e.theta += e.vel * dt;
      if (Math.abs(diff) < 0.0008 && Math.abs(e.vel) < 0.002) {
        e.theta = e.target;
        e.vel = 0;
      } else busy = true;
      driver.setVelocity(e.vel);

      if (e.kStart) {
        const t = clamp((now - e.kStart) / e.kDur, 0, 1);
        e.k = lerp(e.kFrom, e.kTo, easeInOut(t));
        if (t >= 1) {
          e.kStart = 0;
          e.k = e.kTo;
          if (e.kTo === 0 && !e.unrolled) {
            e.unrolled = true;
            onUnrolledRef.current();
          }
        } else busy = true;
      }
      if (e.introStart) {
        const t = clamp((now - e.introStart) / e.introDur, 0, 1);
        e.intro = t;
        if (t >= 1) e.introStart = 0;
        else busy = true;
      }

      apply();
      if (busy) e.raf = requestAnimationFrame(tick);
    };
    e.raf = requestAnimationFrame(tick);
  }, [apply, driver]);

  const goBy = useCallback(
    (delta: number) => {
      const e = E.current!;
      if (e.unrolling) return;
      e.target = Math.round(e.target) + delta;
      kick();
    },
    [kick],
  );

  const goTo = useCallback(
    (i: number) => {
      const e = E.current!;
      if (e.unrolling) return;
      const cur = Math.round(e.target);
      let d = mod(i - cur, e.N);
      if (d > e.N / 2) d -= e.N;
      e.target = cur + d;
      kick();
    },
    [kick],
  );

  /* mount: measure, start intro tweens */
  useLayoutEffect(() => {
    const e = E.current!;
    layout();
    const now = performance.now();
    if (from === "flat" && !e.reduce) {
      e.k = 0;
      e.kFrom = 0;
      e.kTo = 1;
      e.kStart = now;
      e.kDur = 1300;
      e.intro = 1;
    } else if (from === "flat") {
      e.k = 1;
    }
    if (e.intro < 1) {
      e.introStart = now;
      e.introDur = 1500;
    }
    kick();
    return () => {
      if (e.raf) cancelAnimationFrame(e.raf);
      e.raf = 0;
    };
  }, [from, layout, kick]);

  /* re-measure on resize / height change / content change */
  useLayoutEffect(() => {
    layout();
  }, [height, blocks, layout]);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const ro = new ResizeObserver(() => layout());
    ro.observe(root);
    innerRefs.current.forEach((n) => n && ro.observe(n));
    return () => ro.disconnect();
  }, [layout, blocks]);

  /* unroll request from the parent */
  useEffect(() => {
    const e = E.current!;
    e.unrolling = unrolling;
    if (!unrolling) return;
    if (e.reduce) {
      e.k = 0;
      e.unrolled = true;
      apply();
      onUnrolledRef.current();
      return;
    }
    e.kFrom = e.k;
    e.kTo = 0;
    e.kStart = performance.now();
    e.kDur = 1100;
    e.target = Math.round(e.target); // settle on a whole panel while it opens
    kick();
  }, [unrolling, apply, kick]);

  /* ---------- input: wheel, drag, keys ---------- */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const e = E.current!;
    const g = { start: null as number | null, moved: 0, last: 0, timer: 0 };
    const PX_PER_STEP = 380;

    const commit = () => {
      if (g.start === null) return;
      const m = g.moved / PX_PER_STEP;
      const steps = Math.abs(m) < 0.08 ? 0 : Math.min(4, Math.max(1, Math.round(Math.abs(m))));
      e.target = g.start + Math.sign(m) * steps;
      g.start = null;
      g.moved = 0;
      kick();
    };

    let lastInnerScroll = 0;
    const onWheel = (ev: WheelEvent) => {
      if (e.unrolling) {
        ev.preventDefault();
        return;
      }
      // A tall active panel scrolls itself first; the ring only turns once it is at its end.
      const scroller = ev.target instanceof Element ? ev.target.closest<HTMLElement>(".orbit-scroll") : null;
      if (scroller && scroller.closest(".orbit-card")?.getAttribute("data-active") === "true" && Math.abs(ev.deltaY) >= Math.abs(ev.deltaX)) {
        const canDown = scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1;
        const canUp = scroller.scrollTop > 0;
        if ((ev.deltaY > 0 && canDown) || (ev.deltaY < 0 && canUp)) {
          lastInnerScroll = performance.now();
          return; // native scroll inside the panel
        }
        if (performance.now() - lastInnerScroll < 350) {
          ev.preventDefault(); // momentum tail of that scroll: do not spin the ring
          return;
        }
      }
      ev.preventDefault();
      const raw = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
      const d = ev.deltaMode === 1 ? raw * 16 : raw;
      const now = performance.now();
      if (g.start === null || now - g.last > 220) {
        g.start = Math.round(e.target);
        g.moved = 0;
      }
      g.last = now;
      g.moved += d;
      e.target = g.start + g.moved / PX_PER_STEP;
      kick();
      window.clearTimeout(g.timer);
      g.timer = window.setTimeout(commit, 140);
    };

    let drag: { x: number; start: number; id: number; active: boolean; lastX: number; lastT: number; v: number } | null = null;
    const interactive = (t: EventTarget | null) =>
      t instanceof Element && !!t.closest("button, a, input, select, textarea, [data-no-drag]");

    const onDown = (ev: PointerEvent) => {
      if (e.unrolling || (ev.pointerType === "mouse" && ev.button !== 0)) return;
      if (interactive(ev.target)) return;
      drag = { x: ev.clientX, start: e.target, id: ev.pointerId, active: false, lastX: ev.clientX, lastT: performance.now(), v: 0 };
    };
    const onMove = (ev: PointerEvent) => {
      if (!drag || ev.pointerId !== drag.id) return;
      const dx = ev.clientX - drag.x;
      if (!drag.active) {
        if (Math.abs(dx) < 7) return;
        drag.active = true;
        root.setPointerCapture(ev.pointerId);
        root.dataset.dragging = "true";
      }
      const now = performance.now();
      drag.v = (ev.clientX - drag.lastX) / Math.max(1, now - drag.lastT);
      drag.lastX = ev.clientX;
      drag.lastT = now;
      e.target = drag.start - dx / (e.cw * 0.85);
      kick();
    };
    const onUp = (ev: PointerEvent) => {
      if (!drag || ev.pointerId !== drag.id) return;
      if (drag.active) {
        e.target = Math.round(e.target - clamp(drag.v * 0.9, -1.2, 1.2));
        kick();
        const swallow = (c: Event) => {
          c.stopPropagation();
          c.preventDefault();
        };
        root.addEventListener("click", swallow, { capture: true, once: true });
        window.setTimeout(() => root.removeEventListener("click", swallow, true), 0);
      }
      delete root.dataset.dragging;
      drag = null;
    };

    const onKey = (ev: KeyboardEvent) => {
      if (interactive(ev.target) && ev.target !== root) return;
      const map: Record<string, () => void> = {
        ArrowRight: () => goBy(1),
        ArrowDown: () => goBy(1),
        PageDown: () => goBy(1),
        ArrowLeft: () => goBy(-1),
        ArrowUp: () => goBy(-1),
        PageUp: () => goBy(-1),
        Home: () => goTo(0),
        End: () => goTo(e.N - 1),
      };
      const fn = map[ev.key];
      if (fn) {
        ev.preventDefault();
        fn();
      }
    };

    root.addEventListener("wheel", onWheel, { passive: false });
    root.addEventListener("pointerdown", onDown);
    root.addEventListener("pointermove", onMove);
    root.addEventListener("pointerup", onUp);
    root.addEventListener("pointercancel", onUp);
    root.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(g.timer);
      root.removeEventListener("wheel", onWheel);
      root.removeEventListener("pointerdown", onDown);
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerup", onUp);
      root.removeEventListener("pointercancel", onUp);
      root.removeEventListener("keydown", onKey);
    };
  }, [kick, goBy, goTo]);

  /* ---------- dial artwork: a gradient rim, hairline rings, a ring of ticks, a dot per panel ---------- */
  const dialSvg = (
    <svg viewBox="-500 -500 1000 1000" className="h-full w-full" aria-hidden>
      <defs>
        <radialGradient id="dial-fill" cx="50%" cy="50%" r="50%">
          <stop offset="0" className="dial-fill-a" stopOpacity="0" />
          <stop offset=".78" className="dial-fill-a" stopOpacity=".035" />
          <stop offset=".93" stopColor="#8b5cf6" stopOpacity=".12" />
          <stop offset="1" stopColor="#06b6d4" stopOpacity=".24" />
        </radialGradient>
        <linearGradient id="dial-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6366f1" />
          <stop offset=".5" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#06b6d4" />
        </linearGradient>
      </defs>
      <circle r="497" fill="url(#dial-fill)" />
      <circle r="494" fill="none" stroke="url(#dial-grad)" strokeWidth="3" opacity=".7" />
      <circle r="468" className="dial-ring-soft" strokeWidth="1.5" />
      <circle r="330" className="dial-ring-soft" strokeWidth="1.5" strokeDasharray="2 12" />
      {Array.from({ length: 144 }, (_, t) => {
        const a = (t / 144) * TAU;
        const major = t % 12 === 0;
        const r0 = major ? 458 : 474;
        return (
          <line
            key={t}
            x1={Math.cos(a) * r0}
            y1={Math.sin(a) * r0}
            x2={Math.cos(a) * 488}
            y2={Math.sin(a) * 488}
            className={major ? "dial-tick-major" : "dial-tick"}
            strokeWidth={major ? 3 : 1.5}
          />
        );
      })}
      {Array.from({ length: Math.floor(TAU / visualStep(N)) }, (_, i) => {
        // panel i sits at SVG angle 90deg - i*step (the dial's bottom is the front of the ring)
        const a = Math.PI / 2 - i * visualStep(N);
        return <circle key={i} cx={Math.cos(a) * 494} cy={Math.sin(a) * 494} r="8" className="dial-dot" strokeWidth="3" />;
      })}
    </svg>
  );

  const pointerSvg = (
    <svg viewBox="-500 -500 1000 1000" className="h-full w-full" aria-hidden>
      <defs>
        <filter id="ptr-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="9" />
        </filter>
        <linearGradient id="ptr-grad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#6366f1" />
          <stop offset=".55" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#06b6d4" />
        </linearGradient>
      </defs>
      {/* a short glowing arc at the front (bottom) of the dial marks the panel in focus */}
      <path d="M -130 478 A 494 494 0 0 0 130 478" fill="none" stroke="url(#ptr-grad)" strokeWidth="18" strokeLinecap="round" filter="url(#ptr-glow)" opacity=".95" />
      <path d="M -130 478 A 494 494 0 0 0 130 478" fill="none" stroke="url(#ptr-grad)" strokeWidth="5" strokeLinecap="round" />
      <path d="M 0 448 L 8 468 L -8 468 Z" fill="#8b5cf6" />
    </svg>
  );

  const cur = blocks[active] ?? blocks[0];

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      role="region"
      aria-roledescription="carousel"
      aria-label="Dashboard orbit view"
      className="orbit-stage relative isolate overflow-hidden rounded-3xl border outline-none select-none"
      style={{ height, touchAction: "pan-y", cursor: "grab" }}
    >
      {/* palette: kicker and floor numbers in indigo / cyan (the logo is the only red on the stage) */}
      <style>{`
        .orbit-stage.orbit-stage { --st-kicker: #67e8f9; }
        :root:not(.dark) .orbit-stage.orbit-stage { --st-kicker: #0e7490; }
        .orbit-stage .floor-tag[data-on="true"] { color: #a5b4fc; text-shadow: 0 0 22px rgba(34, 211, 238, 0.85); }
        :root:not(.dark) .orbit-stage .floor-tag[data-on="true"] { color: #4f46e5; text-shadow: 0 0 22px rgba(79, 70, 229, 0.55); }
      `}</style>
      {/* backdrop: colour washes (indigo, violet, cyan), plus a quiet particle field in dark mode */}
      <div ref={bgRef} className="pointer-events-none absolute inset-0">
        <div className="orbit-bg absolute inset-0" />
        <div className="orbit-wash absolute -inset-[10%]" />
        {theme === "dark" && <LogoScene variant="backdrop" driver={driver} className="absolute inset-0 opacity-80" />}
        <div className="orbit-vig absolute inset-0" />
      </div>

      {/* 3D world: floor dial + the ring of panels */}
      <div
        className="absolute inset-x-0 top-0"
        style={{
          bottom: CONTROLS_H,
          perspective: PERSPECTIVE,
          perspectiveOrigin: "50% 38%",
          // fade out the bottom and both sides, so panels leaving the stage dissolve instead of being cut by its edge
          WebkitMaskImage: "linear-gradient(to bottom, #000 82%, transparent 100%), linear-gradient(to right, transparent 0, #000 10%, #000 90%, transparent 100%)",
          maskImage: "linear-gradient(to bottom, #000 82%, transparent 100%), linear-gradient(to right, transparent 0, #000 10%, #000 90%, transparent 100%)",
          WebkitMaskComposite: "source-in",
          maskComposite: "intersect",
        }}
      >
        <div className="absolute inset-0" style={{ transformStyle: "preserve-3d", transform: `rotateX(${-TILT_DEG}deg)` }}>
          <div
            ref={dialRef}
            className="absolute left-1/2 top-[46%]"
            style={{ transformStyle: "flat", backfaceVisibility: "hidden", willChange: "transform" }}
          >
            {dialSvg}
          </div>
          <div
            ref={pointerRef}
            className="pointer-events-none absolute left-1/2 top-[46%]"
            style={{ backfaceVisibility: "hidden" }}
          >
            {pointerSvg}
          </div>
          {blocks.map((b, i) => (
            <div
              key={`tag-${b.id}`}
              ref={(el) => {
                tagRefs.current[i] = el;
              }}
              className="floor-tag pointer-events-none absolute left-1/2 top-[46%]"
              style={{ backfaceVisibility: "hidden" }}
              aria-hidden
            >
              {String(i + 1).padStart(2, "0")}
            </div>
          ))}
          {blocks.map((b, i) => {
            const isActive = i === active;
            return (
              <div
                key={b.id}
                ref={(el) => {
                  cardRefs.current[i] = el;
                }}
                className="orbit-card absolute left-1/2 top-[46%] rounded-xl"
                style={{ width: NATURAL_W * 0.8, backfaceVisibility: "hidden", willChange: "transform, opacity", cursor: isActive ? "default" : "pointer" }}
                data-active={isActive ? "true" : "false"}
                onClickCapture={(ev) => {
                  if (!isActive) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    goTo(i);
                  }
                }}
              >
                <div
                  className="orbit-scroll absolute inset-0 overflow-y-auto overflow-x-hidden rounded-xl"
                  {...({ inert: isActive ? undefined : "" } as Record<string, unknown>)}
                  aria-hidden={!isActive}
                >
                  <div className="relative overflow-hidden">
                    <div
                      ref={(el) => {
                        innerRefs.current[i] = el;
                      }}
                      className="origin-top-left"
                      style={{ width: NATURAL_W }}
                    >
                      {b.node}
                    </div>
                  </div>
                </div>
                <div className="orbit-dim pointer-events-none absolute inset-0 rounded-xl" />
              </div>
            );
          })}
        </div>
      </div>

      {/* 2D heads-up display */}
      <div ref={hudRef} className="pointer-events-none absolute inset-0">
        <div className="absolute left-5 top-4 flex max-w-[60%] items-center gap-3 sm:left-6 sm:top-5">
          <LogoMark size={24} shine={false} />
          <div className="min-w-0">
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.22em] text-[color:var(--st-kicker)]">
              {cur.kicker ?? "Orbit view"}
            </p>
            <h2 key={cur.id} className="hud-title truncate text-[17px] font-bold leading-tight tracking-tight sm:text-[21px]">
              {cur.title}
            </h2>
          </div>
        </div>

        <button
          type="button"
          onClick={onToggle}
          disabled={unrolling}
          className="focus-ring pointer-events-auto press glow-pill orbit-pill absolute right-5 top-4 inline-flex items-center gap-2 rounded-full px-4 py-2 text-[12.5px] font-semibold text-[color:rgb(var(--st-ink))] sm:right-6 sm:top-5"
        >
          <UnwrapIcon />
          Unwrap
        </button>

        <div className="absolute inset-x-0 bottom-4 flex flex-col items-center gap-2.5 sm:bottom-5">
          <div className="pointer-events-auto flex items-center gap-3">
            <button
              type="button"
              aria-label="Previous panel"
              onClick={() => goBy(-1)}
              className="orbit-btn focus-ring press inline-flex h-9 w-9 items-center justify-center rounded-full"
            >
              <Arrow dir="left" />
            </button>
            <p className="tabular-nums min-w-[78px] text-center text-[13px] font-semibold tracking-[0.18em]">
              {String(active + 1).padStart(2, "0")} <span className="orbit-title-sub">/ {String(N).padStart(2, "0")}</span>
            </p>
            <button
              type="button"
              aria-label="Next panel"
              onClick={() => goBy(1)}
              className="orbit-btn focus-ring press inline-flex h-9 w-9 items-center justify-center rounded-full"
            >
              <Arrow dir="right" />
            </button>
          </div>
          <div className="pointer-events-auto flex items-center gap-1.5">
            {blocks.map((b, i) => (
              <button
                key={b.id}
                type="button"
                aria-label={`Go to ${b.title}`}
                aria-current={i === active ? "true" : undefined}
                onClick={() => goTo(i)}
                className="group flex h-4 items-center"
              >
                <span
                  className="orbit-seg block h-[3px] rounded-full transition-all duration-300"
                  style={{
                    width: i === active ? 28 : 10,
                    background: i === active ? "linear-gradient(90deg,#6366f1,#06b6d4)" : undefined,
                  }}
                />
              </button>
            ))}
          </div>
          <p className="orbit-hint hidden text-[10.5px] font-medium uppercase tracking-[0.2em] sm:block">
            Scroll · drag · arrow keys
          </p>
        </div>
      </div>

      <p className="sr-only" aria-live="polite">
        {`Panel ${active + 1} of ${N}: ${cur.title}`}
      </p>
    </div>
  );
}

function Arrow({ dir }: { dir: "left" | "right" }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={dir === "left" ? "m15 6-6 6 6 6" : "m9 6 6 6-6 6"} />
    </svg>
  );
}

function UnwrapIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.6" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6" />
    </svg>
  );
}
