import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { Me, Meta } from "./compliance";

interface ComplianceState {
  /** Who you are and what you may do. Null until it has loaded (or if it couldn't). */
  me: Me | null;
  /** Vocabulary the forms need (types, statuses, scopes, escalation presets, ...). */
  meta: Meta | null;
  ready: boolean;
  error: Error | null;
  /** Whether you hold `action` on `resource` (any scope). Super admins hold everything. */
  can: (resource: string, action: string) => boolean;
  /** True if you hold at least one of the given [resource, action] pairs. */
  canAny: (pairs: [string, string][]) => boolean;
  unread: number;
  /** Re-read /compliance/me (permissions + unread count), e.g. after changing roles. */
  reload: () => Promise<void>;
}

const Ctx = createContext<ComplianceState | null>(null);

/**
 * Loads the signed-in person's compliance permissions and the shared vocabulary once, then keeps the
 * unread-notification count fresh. Permissions only drive what the UI shows: the server checks every request.
 */
export function ComplianceProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [ready, setReady] = useState(false);

  const reload = useCallback(async () => {
    try {
      setMe(await api.get<Me>("/compliance/me"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      await reload();
      try {
        const m = await api.get<Meta>("/compliance/meta");
        if (alive) setMeta(m);
      } catch {
        /* forms show their own error if they need it */
      }
      if (alive) setReady(true);
    })();
    const timer = window.setInterval(() => void reload(), 60_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [reload]);

  const value = useMemo<ComplianceState>(() => {
    const can = (resource: string, action: string) => Boolean(me?.permissions[resource]?.[action]);
    return {
      me,
      meta,
      ready,
      error,
      can,
      canAny: (pairs) => pairs.some(([r, a]) => can(r, a)),
      unread: me?.unread_notifications ?? 0,
      reload,
    };
  }, [me, meta, ready, error, reload]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCompliance(): ComplianceState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useCompliance must be used within ComplianceProvider");
  return v;
}
