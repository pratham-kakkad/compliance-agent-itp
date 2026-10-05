import { forwardRef, useCallback } from "react";
import clsx from "clsx";
import type { LucideIcon } from "lucide-react";
import { prefersReducedMotion } from "../../lib/motion";
import { Tooltip } from "./Tooltip";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "outline";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent-emphasis text-white border border-transparent hover:bg-accent-emphasis-hover shadow-xs",
  secondary: "bg-panel2 text-ink border border-line hover:bg-panel3 hover:border-line-strong shadow-xs",
  outline: "bg-transparent text-ink border border-line hover:bg-panel2",
  ghost: "bg-transparent text-ink border border-transparent hover:bg-panel2",
  danger: "bg-panel2 text-crit border border-line hover:bg-crit-bg hover:border-crit",
};

const SIZES = {
  sm: "h-7 px-2.5 text-[13px] gap-1.5",
  md: "h-8 px-3 text-sm gap-2",
  lg: "h-10 px-4 text-sm gap-2",
};

/** Material-style ink ripple from the pointer position. */
export function useRipple() {
  return useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (prefersReducedMotion()) return;
    const host = e.currentTarget;
    const rect = host.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 2;
    const span = document.createElement("span");
    span.className = "ripple";
    span.style.width = span.style.height = `${size}px`;
    span.style.left = `${e.clientX - rect.left - size / 2}px`;
    span.style.top = `${e.clientY - rect.top - size / 2}px`;
    host.appendChild(span);
    span.addEventListener("animationend", () => span.remove());
  }, []);
}

export function Spinner({ size = 16, className, label = "Loading" }: { size?: number; className?: string; label?: string }) {
  return (
    <span role="status" aria-label={label} className={clsx("inline-flex", className)}>
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ animation: "spin 0.8s linear infinite" }}>
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
        <path d="M14.5 8A6.5 6.5 0 0 0 8 1.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </span>
  );
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  leadingIcon?: LucideIcon;
  trailingIcon?: LucideIcon;
  loading?: boolean;
  block?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", leadingIcon: Lead, trailingIcon: Trail, loading, block, className, children, disabled, onPointerDown, type = "button", ...rest },
  ref
) {
  const ripple = useRipple();
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      onPointerDown={(e) => {
        ripple(e);
        onPointerDown?.(e);
      }}
      className={clsx(
        "ripple-host inline-flex items-center justify-center rounded-md font-semibold whitespace-nowrap select-none",
        "transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-standard active:scale-[0.96]",
        "disabled:opacity-50 disabled:pointer-events-none",
        VARIANTS[variant],
        SIZES[size],
        block && "w-full",
        className
      )}
      {...rest}
    >
      {loading ? <Spinner size={14} /> : Lead && <Lead size={16} aria-hidden className="flex-none" />}
      {children}
      {Trail && !loading && <Trail size={16} aria-hidden className="flex-none" />}
    </button>
  );
});

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  label: string;
  variant?: "ghost" | "secondary";
  size?: "sm" | "md";
  tooltip?: boolean;
  iconClassName?: string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, label, variant = "ghost", size = "md", tooltip = true, className, iconClassName, onPointerDown, type = "button", ...rest },
  ref
) {
  const ripple = useRipple();
  const btn = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      onPointerDown={(e) => {
        ripple(e);
        onPointerDown?.(e);
      }}
      className={clsx(
        "ripple-host inline-flex items-center justify-center rounded-md text-ink2 hover:text-ink flex-none",
        "transition-[background-color,border-color,color] duration-100 ease-standard disabled:opacity-50 disabled:pointer-events-none",
        size === "sm" ? "w-7 h-7" : "w-8 h-8",
        variant === "secondary" ? "bg-panel2 border border-line hover:bg-panel3" : "hover:bg-panel2",
        className
      )}
      {...rest}
    >
      <Icon size={16} aria-hidden className={iconClassName} />
    </button>
  );
  return tooltip ? <Tooltip content={label}>{btn}</Tooltip> : btn;
});
