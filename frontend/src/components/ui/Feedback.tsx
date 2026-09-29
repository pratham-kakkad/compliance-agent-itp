import clsx from "clsx";
import { AlertTriangle, CheckCircle2, Info, X, XCircle, type LucideIcon } from "lucide-react";
import { Button } from "./Button";

export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={clsx("skeleton", className)} style={style} aria-hidden />;
}

export function StatGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4" aria-busy="true">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="bg-panel border border-line rounded-lg p-4 sm:p-5">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-8 w-20 mt-3" />
          <Skeleton className="h-3 w-36 mt-2.5" />
        </div>
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 6, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div aria-busy="true">
      <div className="flex gap-6 px-4 h-9 items-center bg-panel2 border-b border-line">
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={i} className="h-3" style={{ width: i === 0 ? 120 : 64 }} />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-6 px-4 h-11 items-center border-b border-line-soft last:border-0">
          {Array.from({ length: columns }).map((_, c) => (
            <Skeleton key={c} className="h-3.5" style={{ width: c === 0 ? `${40 + ((r * 17) % 30)}%` : 72 }} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  compact,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div className={clsx("flex flex-col items-center justify-center text-center", compact ? "py-6 px-4" : "py-12 px-6", className)}>
      {Icon && (
        <span className={clsx("rounded-full bg-panel2 border border-line flex items-center justify-center text-ink2 mb-3", compact ? "w-9 h-9" : "w-11 h-11")}>
          <Icon size={compact ? 16 : 20} aria-hidden />
        </span>
      )}
      <p className="text-sm font-semibold text-ink">{title}</p>
      {description && <p className="text-[13px] text-ink2 mt-1 max-w-sm">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Back-compat small muted note. */
export function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="text-[13px] text-ink2 py-4">{children}</p>;
}

export function ErrorState({ title = "Something went wrong", message, onRetry, compact }: { title?: string; message?: string; onRetry?: () => void; compact?: boolean }) {
  return (
    <EmptyState
      icon={AlertTriangle}
      title={title}
      description={message || "The data couldn't be loaded. Check your connection and try again."}
      action={onRetry && <Button size="sm" onClick={onRetry}>Try again</Button>}
      compact={compact}
    />
  );
}

const BANNER = {
  info: { cls: "bg-accent-soft text-ink", icon: Info, iconCls: "text-accent" },
  good: { cls: "bg-good-bg text-ink", icon: CheckCircle2, iconCls: "text-good" },
  warn: { cls: "bg-warn-bg text-ink", icon: AlertTriangle, iconCls: "text-warn" },
  crit: { cls: "bg-crit-bg text-ink", icon: XCircle, iconCls: "text-crit" },
};

export function Banner({
  tone = "info",
  title,
  children,
  icon,
  onDismiss,
  action,
  className,
}: {
  tone?: "info" | "good" | "warn" | "crit";
  title?: string;
  children?: React.ReactNode;
  icon?: LucideIcon;
  onDismiss?: () => void;
  action?: React.ReactNode;
  className?: string;
}) {
  const s = BANNER[tone];
  const Icon = icon ?? s.icon;
  return (
    <div role={tone === "crit" ? "alert" : "status"} className={clsx("flex items-start gap-3 rounded-lg border px-4 py-3 text-sm", s.cls, className)} style={{ borderColor: `color-mix(in srgb, var(--${tone === "info" ? "accent" : tone}) 35%, transparent)` }}>
      <Icon size={16} className={clsx("mt-0.5 flex-none", s.iconCls)} aria-hidden />
      <div className="flex-1 min-w-0">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={clsx("text-ink2", title && "mt-0.5")}>{children}</div>}
      </div>
      {action}
      {onDismiss && (
        <button onClick={onDismiss} aria-label="Dismiss" className="text-ink2 hover:text-ink -mr-1 p-0.5 rounded">
          <X size={16} />
        </button>
      )}
    </div>
  );
}

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd className={clsx("inline-flex items-center h-5 px-1.5 rounded border border-line bg-panel2 text-[11px] font-sans font-medium text-ink2 leading-none", className)}>
      {children}
    </kbd>
  );
}
