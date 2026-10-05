import { useEffect, useId, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Check, ChevronDown, X } from "lucide-react";

export interface ComboOption {
  value: string;
  label: string;
  hint?: string;
}

const MAX_SHOWN = 60;

/**
 * A searchable single-choice picker (ARIA combobox). Type to filter, arrows to move, Enter to choose,
 * Escape to close. `value` is the chosen option's value ("" for none).
 */
export function Combobox({
  id,
  value,
  onChange,
  options,
  placeholder = "Search…",
  emptyText = "Nothing matches",
  disabled,
  invalid,
  clearable,
  className,
  "aria-label": ariaLabel,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: ComboOption[];
  placeholder?: string;
  emptyText?: string;
  disabled?: boolean;
  invalid?: boolean;
  clearable?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const autoId = useId();
  const listId = `${autoId}-list`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selected = options.find((o) => o.value === value);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = q ? options.filter((o) => `${o.label} ${o.hint ?? ""}`.toLowerCase().includes(q)) : options;
    return all.slice(0, MAX_SHOWN);
  }, [options, query]);

  useEffect(() => setActive(0), [query, open]);
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const choose = (o: ComboOption) => {
    onChange(o.value);
    setOpen(false);
    setQuery("");
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      else setActive((i) => Math.min(i + 1, shown.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      if (open) {
        e.preventDefault();
        if (shown[active]) choose(shown[active]);
      }
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      setQuery("");
    }
  };

  return (
    <div className={clsx("relative", className)}>
      <input
        ref={inputRef}
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && shown[active] ? `${listId}-${active}` : undefined}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        autoComplete="off"
        disabled={disabled}
        placeholder={selected ? selected.label : placeholder}
        value={open ? query : selected?.label ?? ""}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          setQuery("");
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        className={clsx("field h-8 text-sm pl-3 text-ellipsis", clearable && selected && !disabled ? "pr-14" : "pr-8")}
      />
      {clearable && selected && !disabled && (
        <button
          type="button"
          aria-label="Clear selection"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            onChange("");
            setQuery("");
          }}
          className="absolute right-7 top-1/2 -translate-y-1/2 w-5 h-5 rounded flex items-center justify-center text-ink3 hover:text-ink hover:bg-panel2"
        >
          <X size={14} />
        </button>
      )}
      <ChevronDown size={16} className="absolute right-2 top-1/2 -translate-y-1/2 text-ink2 pointer-events-none" aria-hidden />
      {open && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          className="absolute z-30 left-0 right-0 mt-1 max-h-60 overflow-auto rounded-lg border border-line bg-panel shadow-md p-1"
        >
          {shown.length === 0 && <li className="px-2 py-2 text-[13px] text-ink2">{emptyText}</li>}
          {shown.map((o, i) => (
            <li
              key={o.value}
              id={`${listId}-${i}`}
              data-index={i}
              role="option"
              aria-selected={o.value === value}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(o)}
              onMouseMove={() => setActive(i)}
              className={clsx(
                "flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer text-sm",
                i === active ? "bg-panel2" : "",
                o.value === value && "font-semibold"
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ink">{o.label}</span>
                {o.hint && <span className="block truncate text-xs text-ink2">{o.hint}</span>}
              </span>
              {o.value === value && <Check size={14} className="text-accent flex-none" aria-hidden />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A set of chosen options shown as removable chips, with a search box to add more. */
export function MultiCombobox({
  id,
  values,
  onChange,
  options,
  placeholder = "Add…",
  label,
  disabled,
  invalid,
}: {
  id?: string;
  values: string[];
  onChange: (values: string[]) => void;
  options: ComboOption[];
  placeholder?: string;
  label: (value: string) => string;
  disabled?: boolean;
  invalid?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      {values.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Chosen">
          {values.map((v) => (
            <li key={v} className="inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded-full bg-panel2 border border-line text-xs text-ink">
              <span className="truncate max-w-[200px]">{label(v)}</span>
              {!disabled && (
                <button
                  type="button"
                  aria-label={`Remove ${label(v)}`}
                  onClick={() => onChange(values.filter((x) => x !== v))}
                  className="w-4 h-4 rounded-full flex items-center justify-center text-ink3 hover:text-ink hover:bg-panel3"
                >
                  <X size={12} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <Combobox
        id={id}
        value=""
        onChange={(v) => v && !values.includes(v) && onChange([...values, v])}
        options={options.filter((o) => !values.includes(o.value))}
        placeholder={placeholder}
        disabled={disabled}
        invalid={invalid}
      />
    </div>
  );
}
