import { useId } from "react";
import { NavLink, useLocation } from "react-router-dom";
import clsx from "clsx";
import { motion } from "framer-motion";
import * as D from "@radix-ui/react-dialog";
import { PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { spring } from "../../lib/motion";
import { useAppReady } from "../../lib/splash";
import { IconButton, Tooltip } from "../ui";
import { NAV, NAV_FOOTER, isActive, type NavItem, type NavSection } from "./nav";
import { useVisibleNav } from "./useVisibleNav";
import { Logo } from "./Logo";

function NavEntry({ item, collapsed, indicatorId, onNavigate }: { item: NavItem; collapsed: boolean; indicatorId: string; onNavigate?: () => void }) {
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
        "relative flex items-center gap-3 h-8 rounded-md text-sm transition-colors duration-100",
        collapsed ? "justify-center w-10 mx-auto" : "px-2.5",
        active ? "bg-panel3 text-ink font-semibold" : "text-ink2 hover:bg-panel2 hover:text-ink"
      )}
    >
      {active && (
        <motion.span
          layoutId={indicatorId}
          transition={spring.indicator}
          className={clsx("absolute top-1.5 bottom-1.5 w-[3px] rounded-full bg-accent", collapsed ? "-left-2" : "-left-2")}
        />
      )}
      <motion.span className="flex flex-none" whileHover={{ rotate: [0, -12, 10, -6, 0], scale: 1.15 }} transition={{ duration: 0.5 }}>
        <Icon size={16} className={clsx("flex-none", active ? "text-accent" : "")} aria-hidden />
      </motion.span>
      {!collapsed && <span className="truncate">{item.label}</span>}
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
  let n = 0; // running index across sections, for the staggered entrance
  return (
    <nav aria-label={label} className="flex flex-col gap-4">
      {sections.map((section) => (
        <div key={section.id}>
          {section.label &&
            (collapsed ? (
              <div className="mx-3 mb-2 border-t border-line-soft" aria-hidden />
            ) : (
              <div className="px-2.5 mb-1 text-xs font-semibold text-ink3">{section.label}</div>
            ))}
          <ul className="flex flex-col gap-0.5">
            {section.items.map((item) => (
              <motion.li
                key={item.to}
                initial={{ opacity: 0, x: -16 }}
                animate={ready ? { opacity: 1, x: 0 } : { opacity: 0, x: -16 }}
                transition={{ duration: 0.45, delay: ready ? 0.1 + n++ * 0.05 : 0, ease: [0.16, 1, 0.3, 1] }}
              >
                <NavEntry item={item} collapsed={collapsed} indicatorId={indicatorId} onNavigate={onNavigate} />
              </motion.li>
            ))}
          </ul>
        </div>
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
      className="hidden lg:flex flex-col flex-none sticky top-14 h-[calc(100vh-56px)] bg-sidebar border-r border-line overflow-hidden"
    >
      <div className="flex-1 overflow-y-auto overflow-x-hidden py-4 px-3">
        <NavList sections={main} label="Primary" collapsed={collapsed} indicatorId={indicatorId} />
      </div>
      <div className="border-t border-line px-3 pt-3 pb-3 flex flex-col gap-2">
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
