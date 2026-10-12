import { Outlet } from "react-router-dom";
import { motion } from "framer-motion";
import { MoonStar, Sun } from "lucide-react";
import { useTheme } from "../../lib/useTheme";
import { duration, ease } from "../../lib/motion";
import { IconButton } from "../../components/ui";
import { LogoScene } from "../../components/three/LogoScene";
import { LogoMark, Wordmark } from "../../components/brand/Logo";

// The stage behind the 3D mark: indigo, violet and cyan washes on deep navy. Red is only the logo itself.
const STAGE_BG =
  "radial-gradient(70% 90% at 15% 15%, rgba(99,102,241,0.55) 0%, transparent 62%), " +
  "radial-gradient(60% 80% at 88% 28%, rgba(139,92,246,0.42) 0%, transparent 60%), " +
  "radial-gradient(75% 70% at 50% 112%, rgba(34,211,238,0.3) 0%, transparent 65%), #0a0b1f";

/** The signed-out frame: the hero card with the 3D mark above whichever page is routed in (<Outlet />). */
export function AuthLayout() {
  const { theme, toggle } = useTheme();
  return (
    <div className="min-h-screen flex flex-col">
      <div className="flex justify-end p-4">
        <IconButton icon={theme === "dark" ? Sun : MoonStar} label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} onClick={toggle} />
      </div>

      <main className="flex-1 flex flex-col items-center px-4 pb-12 pt-2 sm:pt-6">
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: duration.medium, ease: ease.decelerate }}
          className="w-full max-w-[420px]"
        >
          <div className="relative mb-5 overflow-hidden rounded-2xl border border-white/10 text-center shadow-lg" style={{ background: STAGE_BG }}>
            <LogoScene
              variant="hero"
              className="h-[190px] w-full"
              fallback={
                <div className="flex h-full items-center justify-center">
                  <LogoMark size={88} intro />
                </div>
              }
            />
            <div className="relative -mt-3 px-6 pb-5">
              <Wordmark height={24} className="text-white" />
              <p className="mt-2 text-sm text-white/70">Every compliance signal across your org, in one place.</p>
            </div>
          </div>

          <Outlet />
        </motion.div>
      </main>

      <footer className="py-6 text-center text-xs text-ink3">Encop · Compliance Platform</footer>
    </div>
  );
}
