import { Link } from "react-router-dom";
import { useTheme } from "../../lib/useTheme";
import { BrandName, LogoMark as BrandMark } from "../brand/Logo";

/** The mark on the page, tuned for the current theme (the navy half is brightened on dark surfaces). */
export function ThemedMark({ size = 26, shine = true, className }: { size?: number; shine?: boolean; className?: string }) {
  const { theme } = useTheme();
  return <BrandMark size={size} tone={theme === "dark" ? "dark" : "light"} shine={shine} className={className} />;
}

/** App-icon tile: the mark on the brand navy (chat avatars, boot screen). */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <span
      className="inline-flex items-center justify-center rounded-md flex-none ring-1 ring-white/10"
      style={{ width: size, height: size, background: "linear-gradient(135deg, #0b2a66, #041033)" }}
      aria-hidden
    >
      <BrandMark size={Math.round(size * 0.72)} tone="dark" shine={false} />
    </span>
  );
}

/** Header/drawer brand: the mark, "INT COMPLY" and (on wide screens) the tagline. */
export function Logo({ to = "/" }: { to?: string }) {
  return (
    <Link to={to} className="flex items-center gap-2.5 rounded-md text-ink" aria-label="INT Comply home">
      <ThemedMark size={28} className="floaty" />
      <BrandName className="text-[16px]" />
      <span className="hidden lg:block h-4 w-px bg-line-strong" aria-hidden />
      <span className="hidden lg:block text-[10px] font-semibold uppercase tracking-[0.12em] text-ink3 whitespace-nowrap leading-[1.25]">
        Integrated Compliance
        <br />
        Solutions
      </span>
    </Link>
  );
}
