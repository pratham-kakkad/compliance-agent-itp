import clsx from "clsx";
import { KIND_LABEL, type TemplateKind } from "../../../lib/emailTemplates";

/**
 * Colour of each kind of template. Red is reserved for the escalation ("final"); the others take the
 * interface hues: reminder sky, warning amber, request violet, thanks emerald, custom neutral.
 */
const STYLE: Record<TemplateKind, { color: string; bg: string }> = {
  reminder: { color: "var(--info)", bg: "var(--info-bg)" },
  warning: { color: "var(--warn)", bg: "var(--warn-bg)" },
  final: { color: "var(--crit)", bg: "var(--crit-bg)" },
  request: { color: "rgb(var(--hue-violet))", bg: "rgba(var(--hue-violet), 0.14)" },
  thanks: { color: "var(--good)", bg: "var(--good-bg)" },
  custom: { color: "var(--text-soft)", bg: "var(--neutral-bg)" },
};

export function kindColor(kind: TemplateKind): string {
  return STYLE[kind]?.color ?? STYLE.custom.color;
}

export function KindChip({ kind, size = "md", className }: { kind: TemplateKind; size?: "sm" | "md"; className?: string }) {
  const s = STYLE[kind] ?? STYLE.custom;
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full font-medium whitespace-nowrap flex-none",
        size === "sm" ? "h-5 px-2 text-[11px]" : "h-[22px] px-2.5 text-xs",
        className
      )}
      style={{ color: s.color, background: s.bg }}
    >
      <span className="w-1.5 h-1.5 rounded-full flex-none" style={{ background: s.color }} aria-hidden />
      {KIND_LABEL[kind] ?? kind}
    </span>
  );
}
