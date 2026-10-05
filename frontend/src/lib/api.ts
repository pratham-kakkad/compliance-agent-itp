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

/**
 * The server's error text. FastAPI sends {detail: "…"} for HTTPException and
 * {detail: [{msg, loc, …}]} for request-validation errors.
 */
async function errorFrom(res: Response): Promise<Error> {
  const body = await res.json().catch(() => ({ detail: res.statusText }));
  const detail = body?.detail;
  if (Array.isArray(detail)) {
    const msgs = detail.map((d) => (d && typeof d === "object" && "msg" in d ? String(d.msg) : String(d))).filter(Boolean);
    return new Error(msgs.join("; ") || res.statusText);
  }
  return new Error((typeof detail === "string" && detail) || res.statusText || `Request failed (${res.status})`);
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
      if (!res.ok) throw await errorFrom(res);
      return res.status === 204 ? (null as T) : ((await res.json()) as T);
    })()
  );
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body !== undefined ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body: body !== undefined ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: body !== undefined ? JSON.stringify(body) : undefined }),
  delete: <T = null>(path: string) => request<T>(path, { method: "DELETE" }),
};

/**
 * Multipart file upload (e.g. the attendance punch-log import). `request`
 * always sets Content-Type: application/json, which breaks multipart bodies,
 * so this goes around it with a plain fetch + FormData.
 *
 * `fields` adds extra form fields next to the file (e.g. {timezone: "Asia/Kolkata"});
 * null, undefined and empty values are left out.
 */
export async function uploadFile<T>(
  path: string,
  file: File,
  fieldName = "file",
  fields: Record<string, string | null | undefined> = {}
): Promise<T> {
  const form = new FormData();
  form.append(fieldName, file);
  for (const [name, value] of Object.entries(fields)) {
    if (value != null && value !== "") form.append(name, value);
  }
  return progress.track(
    (async () => {
      const res = await fetch(path, { method: "POST", credentials: "include", body: form });
      if (res.status === 401) handleUnauthorized(path);
      if (!res.ok) throw await errorFrom(res);
      return res.status === 204 ? (null as T) : ((await res.json()) as T);
    })()
  );
}
