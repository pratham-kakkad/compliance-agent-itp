import { useId } from "react";
import clsx from "clsx";

/** A group of mutually exclusive choices, each with a short explanation. Native radios underneath. */
export function RadioCards<T extends string>({
  value,
  onChange,
  options,
  name,
  legend,
  columns = 2,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; description?: string }[];
  name?: string;
  legend: string;
  columns?: 1 | 2;
}) {
  const auto = useId();
  const group = name ?? auto;
  return (
    <fieldset className="min-w-0 border-0 p-0 m-0">
      <legend className="sr-only">{legend}</legend>
      <div className={clsx("grid gap-2", columns === 2 && "sm:grid-cols-2")}>
        {options.map((o) => {
          const active = o.value === value;
          return (
            <label
              key={o.value}
              className={clsx(
                "relative flex items-start gap-2.5 rounded-lg border p-3 cursor-pointer transition-colors",
                "has-[:focus-visible]:shadow-[0_0_0_3px_color-mix(in_srgb,var(--focus)_28%,transparent)]",
                active ? "border-accent bg-accent-soft" : "border-line bg-panel hover:border-line-strong"
              )}
            >
              <input
                type="radio"
                name={group}
                value={o.value}
                checked={active}
                onChange={() => onChange(o.value)}
                className="mt-0.5 accent-[var(--accent)] flex-none"
              />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-ink">{o.label}</span>
                {o.description && <span className="block text-[13px] text-ink2 mt-0.5 leading-[18px]">{o.description}</span>}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
