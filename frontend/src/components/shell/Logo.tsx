import { Link } from "react-router-dom";
import { LogoMark as BrandMark, Wordmark } from "../brand/Logo";

/** The mark on the page (the artwork works on both themes). */
export function ThemedMark({ size = 26, shine = true, className }: { size?: number; shine?: boolean; className?: string }) {
  return <BrandMark size={size} shine={shine} className={className} />;
}

/** App-icon tile: the mark on black (chat avatars, boot screen). */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <span
      className="inline-flex items-center justify-center rounded-md flex-none bg-black ring-1 ring-white/10"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <BrandMark size={Math.round(size * 0.5)} shine={false} />
    </span>
  );
}

/** Header/drawer brand: the mark and the "encop" wordmark. */
export function Logo({ to = "/" }: { to?: string }) {
  return (
    <Link to={to} className="flex items-center gap-2.5 rounded-md text-ink" aria-label="Encop home">
      <ThemedMark size={24} className="floaty" />
      <Wordmark height={20} />
    </Link>
  );
}
