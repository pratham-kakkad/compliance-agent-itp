import { useCallback, useMemo } from "react";
import { useApi } from "../../../lib/useApi";
import type { Lookup } from "../../../lib/compliance";

/** People, teams, departments and roles for pickers (GET /compliance/lookup), plus name helpers. */
export function useLookup() {
  const { data, error, loading, reload } = useApi<Lookup>("/compliance/lookup");
  const names = useMemo(() => new Map((data?.users ?? []).map((u) => [u.email, u.name])), [data]);
  /** A person's name, or their e-mail when they aren't in the list. */
  const nameOf = useCallback((email: string) => names.get(email) ?? email, [names]);
  return { lookup: data, error, loading, reload, nameOf };
}
