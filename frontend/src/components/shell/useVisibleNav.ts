import { useMemo } from "react";
import { useCompliance } from "../../lib/ComplianceContext";
import { visibleNav, type NavSection } from "./nav";

/** `sections` limited to what the signed-in person's permissions allow (everything until permissions load). */
export function useVisibleNav(sections: NavSection[]): NavSection[] {
  const { me, can } = useCompliance();
  return useMemo(() => visibleNav(sections, me ? can : null), [sections, me, can]);
}
