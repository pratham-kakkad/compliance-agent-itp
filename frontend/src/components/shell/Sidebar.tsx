import { useEffect, useId, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import * as D from "@radix-ui/react-dialog";
import { ChevronDown, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { spring } from "../../lib/motion";
import { useAppReady } from "../../lib/splash";
import { IconButton, Menu, Tooltip } from "../ui";
import { NAV, NAV_FOOTER, isActive, type NavItem, type NavSection } from "./nav";
import { useVisibleNav } from "./useVisibleNav";
import { Logo } from "./Logo";

/** One page link. Inside a group it takes the group's hue; on its own (the footer) it carries its own chip. */
function NavEntry({
  item,
  collapsed,
  indicatorId,
  onNavigate,
  hue,
  chip,
}: {
  item: NavItem;
  collapsed: boolean;
  indicatorId: string;
  onNavigate?: () => void;
  hue: string;
  chip?: boolean;
}) {
  const { pathname } = useLocation();
  const active = isActive(pathname, item);
  const Icon = item.icon;
  const link = (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={clsx(
        `hue-${hue} relative flex items-center gap-2.5 rounded-xl text-sm transition-colors duration-100`,
        chip ? "h-9" : "h-8",
        collapsed ? "justify-center w-10 mx-auto" : chip ? "px-2" : "px-2.5",
        active ? "text-ink font-semibold" : "text-ink2 hover:bg-[var(--glass)] hover:text-ink"
      )}
    >
      {active && <motion.span layoutId={indicatorId} transition={spring.indicator} className="nav-active absolute inset-0 rounded-xl" aria-hidden />}
      {chip || collapsed ? (
        <motion.span
          className={clsx("nav-chip relative flex flex-none items-center justify-center w-7 h-7 rounded-lg", active && "nav-chip-on")}
          whileHover={{ rotate: [0, -12, 10, -6, 0], scale: 1.12 }}
          transition={{ duration: 0.5 }}
        >
          <Icon size={16} className="flex-none" aria-hidden />
        </motion.span>
      ) : (
        <Icon size={15} className={clsx("relative flex-none", active ? "text-[rgb(var(--hue))]" : "text-ink3")} aria-hidden />
      )}
      {!collapsed && <span className="relative truncate">{item.label}</span>}
    </NavLink>
  );
  return collapsed ? (
    <Tooltip content={item.label} side="right">
      {link}
    </Tooltip>
  ) : (
    link
  );
}

/**
 * A menu group: its coloured header (always visible) and, when open, its pages. Only one group is open at a time;
 * the one holding the current page opens by itself. In the narrow rail the header opens a flyout instead.
 */
function NavGroup({
  section,
  open,
  onToggle,
  collapsed,
  indicatorId,
  onNavigate,
}: {
  section: NavSection;
  open: boolean;
  onToggle: () => void;
  collapsed: boolean;
  indicatorId: string;
  onNavigate?: () => void;
}) {
  const { pathname } = useLocation();
  const Icon = section.icon!;
  const hue = section.hue ?? "indigo";
  const holdsActive = section.items.some((i) => isActive(pathname, i));

  if (collapsed) {
    return (
      <Menu.Root>
        <Menu.Trigger asChild>
          <button
            type="button"
            aria-label={section.label}
            className={clsx(`hue-${hue} relative mx-auto flex h-9 w-10 items-center justify-center rounded-xl transition-colors hover:bg-[var(--glass)]`)}
          >
            <span className={clsx("nav-chip flex h-7 w-7 items-center justify-center rounded-lg", holdsActive && "nav-chip-on")}>
              <Icon size={16} aria-hidden />
            </span>
          </button>
        </Menu.Trigger>
        <Menu.Content side="right" align="start" sideOffset={10} className={clsx(`hue-${hue}`, "w-56")}>
          <Menu.Label>{section.label}</Menu.Label>
          {section.items.map((item) => (
            <Menu.Item key={item.to} asChild>
              <NavLink to={item.to} end={item.end} onClick={onNavigate} className={clsx(isActive(pathname, item) && "font-semibold text-[rgb(var(--hue))]")}>
                <item.icon size={15} aria-hidden />
                {item.label}
              </NavLink>
            </Menu.Item>
          ))}
        </Menu.Content>
      </Menu.Root>
    );
  }

  return (
    <div className={`hue-${hue}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={clsx(
          "group flex h-10 w-full items-center gap-2.5 rounded-xl px-2 text-left text-sm transition-colors hover:bg-[var(--glass)]",
          holdsActive || open ? "text-ink font-semibold" : "text-ink2 font-medium"
        )}
      >
        <motion.span
          className={clsx("nav-chip flex h-7 w-7 flex-none items-center justify-center rounded-lg", holdsActive && "nav-chip-on")}
          whileHover={{ rotate: [0, -12, 10, -6, 0], scale: 1.12 }}
          transition={{ duration: 0.5 }}
        >
          <Icon size={16} aria-hidden />
        </motion.span>
        <span className="flex-1 truncate">{section.label}</span>
        <ChevronDown size={15} aria-hidden className={clsx("flex-none text-ink3 transition-transform duration-200", open && "rotate-180")} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.ul
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
            className="ml-[21px] mt-1 flex flex-col gap-0.5 overflow-hidden border-l pl-2"
            style={{ borderColor: "rgba(var(--hue), 0.28)" }}
          >
            {section.items.map((item) => (
              <li key={item.to}>
                <NavEntry item={item} collapsed={false} indicatorId={indicatorId} onNavigate={onNavigate} hue={hue} />
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}

function NavList({
  sections,
  label,
  collapsed,
  indicatorId,
  onNavigate,
}: {
  sections: NavSection[];
  label: string;
  collapsed: boolean;
  indicatorId: string;
  onNavigate?: () => void;
}) {
  const ready = useAppReady();
  const { pathname } = useLocation();
  const activeId = sections.find((s) => s.label && s.items.some((i) => isActive(pathname, i)))?.id ?? null;
  const [openId, setOpenId] = useState<string | null>(activeId);
  // Moving to a page in another group (a link, the palette, the back button) opens that group.
  useEffect(() => {
    if (activeId) setOpenId(activeId);
  }, [activeId]);

  let n = 0; // running index across sections, for the staggered entrance
  return (
    <nav aria-label={label} className="flex flex-col gap-1.5">
      {sections.map((section) => (
        <motion.div
          key={section.id}
          initial={{ opacity: 0, x: -16 }}
          animate={ready ? { opacity: 1, x: 0 } : { opacity: 0, x: -16 }}
          transition={{ duration: 0.45, delay: ready ? 0.1 + n++ * 0.06 : 0, ease: [0.16, 1, 0.3, 1] }}
        >
          {section.label ? (
            <NavGroup
              section={section}
              open={openId === section.id}
              onToggle={() => setOpenId((o) => (o === section.id ? null : section.id))}
              collapsed={collapsed}
              indicatorId={indicatorId}
              onNavigate={onNavigate}
            />
          ) : (
            <ul className="flex flex-col gap-0.5">
              {section.items.map((item) => (
                <li key={item.to}>
                  <NavEntry item={item} collapsed={collapsed} indicatorId={indicatorId} onNavigate={onNavigate} hue={item.hue ?? "indigo"} chip />
                </li>
              ))}
            </ul>
          )}
        </motion.div>
      ))}
    </nav>
  );
}

const FOOTER_SECTIONS = [NAV_FOOTER];

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const indicatorId = `nav-indicator-${useId()}`;
  const main = useVisibleNav(NAV);
  return (
    <motion.aside
      initial={false}
      animate={{ width: collapsed ? 64 : 248 }}
      transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
      className="hidden lg:flex flex-col flex-none sticky top-14 h-[calc(100vh-56px)] glass-bar border-r border-[var(--glass-border)] overflow-hidden"
    >
      <div className="flex-1 overflow-y-auto overflow-x-hidden py-4 px-3">
        <NavList sections={main} label="Primary" collapsed={collapsed} indicatorId={indicatorId} />
      </div>
      <div className="border-t border-[var(--glass-border)] px-3 pt-3 pb-3 flex flex-col gap-2">
        <NavList sections={FOOTER_SECTIONS} label="Tools" collapsed={collapsed} indicatorId={indicatorId} />
        <div className={clsx("flex", collapsed ? "justify-center" : "justify-end")}>
          <IconButton
            icon={collapsed ? PanelLeftOpen : PanelLeftClose}
            label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={onToggle}
          />
        </div>
      </div>
    </motion.aside>
  );
}

export function NavDrawer({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const indicatorId = `nav-indicator-${useId()}`;
  const main = useVisibleNav(NAV);
  const close = () => onOpenChange(false);
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="mc-scrim fixed inset-0 z-50 lg:hidden" style={{ background: "var(--scrim)" }} />
        <D.Content
          aria-describedby={undefined}
          className="mc-sheet-left fixed inset-y-0 left-0 z-50 w-[280px] max-w-[85vw] bg-sidebar border-r border-line shadow-lg flex flex-col outline-none lg:hidden"
        >
          <D.Title className="sr-only">Navigation</D.Title>
          <div className="h-14 flex items-center justify-between px-4 border-b border-line">
            <Logo />
            <D.Close asChild>
              <IconButton icon={X} label="Close navigation" tooltip={false} />
            </D.Close>
          </div>
          <div className="flex-1 overflow-y-auto py-4 px-3">
            <NavList sections={main} label="Primary" collapsed={false} indicatorId={indicatorId} onNavigate={close} />
          </div>
          <div className="border-t border-line p-3">
            <NavList sections={FOOTER_SECTIONS} label="Tools" collapsed={false} indicatorId={indicatorId} onNavigate={close} />
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
