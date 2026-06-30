import { useQuery } from "@tanstack/react-query";
import { apiJson } from "./api";
import type { Library, MediaCard, Profile } from "./types";

export interface SetupStatus { complete: boolean }
export interface ActiveProfile {
  id: string | null; name: string | null; avatar: string | null;
  kind: string | null; maturityCap: number | null;
}

export function useSetupStatus() {
  return useQuery({ queryKey: ["setup-status"], queryFn: () => apiJson<SetupStatus>("/setup/status") });
}
export function useMyProfile() {
  return useQuery({ queryKey: ["me-profile"], queryFn: () => apiJson<ActiveProfile>("/me/profile") });
}
export function useLibraries() {
  return useQuery({ queryKey: ["libraries"], queryFn: () => apiJson<Library[]>("/libraries") });
}
export function useProfiles() {
  return useQuery({ queryKey: ["profiles"], queryFn: () => apiJson<Profile[]>("/profiles") });
}

export interface HomeRow { key: string; title: string; items: MediaCard[] }
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

export function useSearch(q: string) {
  return useQuery({
    queryKey: ["search", q],
    enabled: q.trim().length > 0,
    queryFn: () => apiJson<MediaCard[]>(`/search?q=${encodeURIComponent(q.trim())}`),
  });
}
