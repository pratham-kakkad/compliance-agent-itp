import { Link, useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Bell, KeyRound, LogOut, Menu as MenuIcon, MoonStar, Search, Sun } from "lucide-react";
import { useAuth } from "../../auth/AuthContext";
import { useTheme, type ThemeMode } from "../../lib/useTheme";
import { useCompliance } from "../../lib/ComplianceContext";
import { Avatar, IconButton, Kbd, Label, Menu, Tooltip } from "../ui";
import { useOverlay } from "../Modal";
import { ChangePasswordDialog } from "../auth/ChangePasswordDialog";
import { showCommandPalette, isMac } from "./CommandPalette";
import { Logo } from "./Logo";
import { locate } from "./nav";

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const Icon = theme === "dark" ? Sun : MoonStar;
  return (
    <Tooltip content={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}>
      <button
        type="button"
        onClick={toggle}
        aria-label="Toggle theme"
        className="w-8 h-8 rounded-md flex items-center justify-center text-ink2 hover:text-ink hover:bg-panel2 transition-colors overflow-hidden"
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={theme}
            initial={{ rotate: -90, opacity: 0, scale: 0.8 }}
            animate={{ rotate: 0, opacity: 1, scale: 1 }}
            exit={{ rotate: 90, opacity: 0, scale: 0.8 }}
            transition={{ duration: 0.16, ease: [0.2, 0, 0, 1] }}
            className="flex"
          >
            <Icon size={16} />
          </motion.span>
        </AnimatePresence>
      </button>
    </Tooltip>
  );
}

/** Link to the notification inbox with the unread count. */
function NotificationBell() {
  const { unread, me } = useCompliance();
  if (!me) return null;
  return (
    <Tooltip content={unread ? `${unread} unread notification${unread === 1 ? "" : "s"}` : "Notifications"}>
      <Link
        to="/compliance/notifications"
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        className="relative w-8 h-8 rounded-md flex items-center justify-center text-ink2 hover:text-ink hover:bg-panel2 transition-colors"
      >
        <Bell size={16} />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-crit text-white text-[10px] font-semibold leading-4 text-center tabular">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </Link>
    </Tooltip>
  );
}

function UserMenu() {
  const { me, logout } = useAuth();
  const { mode, setMode } = useTheme();
  const { openModal } = useOverlay();
  if (!me) return null;
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <button type="button" aria-label="Account menu" className="rounded-full ml-1 hover:ring-2 hover:ring-line transition-shadow">
          <Avatar name={me.name} size={28} />
        </button>
      </Menu.Trigger>
      <Menu.Content className="w-64">
        <div className="flex items-center gap-3 px-2 py-2">
          <Avatar name={me.name} size={36} />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-ink truncate">{me.name}</div>
            <div className="text-xs text-ink2 truncate">{me.email}</div>
            {me.title && <div className="text-xs text-ink3 truncate">{me.title}</div>}
          </div>
        </div>
        <Menu.Separator />
        <Menu.Label>Theme</Menu.Label>
        <Menu.RadioGroup value={mode} onValueChange={(v) => setMode(v as ThemeMode)}>
          <Menu.RadioItem value="light">Light</Menu.RadioItem>
          <Menu.RadioItem value="dark">Dark</Menu.RadioItem>
          <Menu.RadioItem value="system">System</Menu.RadioItem>
        </Menu.RadioGroup>
        <Menu.Separator />
        {!me.is_demo && (
          <Menu.Item onSelect={() => openModal(<ChangePasswordDialog />)}>
            <KeyRound size={16} className="text-ink2" />
            Change password
          </Menu.Item>
        )}
        <Menu.Item onSelect={() => logout()}>
          <LogOut size={16} className="text-ink2" />
          Sign out
        </Menu.Item>
      </Menu.Content>
    </Menu.Root>
  );
}

export function Header({ onMenu }: { onMenu: () => void }) {
  const { me } = useAuth();
  const { pathname } = useLocation();
  const { section, page } = locate(pathname);

  return (
    <header className="sticky top-0 z-30 h-14 flex items-center gap-2 px-3 sm:px-4 glass-bar border-b border-[var(--glass-border)]">
      <IconButton icon={MenuIcon} label="Toggle navigation" onClick={onMenu} tooltip={false} />
      <div className="hidden sm:block">
        <Logo />
      </div>
      {page && (
        <nav aria-label="Breadcrumb" className="flex items-center gap-2 min-w-0 text-sm ml-1">
          <span className="hidden sm:inline text-line-strong" aria-hidden>/</span>
          {section && (
            <>
              <span className="text-ink2 truncate hidden md:inline">{section}</span>
              <span className="text-line-strong hidden md:inline" aria-hidden>/</span>
            </>
          )}
          <span className="font-semibold text-ink truncate">{page.label}</span>
        </nav>
      )}

      <div className="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          onClick={showCommandPalette}
          className="glass hidden md:flex items-center gap-2 h-9 w-64 lg:w-80 px-3 rounded-full text-sm text-ink3 hover:text-ink2 transition-colors"
        >
          <Search size={16} aria-hidden />
          <span className="flex-1 text-left">Search or jump to…</span>
          <Kbd>{isMac ? "⌘K" : "Ctrl K"}</Kbd>
        </button>
        <IconButton icon={Search} label="Search" onClick={showCommandPalette} className="md:hidden" />
        {me && (
          <span className="hidden sm:inline-flex mx-1">
            <Label tone={me.is_demo ? "warn" : "good"} dot size="md">
              {me.is_demo ? "Demo data" : "Live data"}
            </Label>
          </span>
        )}
        <NotificationBell />
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  );
}
