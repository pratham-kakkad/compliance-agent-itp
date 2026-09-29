import { CalendarClock, Fingerprint, LayoutDashboard, Network, Sparkles, UploadCloud, Users, type LucideIcon } from "lucide-react";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

export interface NavSection {
  id: string;
  label?: string;
  /** Group name in the command palette when the section has no sidebar label. */
  paletteLabel?: string;
  items: NavItem[];
}

// Each compliance agent is its own section; adding a third agent is one more entry here.
export const NAV: NavSection[] = [
  { id: "home", items: [{ to: "/", label: "Dashboard", icon: LayoutDashboard, end: true }] },
  {
    id: "meetings",
    label: "Meetings",
    items: [
      { to: "/meetings", label: "Meetings", icon: CalendarClock },
      { to: "/team", label: "Team", icon: Users },
      { to: "/org-chart", label: "Org chart", icon: Network },
    ],
  },
  {
    id: "attendance",
    label: "Attendance",
    items: [
      { to: "/attendance", label: "Employees", icon: Fingerprint, end: true },
      { to: "/attendance/import", label: "Import", icon: UploadCloud },
    ],
  },
];

/** Cross-agent tools pinned to the bottom of the sidebar, just above the collapse control. */
export const NAV_FOOTER: NavSection = {
  id: "footer",
  paletteLabel: "Tools",
  items: [{ to: "/assistant", label: "Assistant", icon: Sparkles }],
};

/** Every nav section, top groups first — for the breadcrumb, document title and command palette. */
export const ALL_NAV: NavSection[] = [...NAV, NAV_FOOTER];

export function isActive(pathname: string, item: NavItem): boolean {
  if (item.end) return pathname === item.to;
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}

/** Section + page for the current path (breadcrumb and document title). */
export function locate(pathname: string): { section?: string; page?: NavItem } {
  for (const s of ALL_NAV) {
    const page = s.items.find((i) => isActive(pathname, i));
    if (page) return { section: s.label, page };
  }
  return {};
}
