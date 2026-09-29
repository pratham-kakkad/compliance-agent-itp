import { progress } from "./progress";

export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
  }
}

function handleUnauthorized(path: string): never {
  // The login screen probes /auth/me on boot — that 401 is expected, not a session expiry.
  if (path !== "/auth/me") window.dispatchEvent(new Event("mc:unauthorized"));
  throw new UnauthorizedError();
}

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  return progress.track(
    (async () => {
      const res = await fetch(path, {
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        ...opts,
      });
      if (res.status === 401) handleUnauthorized(path);
      if (!res.ok) {
        const body = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(body.detail || res.statusText);
      }
      return res.status === 204 ? (null as T) : ((await res.json()) as T);
    })()
  );
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body !== undefined ? JSON.stringify(body) : undefined }),
};

/**
 * Multipart file upload (e.g. the attendance punch-log import). `request`
 * always sets Content-Type: application/json, which breaks multipart bodies,
 * so this goes around it with a plain fetch + FormData.
 */
export async function uploadFile<T>(path: string, file: File, fieldName = "file"): Promise<T> {
  const form = new FormData();
  form.append(fieldName, file);
  return progress.track(
    (async () => {
      const res = await fetch(path, { method: "POST", credentials: "include", body: form });
      if (res.status === 401) handleUnauthorized(path);
      if (!res.ok) {
        const body = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(body.detail || res.statusText);
      }
      return res.status === 204 ? (null as T) : ((await res.json()) as T);
    })()
  );
}
