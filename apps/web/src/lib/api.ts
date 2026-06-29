const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:1061";

export async function apiFetch(path: string, init?: RequestInit) {
  return fetch(`${BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}
