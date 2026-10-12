/**
 * Calls for the signed-out screens (sign in, invite, reset, forgot password).
 * The shared `api` helper treats any 401 as "session expired" and throws away
 * the server's message; here a 401 on a wrong password is an ordinary error
 * with a readable message, so these go straight to fetch.
 */
export class AuthApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function readError(res: Response): Promise<AuthApiError> {
  const body = await res.json().catch(() => null);
  const detail = body?.detail;
  let message = res.statusText || `Request failed (${res.status})`;
  if (typeof detail === "string" && detail) message = detail;
  else if (Array.isArray(detail)) {
    const msgs = detail.map((d) => (d && typeof d === "object" && "msg" in d ? String(d.msg) : String(d)));
    if (msgs.length) message = msgs.join("; ");
  }
  return new AuthApiError(message, res.status);
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...init });
  } catch {
    throw new AuthApiError("Can't reach the server. Check your connection and try again.", 0);
  }
  if (!res.ok) throw await readError(res);
  return (await res.json()) as T;
}

export const authApi = {
  get: <T>(path: string) => call<T>(path),
  post: <T>(path: string, body: unknown) => call<T>(path, { method: "POST", body: JSON.stringify(body) }),
};

export const MIN_PASSWORD_LENGTH = 10;
