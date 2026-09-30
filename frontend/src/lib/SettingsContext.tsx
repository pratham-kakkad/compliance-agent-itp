import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, UnauthorizedError } from "./api";
import { setDisplayTimeZone } from "./format";
import type { OrgSettings, OrgSettingsPatch, OrgSettingsUpdateResult, TimezoneList } from "../types";

/** Used when /settings can't be loaded: the data is stored in UTC, so UTC is the honest default. */
const FALLBACK: OrgSettings = {
  timezone: "UTC",
  timezone_offset: "+00:00",
  default_timezone: "UTC",
  updated_at: null,
  updated_by: null,
};

function sameSettings(a: OrgSettings, b: OrgSettings): boolean {
  return (
    a.timezone === b.timezone &&
    a.timezone_offset === b.timezone_offset &&
    a.default_timezone === b.default_timezone &&
    a.updated_at === b.updated_at &&
    a.updated_by === b.updated_by
  );
}

interface SettingsState {
  /** The organization's settings (FALLBACK until they load, or if they can't). */
  settings: OrgSettings;
  /** The zone every date and time is displayed in — settings.timezone, or UTC if this browser doesn't know it. */
  timezone: string;
  /** Why the last GET /settings failed, if it did. */
  error: Error | null;
  /** PUT /settings (partial update). Rejects with the server's detail message. */
  update: (patch: OrgSettingsPatch) => Promise<OrgSettingsUpdateResult>;
  /** Refetch GET /settings (e.g. to pick up a change made by someone else). */
  reload: () => Promise<void>;
}

const SettingsContext = createContext<SettingsState | null>(null);

/**
 * Loads the organization settings once the user is signed in and applies the
 * org time zone to every format helper before the app renders. Until the first
 * load settles it renders `fallback` (the boot splash). Consumers that show
 * dates key their content on `timezone` so a zone change remounts them and
 * everything refetches and reformats.
 */
export function SettingsProvider({ children, fallback = null }: { children: React.ReactNode; fallback?: React.ReactNode }) {
  const [settings, setSettings] = useState<OrgSettings | null>(null);
  const [timezone, setTimezone] = useState("UTC");
  const [error, setError] = useState<Error | null>(null);
  const loaded = useRef(false);

  const apply = useCallback((s: OrgSettings) => {
    // Module-level zone first, so the render these state updates trigger already formats in it.
    setTimezone(setDisplayTimeZone(s.timezone));
    // An identical reload keeps the same object, so consumers don't re-render for nothing.
    setSettings((prev) => (prev && sameSettings(prev, s) ? prev : s));
    loaded.current = true;
  }, []);

  const reload = useCallback(async () => {
    try {
      const s = await api.get<OrgSettings>("/settings");
      setError(null);
      apply(s);
    } catch (e) {
      if (e instanceof UnauthorizedError) return; // the auth layer takes over
      setError(e instanceof Error ? e : new Error(String(e)));
      // Keep whatever was loaded before; on the very first load fall back to UTC and still render.
      if (!loaded.current) apply(FALLBACK);
    }
  }, [apply]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const update = useCallback(
    async (patch: OrgSettingsPatch) => {
      const result = await api.put<OrgSettingsUpdateResult>("/settings", patch);
      const { changed: _changed, recomputed_days: _days, ...next } = result;
      setError(null);
      apply(next);
      return result;
    },
    [apply]
  );

  const value = useMemo<SettingsState | null>(
    () => (settings ? { settings, timezone, error, update, reload } : null),
    [settings, timezone, error, update, reload]
  );

  if (!value) return <>{fallback}</>;
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsState {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}

// --- Time zone list -----------------------------------------------------------
// GET /settings/timezones is static for the life of the server, so it's fetched
// once per page load and shared by every picker (Settings, Import).

let tzCache: TimezoneList | null = null;
let tzInflight: Promise<TimezoneList> | null = null;

function loadTimezones(): Promise<TimezoneList> {
  if (tzCache) return Promise.resolve(tzCache);
  if (!tzInflight) {
    tzInflight = api
      .get<TimezoneList>("/settings/timezones")
      .then((list) => {
        tzCache = list;
        return list;
      })
      .finally(() => {
        tzInflight = null;
      });
  }
  return tzInflight;
}

export function useTimezoneList(): { data: TimezoneList | null; error: Error | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<TimezoneList | null>(tzCache);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (tzCache) {
      setData(tzCache);
      return;
    }
    let live = true;
    setError(null);
    loadTimezones()
      .then((list) => {
        if (live) setData(list);
      })
      .catch((e: unknown) => {
        if (!live || e instanceof UnauthorizedError) return;
        setError(e instanceof Error ? e : new Error(String(e)));
      });
    return () => {
      live = false;
    };
  }, [tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading: !data && !error, reload };
}
