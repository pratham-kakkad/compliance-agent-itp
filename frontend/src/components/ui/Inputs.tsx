import { forwardRef, useId, useRef } from "react";
import clsx from "clsx";
import { motion } from "framer-motion";
import { ChevronDown, Search, X, type LucideIcon } from "lucide-react";
import { spring } from "../../lib/motion";

const HEIGHT = { sm: "h-7 text-[13px]", md: "h-8 text-sm", lg: "h-10 text-sm" };

type TextInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> & {
  leadingIcon?: LucideIcon;
  trailingVisual?: React.ReactNode;
  size?: "sm" | "md" | "lg";
  invalid?: boolean;
  onClear?: () => void;
};

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { leadingIcon: Lead, trailingVisual, size = "md", invalid, onClear, className, value, ...rest },
  ref
) {
  const showClear = onClear && value !== undefined && String(value).length > 0;
  return (
    <div className={clsx("relative flex items-center", className)}>
      {Lead && <Lead size={16} className="absolute left-2.5 text-ink3 pointer-events-none" aria-hidden />}
      <input
        ref={ref}
        value={value}
        aria-invalid={invalid || undefined}
        className={clsx("field", HEIGHT[size], Lead ? "pl-8" : "pl-3", showClear || trailingVisual ? "pr-8" : "pr-3")}
        {...rest}
      />
      {showClear ? (
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear"
          className="absolute right-1.5 w-5 h-5 rounded flex items-center justify-center text-ink3 hover:text-ink hover:bg-panel2"
        >
          <X size={14} />
        </button>
      ) : (
        trailingVisual && <span className="absolute right-2.5 flex items-center">{trailingVisual}</span>
      )}
    </div>
  );
});

export function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
  className,
  autoFocus,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  "aria-label"?: string;
}) {
  return (
    <TextInput
      type="search"
      leadingIcon={Search}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onClear={() => onChange("")}
      onKeyDown={(e) => {
        if (e.key === "Escape" && value) {
          e.stopPropagation();
          onChange("");
        }
      }}
      placeholder={placeholder}
      aria-label={ariaLabel ?? placeholder}
      autoFocus={autoFocus}
      className={className}
    />
  );
}

type SelectProps = Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "size"> & {
  size?: "sm" | "md";
  options?: { value: string; label: string }[];
};

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ size = "md", options, className, children, ...rest }, ref) {
  return (
    <div className={clsx("relative inline-flex items-center", className)}>
      <select ref={ref} className={clsx("field appearance-none pl-3 pr-8 cursor-pointer", HEIGHT[size])} {...rest}>
        {options ? options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>) : children}
      </select>
      <ChevronDown size={16} className="absolute right-2 text-ink2 pointer-events-none" aria-hidden />
    </div>
  );
});

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  size = "md",
  "aria-label": ariaLabel,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; icon?: LucideIcon }[];
  size?: "sm" | "md";
  "aria-label": string;
  className?: string;
}) {
  const id = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const next = (i + dir + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={clsx("inline-flex p-0.5 rounded-md bg-panel2 border border-line", className)}>
      {options.map((o, i) => {
        const active = o.value === value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            ref={(el) => (refs.current[i] = el)}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKey(e, i)}
            className={clsx(
              "relative inline-flex items-center gap-1.5 rounded-[5px] font-medium transition-colors duration-100",
              size === "sm" ? "h-6 px-2.5 text-xs" : "h-7 px-3 text-[13px]",
              active ? "text-ink" : "text-ink2 hover:text-ink"
            )}
          >
            {active && (
              <motion.span
                layoutId={`seg-${id}`}
                transition={spring.indicator}
                className="absolute inset-0 rounded-[5px] bg-panel border border-line shadow-xs"
              />
            )}
            <span className="relative flex items-center gap-1.5">
              {Icon && <Icon size={14} aria-hidden />}
              {o.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  items,
  className,
  "aria-label": ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  items: { value: T; label: string; count?: number; icon?: LucideIcon }[];
  className?: string;
  "aria-label"?: string;
}) {
  const id = useId();
  return (
    <div role="tablist" aria-label={ariaLabel} className={clsx("flex gap-1 border-b border-line", className)}>
      {items.map((t) => {
        const active = t.value === value;
        const Icon = t.icon;
        return (
          <button
            key={t.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.value)}
            className={clsx(
              "relative flex items-center gap-2 h-10 px-2 text-sm transition-colors",
              active ? "text-ink font-semibold" : "text-ink2 hover:text-ink"
            )}
          >
            <span className="flex items-center gap-2 px-1.5 py-1 rounded-md hover:bg-panel2">
              {Icon && <Icon size={16} aria-hidden />}
              {t.label}
              {t.count != null && <span className="min-w-[20px] h-5 px-1.5 rounded-full bg-neutral-bg text-xs font-medium flex items-center justify-center">{t.count}</span>}
            </span>
            {active && <motion.span layoutId={`tab-${id}`} transition={spring.indicator} className="absolute left-0 right-0 -bottom-px h-0.5 rounded-full bg-accent" />}
          </button>
        );
      })}
    </div>
  );
}
