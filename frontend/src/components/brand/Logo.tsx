import markUrl from "../../assets/brand/encop-mark.png";
import wordUrl from "../../assets/brand/encop-wordmark.png";
import { MARK_SIZE } from "./markShape";

export { markUrl };

/** Width / height of the mark and of the wordmark, from the artwork. */
export const MARK_ASPECT = MARK_SIZE.width / MARK_SIZE.height;
const WORD_ASPECT = 574 / 140;

/**
 * The Encop mark (red panel, stripe and pointing hand), from the supplied artwork. `size` is its height in px.
 * `intro` pops it in with a short spin; `shine` runs a light sweep across it every few seconds. The artwork reads
 * on light and dark surfaces alike, so there is no per-theme variant.
 */
export function LogoMark({
  size = 40,
  intro = false,
  shine = true,
  className = "",
}: {
  size?: number;
  intro?: boolean;
  shine?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`logo-mark relative inline-block flex-none ${intro ? "logo-intro" : ""} ${className}`}
      style={{ height: size, width: size * MARK_ASPECT }}
      aria-hidden
    >
      <img src={markUrl} alt="" draggable={false} className="block h-full w-full select-none" />
      {shine && <span className="logo-shine" style={{ WebkitMaskImage: `url(${markUrl})`, maskImage: `url(${markUrl})` }} />}
    </span>
  );
}

/**
 * "encop" set in the logo's lettering. The artwork is used as a mask over the current text colour, so it is
 * white on dark surfaces and near-black on light ones without a second image. `height` is the box height in px
 * (the "p" descender included), so the lowercase letters stand about 0.7 of that.
 */
export function Wordmark({ height = 22, className = "" }: { height?: number; className?: string }) {
  return (
    <span
      role="img"
      aria-label="Encop"
      className={`inline-block flex-none bg-current ${className}`}
      style={{
        height,
        width: height * WORD_ASPECT,
        WebkitMaskImage: `url(${wordUrl})`,
        maskImage: `url(${wordUrl})`,
        WebkitMaskSize: "100% 100%",
        maskSize: "100% 100%",
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
      }}
    />
  );
}
