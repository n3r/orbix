const BASE = "/api";

export async function apiFetch(path: string, init?: RequestInit) {
  const headers = init?.body
    ? { "content-type": "application/json", ...(init?.headers ?? {}) }
    : init?.headers;
  return fetch(`${BASE}${path}`, { ...init, credentials: "include", headers });
}
