import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, ChevronsDownUp, ChevronsUpDown, Maximize2, Minus, Network, Plus } from "lucide-react";
import clsx from "clsx";
import { useApi } from "../lib/useApi";
import { pct } from "../lib/format";
import { duration, ease } from "../lib/motion";
import { useAuth } from "../auth/AuthContext";
import type { OrgNode as OrgNodeType } from "../types";
import { Avatar, Button, Card, EmptyState, ErrorState, HoverCard, IconButton, Label, PageHeader, RateBadge, RateBar, Skeleton } from "../components/ui";
import { usePersonModal } from "../components/PersonModal";

interface TreeState {
  collapsed: Set<string>;
  toggle: (email: string) => void;
  me: string | undefined;
}
const TreeCtx = createContext<TreeState | null>(null);

function countDescendants(n: OrgNodeType): number {
  return n.children.reduce((s, c) => s + 1 + countDescendants(c), 0);
}

function allManagers(n: OrgNodeType, out: string[] = []): string[] {
  if (n.children.length) out.push(n.email);
  n.children.forEach((c) => allManagers(c, out));
  return out;
}

function NodeCard({ node }: { node: OrgNodeType }) {
  const tree = useContext(TreeCtx)!;
  const openPerson = usePersonModal();
  const isMe = node.email === tree.me;
  const collapsed = tree.collapsed.has(node.email);
  const reports = node.children.length;

  return (
    <div className="relative z-[1] flex flex-col items-center">
      <HoverCard.Root>
        <HoverCard.Trigger asChild>
          <button
            type="button"
            onClick={() => openPerson(node.email)}
            className={clsx(
              "w-[220px] text-left bg-panel border rounded-lg shadow-xs p-3 flex flex-col items-stretch gap-2.5",
              "transition-[border-color,box-shadow] duration-100 hover:shadow-md",
              isMe ? "border-accent ring-1 ring-accent" : "border-line hover:border-line-strong"
            )}
          >
            <div className="w-full flex items-center gap-2.5 min-w-0">
              <Avatar name={node.name} size={32} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-sm font-semibold text-ink truncate">{node.name}</span>
                  {isMe && <Label size="sm" tone="accent">You</Label>}
                </div>
                <div className="text-xs text-ink2 truncate">{node.title}</div>
              </div>
            </div>
            <div className="w-full flex items-center gap-2">
              {node.required_total > 0 ? (
                <>
                  <div className="flex-1 min-w-0">
                    <RateBar rate={node.attendance_rate} width="100%" size="sm" />
                  </div>
                  <RateBadge rate={node.attendance_rate} />
                </>
              ) : (
                <span className="text-xs text-ink3">No required meetings</span>
              )}
            </div>
          </button>
        </HoverCard.Trigger>
        <HoverCard.Content side="right" align="start">
          <div className="flex items-center gap-3">
            <Avatar name={node.name} size={40} />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-ink truncate">{node.name}</div>
              <div className="text-xs text-ink2 truncate">{node.title}</div>
            </div>
          </div>
          <dl className="grid grid-cols-3 gap-2 mt-4 text-center">
            <div className="rounded-md bg-panel2 py-2">
              <dt className="text-[11px] text-ink2">Attendance</dt>
              <dd className="text-sm font-semibold text-ink tabular">{pct(node.attendance_rate)}</dd>
            </div>
            <div className="rounded-md bg-panel2 py-2">
              <dt className="text-[11px] text-ink2">Required</dt>
              <dd className="text-sm font-semibold text-ink tabular">{node.required_total}</dd>
            </div>
            <div className="rounded-md bg-panel2 py-2">
              <dt className="text-[11px] text-ink2">Org size</dt>
              <dd className="text-sm font-semibold text-ink tabular">{countDescendants(node)}</dd>
            </div>
          </dl>
          <p className="text-xs text-ink3 mt-3">Click the card for the full breakdown.</p>
        </HoverCard.Content>
      </HoverCard.Root>
      {reports > 0 && (
        <button
          type="button"
          onClick={() => tree.toggle(node.email)}
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Show" : "Hide"} ${reports} report${reports === 1 ? "" : "s"} of ${node.name}`}
          className="relative -mt-2.5 h-5 px-2 rounded-full border border-line bg-panel text-[11px] font-medium text-ink2 hover:text-ink hover:border-line-strong flex items-center gap-1 shadow-xs z-[2]"
        >
          {reports}
          <motion.span animate={{ rotate: collapsed ? -90 : 0 }} transition={{ duration: duration.base, ease: ease.standard }} className="flex">
            <ChevronDown size={12} />
          </motion.span>
        </button>
      )}
    </div>
  );
}

function OrgBranch({ node }: { node: OrgNodeType }) {
  const tree = useContext(TreeCtx)!;
  const open = node.children.length > 0 && !tree.collapsed.has(node.email);
  return (
    <li>
      <NodeCard node={node} />
      <AnimatePresence initial={false}>
        {open && (
          <motion.ul
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6, transition: { duration: duration.fast } }}
            transition={{ duration: duration.base, ease: ease.decelerate }}
          >
            {node.children.map((c) => (
              <OrgBranch key={c.email} node={c} />
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </li>
  );
}

const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5];

export function OrgChart() {
  const { me } = useAuth();
  const { data: tree, error, reload } = useApi<OrgNodeType>("/orgchart");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [zoomIdx, setZoomIdx] = useState(3);
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const toggle = useCallback((email: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(email) ? next.delete(email) : next.add(email);
      return next;
    });
  }, []);

  const ctx = useMemo(() => ({ collapsed, toggle, me: me?.email }), [collapsed, toggle, me?.email]);
  const managers = useMemo(() => (tree ? allManagers(tree) : []), [tree]);
  const zoom = ZOOMS[zoomIdx];

  // Centre the tree horizontally once it has rendered.
  useEffect(() => {
    const el = viewport.current;
    if (el && tree) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
  }, [tree]);

  const fit = () => {
    const el = viewport.current;
    const content = el?.querySelector(".org-tree") as HTMLElement | null;
    if (!el || !content) return;
    const natural = content.getBoundingClientRect().width / zoom;
    const target = (el.clientWidth - 80) / natural;
    let best = 0;
    ZOOMS.forEach((z, i) => {
      if (z <= target) best = i;
    });
    setZoomIdx(best);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button")) return;
    const el = viewport.current!;
    drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    setDragging(true);
    el.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const el = viewport.current!;
    el.scrollLeft = drag.current.left - (e.clientX - drag.current.x);
    el.scrollTop = drag.current.top - (e.clientY - drag.current.y);
  };
  const endDrag = () => {
    drag.current = null;
    setDragging(false);
  };

  return (
    <div>
      <PageHeader
        title="Org chart"
        description="Your reporting line. Hover anyone for a preview, click for their full attendance breakdown."
        actions={
          tree && managers.length > 0 && (
            <>
              <Button size="sm" leadingIcon={ChevronsUpDown} onClick={() => setCollapsed(new Set())}>Expand all</Button>
              <Button size="sm" leadingIcon={ChevronsDownUp} onClick={() => setCollapsed(new Set(managers.filter((m) => m !== tree.email)))}>Collapse all</Button>
            </>
          )
        }
      />

      <Card padding="none" className="overflow-hidden">
        <div className="flex items-center justify-between gap-2 px-3 h-11 border-b border-line bg-panel">
          <span className="text-[13px] text-ink2 flex items-center gap-2 pl-1">
            <Network size={15} className="text-ink3" aria-hidden />
            {tree ? `${countDescendants(tree) + 1} people` : "Loading…"}
          </span>
          <div className="flex items-center gap-1">
            <IconButton icon={Minus} label="Zoom out" size="sm" disabled={zoomIdx === 0} onClick={() => setZoomIdx((i) => Math.max(0, i - 1))} />
            <button type="button" onClick={() => setZoomIdx(3)} className="h-7 w-14 rounded-md text-xs font-medium text-ink2 hover:bg-panel2 tabular" aria-label="Reset zoom">
              {Math.round(zoom * 100)}%
            </button>
            <IconButton icon={Plus} label="Zoom in" size="sm" disabled={zoomIdx === ZOOMS.length - 1} onClick={() => setZoomIdx((i) => Math.min(ZOOMS.length - 1, i + 1))} />
            <span className="w-px h-5 bg-line mx-1" aria-hidden />
            <IconButton icon={Maximize2} label="Fit to screen" size="sm" onClick={fit} />
          </div>
        </div>

        <div
          ref={viewport}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          className={clsx("dot-grid bg-canvas overflow-auto h-[calc(100vh-280px)] min-h-[420px] select-none", dragging ? "cursor-grabbing" : "cursor-grab")}
        >
          {error && !tree ? (
            <ErrorState message={error.message} onRetry={reload} />
          ) : !tree ? (
            <div className="flex flex-col items-center gap-6 pt-12">
              <Skeleton className="h-[84px] w-[220px] !rounded-lg" />
              <div className="flex gap-5">
                <Skeleton className="h-[84px] w-[220px] !rounded-lg" />
                <Skeleton className="h-[84px] w-[220px] !rounded-lg" />
              </div>
            </div>
          ) : tree.children.length === 0 && !tree.email ? (
            <EmptyState icon={Network} title="No org data yet" />
          ) : (
            <div className="inline-block min-w-full p-10">
              <TreeCtx.Provider value={ctx}>
                <div style={{ zoom }}>
                  <ul className="org-tree">
                    <OrgBranch node={tree} />
                  </ul>
                </div>
              </TreeCtx.Provider>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
