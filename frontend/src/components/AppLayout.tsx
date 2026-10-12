import { useCallback, useEffect, useState } from "react";
import { useLocation, useOutlet } from "react-router-dom";
import { motion } from "framer-motion";
import { useAppReady } from "../lib/splash";
import { Toaster } from "sonner";
import { useAuth } from "../auth/AuthContext";
import { useTheme } from "../lib/useTheme";
import { useSettings } from "../lib/SettingsContext";
import { duration, ease } from "../lib/motion";
import { ChatFabAndPanel } from "./ChatWidget";
import { Header } from "./shell/Header";
import { NavDrawer, Sidebar } from "./shell/Sidebar";
import { TopProgressBar } from "./shell/TopProgressBar";
import { CommandPalette } from "./shell/CommandPalette";
import { locate } from "./shell/nav";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem("mc-sidebar") === "collapsed";
  } catch {
    return false;
  }
}

/**
 * Route content fades in on navigation — no exit animation, so navigation stays instant.
 * Keyed on the org time zone too: changing it in Settings remounts the page, so it
 * refetches (attendance days are recalculated server-side) and reformats every time.
 */
function RouteContent() {
  const outlet = useOutlet();
  const { pathname } = useLocation();
  const { timezone } = useSettings();
  const ready = useAppReady();
  return (
    <motion.div
      key={`${pathname}@${timezone}`}
      initial={{ opacity: 0, y: 18, scale: 0.99, filter: "blur(6px)" }}
      animate={ready ? { opacity: 1, y: 0, scale: 1, filter: "blur(0px)" } : undefined}
      transition={{ duration: duration.slow + 0.2, ease: ease.decelerate }}
    >
      {outlet}
    </motion.div>
  );
}

export function AppLayout() {
  const { me } = useAuth();
  const { theme } = useTheme();
  const { pathname } = useLocation();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    const { page } = locate(pathname);
    document.title = page ? `${page.label} · Encop` : "Encop";
  }, [pathname]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      try {
        localStorage.setItem("mc-sidebar", c ? "expanded" : "collapsed");
      } catch {
        /* ignore */
      }
      return !c;
    });
  }, []);

  const onMenu = useCallback(() => {
    if (window.matchMedia("(min-width: 1024px)").matches) toggleCollapsed();
    else setDrawerOpen(true);
  }, [toggleCollapsed]);

  if (!me) return null;

  return (
    <div className="min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:px-3 focus:py-2 focus:rounded-md focus:bg-panel focus:border focus:border-line focus:shadow-md focus:text-sm focus:font-semibold"
      >
        Skip to content
      </a>
      <TopProgressBar />
      <Header onMenu={onMenu} />
      <div className="flex">
        <Sidebar collapsed={collapsed} onToggle={toggleCollapsed} />
        <main id="main" tabIndex={-1} className="flex-1 min-w-0 outline-none">
          <div className="max-w-[1280px] mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:py-8 pb-28">
            <RouteContent />
          </div>
        </main>
      </div>
      <NavDrawer open={drawerOpen} onOpenChange={setDrawerOpen} />
      <CommandPalette />
      {pathname !== "/assistant" && <ChatFabAndPanel />}
      <Toaster
        position="bottom-left"
        theme={theme}
        closeButton
        toastOptions={{
          className: "!bg-panel !text-ink !border !border-line !shadow-lg !rounded-xl !text-sm",
          descriptionClassName: "!text-ink2",
        }}
      />
    </div>
  );
}
