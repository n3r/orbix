const BASE = "/api";

export async function apiFetch(path: string, init?: RequestInit) {
  const headers = init?.body
    ? { "content-type": "application/json", ...(init?.headers ?? {}) }
    : init?.headers;
  return fetch(`${BASE}${path}`, { ...init, credentials: "include", headers });
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code?: string,
    message?: string,
  ) {
    super(message ?? `HTTP ${status}`);
    this.name = "ApiError";
  }
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    let code: string | undefined;
    try {
      code = (await res.clone().json())?.error;
    } catch {
      /* non-JSON error body — leave code undefined */
    }
    throw new ApiError(res.status, code);
  }
  return (await res.json()) as T;
}
