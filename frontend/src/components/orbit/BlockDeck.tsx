import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { OrbitStage } from "./OrbitStage";
import type { DeckBlock, DeckView } from "./types";

/* ---- the remembered choice (orbit | grid), shared by every dashboard, hydration-safe ---- */
const STORAGE_KEY = "ic-deck-view";
let memoryPref: DeckView | null = null;

function readPref(): DeckView {
  if (memoryPref) return memoryPref;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === "orbit" || v === "grid") return v;
  } catch {
    /* storage unavailable: fall through to the default */
  }
  return "orbit";
}

function writePref(next: DeckView) {
  memoryPref = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* kept in memory for this session */
  }
}

const noopSubscribe = () => () => {};

function useHydrated() {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

/** Orbit needs room: below this width the dashboard is always the plain grid. */
const ORBIT_QUERY = "(min-width: 900px)";
function useOrbitCapable() {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(ORBIT_QUERY);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia(ORBIT_QUERY).matches,
    () => false,
  );
}

/** Height available to the stage: what is left of the viewport below it (the page itself scrolls). */
function useStageHeight(ref: React.RefObject<HTMLElement | null>) {
  const [h, setH] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      setH(Math.round(Math.min(980, Math.max(540, window.innerHeight - top - 28))));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [ref]);
  return h;
}

export function ViewToggle({ view, onClick, disabled }: { view: DeckView; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="press group inline-flex items-center gap-2 rounded-full border border-line bg-panel px-4 py-2 text-[12.5px] font-semibold text-ink2 shadow-xs transition hover:border-[color:var(--copper)] hover:text-ink disabled:opacity-60"
    >
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-[color:var(--copper)] transition-transform duration-500 group-hover:rotate-180">
        <ellipse cx="12" cy="12" rx="9" ry="4.2" />
        <ellipse cx="12" cy="12" rx="4.2" ry="9" />
        <circle cx="12" cy="12" r="1.4" fill="currentColor" />
      </svg>
      {view === "grid" ? "Wrap into orbit" : "Unwrap"}
    </button>
  );
}

function DeckInner({
  blocks,
  extra,
  footer,
  initial,
  capable,
}: {
  blocks: DeckBlock[];
  extra?: DeckBlock;
  footer?: ReactNode;
  initial: DeckView;
  capable: boolean;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const height = useStageHeight(holder);
  const [view, setView] = useState<DeckView>(initial);
  const [phase, setPhase] = useState<null | "unrolling" | "leaving">(null);
  const [from, setFrom] = useState<"burst" | "flat">("burst");
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const shown: DeckView = capable ? view : "grid";

  const toggle = useCallback(() => {
    if (phase) return;
    if (shown === "orbit") {
      writePref("grid");
      setPhase("unrolling");
    } else {
      writePref("orbit");
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      setPhase("leaving");
      timer.current = window.setTimeout(
        () => {
          setFrom("flat");
          setView("orbit");
          setPhase(null);
        },
        reduce ? 0 : 420,
      );
    }
  }, [phase, shown]);

  const onUnrolled = useCallback(() => {
    setView("grid");
    setPhase(null);
  }, []);

  return (
    <div ref={holder}>
      {shown === "orbit" ? (
        <OrbitStage
          blocks={extra ? [...blocks, extra] : blocks}
          height={height}
          from={from}
          unrolling={phase === "unrolling"}
          onUnrolled={onUnrolled}
          onToggle={toggle}
        />
      ) : (
        <>
          {capable && (
            <div className="mb-3 flex justify-end">
              <ViewToggle view="grid" onClick={toggle} disabled={phase !== null} />
            </div>
          )}
          <div
            className={`stagger deck-grid grid grid-cols-1 xl:grid-cols-2 gap-4 ${
              phase === "leaving" ? "deck-leaving" : ""
            }`}
          >
            {blocks.flatMap((b) => [
              ...(b.gridHeading ? [<div key={`${b.id}-heading`} className="min-w-0 xl:col-span-2">{b.gridHeading}</div>] : []),
              <div key={b.id} className={`min-w-0 ${b.span === 2 ? "xl:col-span-2" : ""}`}>
                {b.node}
              </div>,
            ])}
          </div>
          {footer}
        </>
      )}
    </div>
  );
}

function DeckReady({
  blocks,
  footer,
  extraOrbitBlock,
}: {
  blocks: DeckBlock[];
  footer?: ReactNode;
  extraOrbitBlock?: DeckBlock;
}) {
  const capable = useOrbitCapable();
  // Chosen once, on the client: the stored preference, except that reduced-motion visitors who never chose get the grid.
  const [initial] = useState<DeckView>(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    if (!stored && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return "grid";
    return readPref();
  });
  return <DeckInner blocks={blocks} extra={extraOrbitBlock} footer={footer} initial={initial} capable={capable} />;
}

/**
 * A dashboard's panels, shown either as the normal responsive grid or wrapped around a rotating 3D ring
 * ("orbit"). The viewer's choice is remembered. `extraOrbitBlock` is an extra panel that only exists on the
 * ring (the grid shows the same content as `footer`).
 */
export function BlockDeck(props: { blocks: DeckBlock[]; footer?: ReactNode; extraOrbitBlock?: DeckBlock }) {
  const hydrated = useHydrated();
  if (!hydrated) return <div style={{ minHeight: 480 }} aria-hidden />;
  return <DeckReady {...props} />;
}
