import clsx from "clsx";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";

/** The rows of an action list ("who to chase"): hairlines between them. */
export function ActionList({ children, className }: { children: React.ReactNode; className?: string }) {
  return <ul className={clsx("divide-y divide-line-soft", className)}>{children}</ul>;
}

/**
 * One row of an action list: something at the left (an avatar), a title with a line of context, and what matters at the
 * right. It is a link (`to`) or a button (`onClick`) when it drills down, and a plain row otherwise.
 */
export function ActionRow({
  leading,
  title,
  sub,
  right,
  to,
  onClick,
  label,
}: {
  leading?: React.ReactNode;
  title: React.ReactNode;
  sub?: React.ReactNode;
  right?: React.ReactNode;
  to?: string;
  onClick?: () => void;
  label?: string;
}) {
  const inner = (
    <>
      {leading}
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-semibold text-ink truncate group-hover:text-accent transition-colors">{title}</div>
        {sub && <div className="text-[12px] text-ink3 truncate">{sub}</div>}
      </div>
      {right && <div className="flex-none flex items-center gap-2 text-[13px] tabular">{right}</div>}
    </>
  );
  const cls = "group flex items-center gap-3 py-2.5 first:pt-0 last:pb-0 w-full text-left";
  return (
    <li>
      {to ? (
        <Link to={to} className={cls} aria-label={label}>
          {inner}
        </Link>
      ) : onClick ? (
        <button type="button" onClick={onClick} className={clsx(cls, "focus-ring rounded-md")} aria-label={label}>
          {inner}
        </button>
      ) : (
        <div className={cls}>{inner}</div>
      )}
    </li>
  );
}

/** A quiet "see all" link under a list. */
export function SeeAll({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link to={to} className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline">
      {children} <ArrowRight size={13} aria-hidden />
    </Link>
  );
}
