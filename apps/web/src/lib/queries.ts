import { useQuery } from "@tanstack/react-query";
import { apiJson, apiFetch, ApiError } from "./api";
import type { AuthMe, HomeRow, MediaCard, MenuConfig, MenuItem, Profile } from "./types";

export interface SetupStatus { complete: boolean }
export interface ActiveProfile {
  id: string | null; name: string | null; avatar: string | null;
  kind: string | null; maturityCap: number | null; language?: string | null;
}

export function useSetupStatus() {
  return useQuery({ queryKey: ["setup-status"], queryFn: () => apiJson<SetupStatus>("/setup/status") });
}
export function useMyProfile() {
  return useQuery({ queryKey: ["me-profile"], queryFn: () => apiJson<ActiveProfile>("/me/profile") });
}
export function useProfiles() {
  return useQuery({ queryKey: ["profiles"], queryFn: () => apiJson<Profile[]>("/profiles") });
}

export function useHomeRows() {
  return useQuery({ queryKey: ["home-rows"], queryFn: () => apiJson<{ rows: HomeRow[] }>("/home/rows") });
}

export function useSectionItems(sectionId: string | undefined, sort: string, q: string) {
  return useQuery({
    queryKey: ["section-items", sectionId, sort, q],
    enabled: !!sectionId,
    queryFn: () => {
      const qs = new URLSearchParams({ sort });
      if (q) qs.set("q", q);
      return apiJson<MediaCard[]>(`/sections/${sectionId}/items?${qs}`);
    },
  });
}

export interface SearchResponse { items: MediaCard[]; usedEmbeddings: boolean }
export function useSearch(q: string) {
  return useQuery({
    queryKey: ["search", q],
    enabled: q.trim().length > 0,
    queryFn: () => apiJson<SearchResponse>(`/search?q=${encodeURIComponent(q.trim())}`),
  });
}

export function useMenu() {
  return useQuery({ queryKey: ["menu"], queryFn: () => apiJson<{ items: MenuItem[] }>("/me/menu") });
}
export function useMenuConfig() {
  return useQuery({ queryKey: ["menu-config"], queryFn: () => apiJson<MenuConfig>("/me/menu/config") });
}
export function useAuthMe() {
  return useQuery({ queryKey: ["auth-me"], queryFn: () => apiJson<AuthMe>("/auth/me") });
}

/** Replace the active profile's menu; returns the resolved menu. */
export async function saveMenu(sectionIds: string[]): Promise<{ items: MenuItem[] }> {
  const res = await apiFetch("/me/menu", { method: "PUT", body: JSON.stringify({ sectionIds }) });
  if (!res.ok) throw new ApiError(res.status);
  return (await res.json()) as { items: MenuItem[] };
}
