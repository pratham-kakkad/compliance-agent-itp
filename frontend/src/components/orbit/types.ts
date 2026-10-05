import type { ReactNode } from "react";

/** One self-contained piece of a dashboard: a card in the normal grid, a panel on the orbit ring. */
export type DeckBlock = {
  id: string;
  /** Short name shown on the orbit HUD and used for screen readers. */
  title: string;
  /** Small label above the title on the HUD (e.g. "Pipeline"). */
  kicker?: string;
  /** 2 = full width in the grid (default 1 = half width at xl). */
  span?: 1 | 2;
  /** Heading shown above this block in the grid only (the ring has its own HUD). */
  gridHeading?: ReactNode;
  node: ReactNode;
};

export type DeckView = "orbit" | "grid";
