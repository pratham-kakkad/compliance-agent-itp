import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, UnauthorizedError } from "../lib/api";
import type { AuthConfig, DirectoryEntry, Me } from "../types";

interface AuthState {
  loading: boolean;
  me: Me | null;
  config: AuthConfig | null;
  directory: DirectoryEntry[];
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  displayName: (email: string) => string;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<Me | null>(null);
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [directory, setDirectory] = useState<DirectoryEntry[]>([]);

  const refresh = useCallback(async () => {
    setLoading(true);
    const cfg = await api
      .get<AuthConfig>("/auth/config")
      .catch(() => ({ demo_login_enabled: false, microsoft_configured: false } as AuthConfig));
    setConfig(cfg);
    try {
      const user = await api.get<Me>("/auth/me");
      const dir = await api.get<DirectoryEntry[]>("/directory/users").catch(() => []);
      setMe(user);
      setDirectory(dir);
    } catch (e) {
      if (!(e instanceof UnauthorizedError)) throw e;
      setMe(null);
      setDirectory([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Any 401 after boot means the session expired: drop back to the login screen.
  useEffect(() => {
    const onUnauthorized = () => {
      setMe(null);
      setDirectory([]);
    };
    window.addEventListener("mc:unauthorized", onUnauthorized);
    return () => window.removeEventListener("mc:unauthorized", onUnauthorized);
  }, []);

  const logout = useCallback(async () => {
    await api.post("/auth/logout");
    setMe(null);
  }, []);

  const displayName = useCallback(
    (email: string) => directory.find((d) => d.email === email)?.name ?? email,
    [directory]
  );

  const value = useMemo(
    () => ({ loading, me, config, directory, refresh, logout, displayName }),
    [loading, me, config, directory, refresh, logout, displayName]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
