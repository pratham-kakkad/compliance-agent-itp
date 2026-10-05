import { useId } from "react";
import { MARK_COPPER_D, MARK_NAVY_D, MARK_VIEWBOX } from "./markPaths";

const NAVY_STOPS = {
  light: ["#1d56a0", "#0c3470", "#021a52"],
  dark: ["#6c9cf0", "#3b6fd4", "#244fa8"],
} as const;

/**
 * The INT Comply star mark as inline SVG (traced from the supplied artwork), so it can animate:
 * `intro` pops it in with a spin, `shine` runs a light sweep across the metal. `tone="dark"` brightens the
 * navy half for use on dark surfaces.
 */
export function LogoMark({
  size = 40,
  tone = "light",
  intro = false,
  shine = true,
  className = "",
}: {
  size?: number;
  tone?: "light" | "dark";
  intro?: boolean;
  shine?: boolean;
  className?: string;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [n0, n1, n2] = NAVY_STOPS[tone];
  const { width: w, height: h } = MARK_VIEWBOX;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width={size}
      height={size}
      className={`${intro ? "logo-intro" : ""} ${className}`}
      aria-hidden
      focusable="false"
    >
      <defs>
        <linearGradient id={`n${uid}`} gradientUnits="userSpaceOnUse" x1="60" y1="0" x2="240" y2={h}>
          <stop offset="0" stopColor={n0} />
          <stop offset=".55" stopColor={n1} />
          <stop offset="1" stopColor={n2} />
        </linearGradient>
        <linearGradient id={`c${uid}`} gradientUnits="userSpaceOnUse" x1={w} y1="10" x2="120" y2={h}>
          <stop offset="0" stopColor="#f6cfb0" />
          <stop offset=".45" stopColor="#cf9972" />
          <stop offset="1" stopColor="#8f5636" />
        </linearGradient>
        <linearGradient id={`s${uid}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset=".5" stopColor="#fff" stopOpacity=".85" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <clipPath id={`k${uid}`}>
          <path d={MARK_NAVY_D} fillRule="evenodd" />
          <path d={MARK_COPPER_D} fillRule="evenodd" />
        </clipPath>
      </defs>
      <path d={MARK_NAVY_D} fill={`url(#n${uid})`} fillRule="evenodd" />
      <path d={MARK_COPPER_D} fill={`url(#c${uid})`} fillRule="evenodd" />
      {shine && (
        <g clipPath={`url(#k${uid})`}>
          <rect className="logo-shine" x={-w * 0.6} y="-20" width={w * 0.5} height={h + 40} fill={`url(#s${uid})`} />
        </g>
      )}
    </svg>
  );
}

/** "INT COMPLY" set in the brand's navy + copper. `tone="dark"` lightens the navy for dark surfaces. */
export function BrandName({
  className = "",
  tone = "light",
}: {
  className?: string;
  tone?: "light" | "dark";
}) {
  return (
    <span className={`font-extrabold uppercase leading-none tracking-[0.02em] ${className}`}>
      <span style={{ color: tone === "dark" ? "#8db3f5" : "var(--deep-blue)" }}>INT</span>{" "}
      <span className="text-copper">COMPLY</span>
    </span>
  );
}
