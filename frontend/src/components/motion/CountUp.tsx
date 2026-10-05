import { useEffect, useLayoutEffect, useRef, useState } from "react";

const NUMBER = /^([\s\S]*?)(-?\d[\d,]*(?:\.\d+)?)([\s\S]*)$/;

type Parsed = { prefix: string; value: number; suffix: string; decimals: number; grouped: boolean };

/** Splits "$214.5M" into prefix "$", number 214.5, suffix "M" (plus formatting facts), or null if there is no number. */
function parse(text: string): Parsed | null {
  const m = NUMBER.exec(text);
  if (!m) return null;
  const raw = m[2];
  const value = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  const decimals = raw.includes(".") ? raw.length - raw.indexOf(".") - 1 : 0;
  return { prefix: m[1], value, suffix: m[3], decimals, grouped: raw.includes(",") };
}

function render(p: Parsed, n: number) {
  const body = n.toLocaleString("en-US", {
    minimumFractionDigits: p.decimals,
    maximumFractionDigits: p.decimals,
    useGrouping: p.grouped,
  });
  return `${p.prefix}${body}${p.suffix}`;
}

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Renders `value` ("$214M", "96%", "1,240", "4.2x") and counts the number up from zero the first time it
 * scrolls into view. Text with no number is shown as-is. The server render and the first client render show
 * the final text, so there is no mismatch and nothing is hidden if scripts are slow; reduced-motion users
 * just get the final text.
 */
export function CountUp({
  value,
  durationMs = 1100,
  className,
}: {
  value: string | number;
  durationMs?: number;
  className?: string;
}) {
  const text = String(value);
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(text);

  useIsoLayoutEffect(() => {
    const parsed = parse(text);
    const el = ref.current;
    if (!parsed || !el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(text);
      return;
    }
    setShown(render(parsed, 0)); // before paint: start from zero
    let raf = 0;
    const run = () => {
      const t0 = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - t0) / durationMs);
        const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t); // easeOutExpo
        setShown(render(parsed, parsed.value * eased));
        if (t < 1) raf = requestAnimationFrame(tick);
        else setShown(text);
      };
      raf = requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          run();
        }
      },
      { threshold: 0.2 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [text, durationMs]);

  return (
    <span ref={ref} className={className}>
      <span aria-hidden>{shown}</span>
      <span className="sr-only">{text}</span>
    </span>
  );
}
