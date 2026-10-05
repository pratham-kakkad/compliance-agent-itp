import {
  Boxes,
  CalendarClock,
  ClipboardCheck,
  Fingerprint,
  KeyRound,
  LayoutDashboard,
  Library,
  ListChecks,
  Network,
  ScrollText,
  Settings,
  ShieldCheck,
  Sparkles,
  Trophy,
  UploadCloud,
  UserCog,
  Users,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  /** Shown only to people holding at least one of these [resource, action] permissions. */
  needs?: [string, string][];
  /** Other path prefixes that belong to this item (detail pages), so it stays highlighted. */
  alsoMatches?: string[];
}

export interface NavSection {
  id: string;
  label?: string;
  /** Group name in the command palette when the section has no sidebar label. */
  paletteLabel?: string;
  items: NavItem[];
}

// Each compliance agent is its own section; adding another is one more entry here.
export const NAV: NavSection[] = [
  { id: "home", items: [{ to: "/", label: "Dashboard", icon: LayoutDashboard, end: true }] },
  {
    id: "compliance",
    label: "Compliance",
    items: [
      { to: "/compliance", label: "Overview", icon: ShieldCheck, end: true, needs: [["dashboard", "view"]] },
      {
        to: "/compliance/mine",
        label: "My compliance",
        icon: ClipboardCheck,
        needs: [["submission", "view"]],
        alsoMatches: ["/compliance/obligations"],
      },
      {
        to: "/compliance/reviews",
        label: "Reviews",
        icon: ListChecks,
        needs: [["submission", "approve"], ["submission", "reject"]],
      },
      {
        to: "/compliance/library",
        label: "Library",
        icon: Library,
        needs: [["compliance", "create"], ["compliance", "edit"], ["compliance", "assign"], ["compliance", "export"]],
      },
      { to: "/compliance/scoreboard", label: "Scoreboard", icon: Trophy, needs: [["report", "view"]] },
    ],
  },
  {
    id: "meetings",
    label: "Meetings",
    items: [
      { to: "/meetings", label: "Meetings", icon: CalendarClock, needs: [["meeting_compliance", "view"]] },
      { to: "/team", label: "Team", icon: Users, needs: [["meeting_compliance", "view"]] },
      { to: "/org-chart", label: "Org chart", icon: Network, needs: [["meeting_compliance", "view"]] },
    ],
  },
  {
    id: "attendance",
    label: "Attendance",
    items: [
      { to: "/attendance", label: "Employees", icon: Fingerprint, end: true, needs: [["attendance_compliance", "view"]] },
      { to: "/attendance/import", label: "Import", icon: UploadCloud, needs: [["attendance_compliance", "view"]] },
    ],
  },
  {
    id: "admin",
    label: "Administration",
    items: [
      { to: "/compliance/admin/users", label: "Users", icon: UserCog, needs: [["user", "view"]] },
      { to: "/compliance/admin/org", label: "Teams & departments", icon: Boxes, needs: [["team", "view"]] },
      { to: "/compliance/admin/access", label: "Roles & access", icon: KeyRound, needs: [["role", "view"]] },
      { to: "/compliance/admin/audit", label: "Audit log", icon: ScrollText, needs: [["audit_log", "view"]] },
    ],
  },
];

/** Cross-agent tools and app settings, pinned to the bottom of the sidebar just above the collapse control. */
export const NAV_FOOTER: NavSection = {
  id: "footer",
  paletteLabel: "Tools",
  items: [
    { to: "/assistant", label: "Assistant", icon: Sparkles },
    { to: "/settings", label: "Settings", icon: Settings },
  ],
};

/** Every nav section, top groups first — for the breadcrumb, document title and command palette. */
export const ALL_NAV: NavSection[] = [...NAV, NAV_FOOTER];

/** The sections a person may see: items they hold none of the needed permissions for are dropped, and so are empty groups. */
export function visibleNav(sections: NavSection[], can: ((r: string, a: string) => boolean) | null): NavSection[] {
  return sections
    .map((s) => ({ ...s, items: s.items.filter((i) => !i.needs || can === null || i.needs.some(([r, a]) => can(r, a))) }))
    .filter((s) => s.items.length > 0);
}

export function isActive(pathname: string, item: NavItem): boolean {
  if (item.alsoMatches?.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return true;
  if (item.end) return pathname === item.to;
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}

/** Section + page for the current path (breadcrumb and document title). */
export function locate(pathname: string): { section?: string; page?: NavItem } {
  // Most specific match first: /compliance/admin/users must not resolve to a shorter /compliance item.
  const all = ALL_NAV.flatMap((s) => s.items.map((page) => ({ s, page })));
  const hits = all.filter(({ page }) => isActive(pathname, page)).sort((a, b) => b.page.to.length - a.page.to.length);
  return hits[0] ? { section: hits[0].s.label, page: hits[0].page } : {};
}
