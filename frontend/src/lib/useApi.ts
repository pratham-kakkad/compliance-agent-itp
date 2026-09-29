import { useCallback, useEffect, useRef, useState } from "react";
import { api, UnauthorizedError } from "./api";

export interface ApiState<T> {
  data: T | null;
  error: Error | null;
  /** True while any request is in flight (including refetches). */
  loading: boolean;
  /** True only before the first successful response. */
  initialLoading: boolean;
  reload: () => void;
}

/**
 * GET `path` and track data/error/loading. Each request gets its own
 * AbortController so a fast-changing path (search-as-you-type) never shows a
 * stale response. Previous data is kept while refetching. `path = null` skips.
 */
export function useApi<T>(path: string | null): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [tick, setTick] = useState(0);
  const hasData = useRef(false);

  useEffect(() => {
    if (path === null) {
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    api
      .get<T>(path, ctrl.signal)
      .then((d) => {
        if (ctrl.signal.aborted) return;
        hasData.current = true;
        setData(d);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
        if (e instanceof UnauthorizedError) return; // the auth layer takes over
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      });
    return () => ctrl.abort();
  }, [path, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  return { data, error, loading, initialLoading: loading && !hasData.current && !error, reload };
}
