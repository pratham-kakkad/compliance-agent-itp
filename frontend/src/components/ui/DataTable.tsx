import { useMemo, useState } from "react";
import clsx from "clsx";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { TableSkeleton } from "./Feedback";

export interface Column<T> {
  key: string;
  header: React.ReactNode;
  cell: (row: T, index: number) => React.ReactNode;
  sortValue?: (row: T) => string | number | null | undefined;
  align?: "left" | "right" | "center";
  width?: string;
  className?: string;
  hideBelow?: "sm" | "md" | "lg";
}

const HIDE = { sm: "hidden sm:table-cell", md: "hidden md:table-cell", lg: "hidden lg:table-cell" };
const ALIGN = { left: "text-left", right: "text-right", center: "text-center" };

export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  onRowClick,
  rowLabel,
  loading,
  skeletonRows = 6,
  empty,
  defaultSort,
  dim,
  dense,
  className,
  caption,
  rank,
}: {
  columns: Column<T>[];
  rows: T[];
  getRowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  rowLabel?: (row: T) => string;
  loading?: boolean;
  skeletonRows?: number;
  empty?: React.ReactNode;
  defaultSort?: { key: string; dir: "asc" | "desc" };
  dim?: boolean;
  dense?: boolean;
  className?: string;
  caption?: string;
  rank?: boolean;
}) {
  const [sort, setSort] = useState(defaultSort ?? null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const get = col.sortValue;
    return [...rows].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      // Missing values always sink to the bottom regardless of direction.
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
      return sort.dir === "asc" ? cmp : -cmp;
    });
  }, [rows, sort, columns]);

  if (loading && rows.length === 0) return <TableSkeleton rows={skeletonRows} columns={Math.min(columns.length, 5)} />;
  if (!loading && rows.length === 0) return <>{empty}</>;

  const toggleSort = (key: string) =>
    setSort((s) => (s?.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));

  const cellPad = dense ? "py-2" : "py-2.5";

  return (
    <div className={clsx("overflow-x-auto transition-opacity duration-150", dim && "opacity-60", className)}>
      <table className="w-full border-collapse text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="bg-panel2 border-b border-line">
            {rank && <th scope="col" className="w-10 pl-4 pr-1 h-9 text-left text-xs font-semibold text-ink2">#</th>}
            {columns.map((c, i) => {
              const active = sort?.key === c.key;
              const Icon = active ? (sort!.dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
              return (
                <th
                  key={c.key}
                  scope="col"
                  style={{ width: c.width }}
                  aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : undefined}
                  className={clsx(
                    "h-9 px-3 text-xs font-semibold text-ink2 whitespace-nowrap",
                    ALIGN[c.align ?? "left"],
                    i === 0 && !rank && "pl-4",
                    i === columns.length - 1 && "pr-4",
                    c.hideBelow && HIDE[c.hideBelow]
                  )}
                >
                  {c.sortValue ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(c.key)}
                      className={clsx("group inline-flex items-center gap-1 rounded hover:text-ink", c.align === "right" && "flex-row-reverse", active && "text-ink")}
                    >
                      {c.header}
                      <Icon size={13} className={clsx("transition-opacity", active ? "opacity-100" : "opacity-0 group-hover:opacity-60")} aria-hidden />
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, idx) => (
            <tr
              key={getRowKey(row)}
              style={{ "--row": Math.min(idx, 14) } as React.CSSProperties}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onRowClick(row);
                      }
                    }
                  : undefined
              }
              tabIndex={onRowClick ? 0 : undefined}
              aria-label={onRowClick && rowLabel ? rowLabel(row) : undefined}
              className={clsx(
                "mc-row border-b border-line-soft last:border-0 transition-colors duration-100",
                onRowClick && "cursor-pointer hover:bg-panel2 focus-visible:bg-panel2 focus-visible:outline-none focus-visible:shadow-[inset_2px_0_0_var(--accent)]"
              )}
            >
              {rank && <td className={clsx("pl-4 pr-1 text-xs text-ink3 tabular", cellPad)}>{idx + 1}</td>}
              {columns.map((c, i) => (
                <td
                  key={c.key}
                  className={clsx(
                    "px-3 align-middle",
                    cellPad,
                    ALIGN[c.align ?? "left"],
                    c.align === "right" && "tabular",
                    i === 0 && !rank && "pl-4",
                    i === columns.length - 1 && "pr-4",
                    c.hideBelow && HIDE[c.hideBelow],
                    c.className
                  )}
                >
                  {c.cell(row, idx)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
