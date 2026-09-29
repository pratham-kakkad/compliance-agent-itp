import type { Transition, Variants } from "framer-motion";

export const ease = {
  standard: [0.2, 0, 0, 1],
  decelerate: [0, 0, 0, 1],
  accelerate: [0.3, 0, 1, 1],
} as const;

export const duration = { instant: 0.08, fast: 0.12, base: 0.18, medium: 0.24, slow: 0.32, chart: 0.6 } as const;

export const spring = {
  indicator: { type: "spring", stiffness: 520, damping: 42, mass: 0.9 } as Transition,
};

export const fadeUp: Variants = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0, transition: { duration: duration.base, ease: ease.decelerate } },
};

export const scaleIn: Variants = {
  initial: { opacity: 0, scale: 0.96 },
  animate: { opacity: 1, scale: 1, transition: { duration: duration.base, ease: ease.decelerate } },
  exit: { opacity: 0, scale: 0.97, transition: { duration: duration.fast, ease: ease.accelerate } },
};

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
