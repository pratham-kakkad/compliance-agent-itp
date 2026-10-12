import clsx from "clsx";
import { Link } from "react-router-dom";
import { ChevronRight, type LucideIcon } from "lucide-react";

const PADDING = { none: "", sm: "p-3", md: "p-4" };

export function Card({
  className,
  children,
  interactive,
  padding = "md",
  as: As = "div",
}: {
  className?: string;
  children: React.ReactNode;
  interactive?: boolean;
  padding?: "none" | "sm" | "md";
  as?: "div" | "section" | "article";
}) {
  return (
    <As
      className={clsx(
        "spot glass rounded-2xl",
        interactive && "cursor-pointer transition-[transform,box-shadow] duration-200 ease-standard hover:-translate-y-0.5",
        PADDING[padding],
        className
      )}
    >
      {children}
    </As>
  );
}

export function CardHeader({
  title,
  description,
  actions,
  icon: Icon,
  divider,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  icon?: LucideIcon;
  divider?: boolean;
  className?: string;
}) {
  return (
    <div
      className={clsx(
        "flex items-start justify-between gap-3",
        divider ? "px-4 py-3 border-b border-line" : "mb-3",
        className
      )}
    >
      <div className="min-w-0 flex items-start gap-2">
        {Icon && <Icon size={16} className="text-ink2 mt-0.5 flex-none" aria-hidden />}
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-ink leading-5">{title}</h3>
          {description && <p className="text-[13px] text-ink2 mt-0.5 leading-[18px]">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2 flex-none">{actions}</div>}
    </div>
  );
}

/** Back-compat card title row. */
export function PanelTitle({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 mb-3">
      <h3 className="text-sm font-semibold text-ink">{children}</h3>
      {hint && <div className="text-xs text-ink3">{hint}</div>}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  description,
  actions,
  breadcrumbs,
  divider,
}: {
  title: string;
  subtitle?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  breadcrumbs?: { label: string; to?: string }[];
  divider?: boolean;
}) {
  const desc = description ?? subtitle;
  return (
    <div className={clsx("mb-6", divider && "pb-4 border-b border-line")}>
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-[13px] text-ink2 mb-2">
          {breadcrumbs.map((b, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <ChevronRight size={14} className="text-ink3" aria-hidden />}
              {b.to ? (
                <Link to={b.to} className="hover:text-accent hover:underline">
                  {b.label}
                </Link>
              ) : (
                <span>{b.label}</span>
              )}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-[-0.01em] text-ink">{title}</h1>
          {desc && <p className="text-sm text-ink2 mt-1">{desc}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function SectionHeader({
  title,
  description,
  icon: Icon,
  action,
  className,
}: {
  title: string;
  description?: string;
  icon?: LucideIcon;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx("flex items-end justify-between gap-3 mb-3", className)}>
      <div className="flex items-center gap-2 min-w-0">
        {Icon && (
          <span className="w-7 h-7 rounded-md bg-panel border border-line flex items-center justify-center text-ink2 flex-none">
            <Icon size={15} aria-hidden />
          </span>
        )}
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-ink">{title}</h2>
          {description && <p className="text-[13px] text-ink2">{description}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}
