import { useEffect, useRef } from "react";

/**
 * Scroll-reveal: attach the returned ref to an element carrying the `reveal` class. It flips
 * `data-in="true"` the first time the element is at least 12% visible (and stays that way), which the
 * CSS turns into a rise + fade. Reduced-motion users see it immediately.
 */
export function useReveal<T extends HTMLElement>(delayMs = 0) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty("--reveal-delay", `${delayMs}ms`);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.dataset.in = "true";
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          el.dataset.in = "true";
          io.disconnect();
        }
      },
      { threshold: 0.12 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [delayMs]);
  return ref;
}
