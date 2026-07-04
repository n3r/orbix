import { useQuery, useInfiniteQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { apiJson, apiFetch, ApiError } from "./api";
import type {
  AuthMe, HomeRow, MediaCard, MenuConfig, MenuItem, Profile, TitleDetail,
  TvChannelCard, TvGridResponse, TvGuideResponse, TvHome, TvProgramme,
} from "./types";

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

export function useLibraryItems(libraryId: string | undefined, sort: string, q: string) {
  return useQuery({
    queryKey: ["library-items", libraryId, sort, q],
    enabled: !!libraryId,
    queryFn: () => {
      const qs = new URLSearchParams({ sort });
      if (q) qs.set("q", q);
      return apiJson<MediaCard[]>(`/libraries/${libraryId}/items?${qs}`);
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
export async function saveMenu(libraryIds: string[]): Promise<{ items: MenuItem[] }> {
  const res = await apiFetch("/me/menu", { method: "PUT", body: JSON.stringify({ libraryIds }) });
  if (!res.ok) throw new ApiError(res.status);
  return (await res.json()) as { items: MenuItem[] };
}

/** Shared query descriptor for a title's full detail; reusable for prefetching. */
export function itemDetailOptions(id: string) {
  return { queryKey: ["item", id] as const, queryFn: () => apiJson<TitleDetail>(`/items/${id}`) };
}

/** Full title detail; shared cache key ["item", id] (used by the home billboard). */
export function useItemDetail(id: string | undefined) {
  return useQuery({ ...itemDetailOptions(id ?? ""), enabled: !!id });
}

/** The active profile's wishlist as poster cards, newest-first. */
export function useWishlist() {
  return useQuery({ queryKey: ["wishlist", "items"], queryFn: () => apiJson<MediaCard[]>("/wishlist") });
}

/** Wishlist membership ids — drives the title-page toggle. */
export function useWishlistIds() {
  return useQuery({ queryKey: ["wishlist", "ids"], queryFn: () => apiJson<{ ids: string[] }>("/wishlist/ids") });
}

/** Add/remove a title, updating the ids cache optimistically. */
export function useToggleWishlist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ itemId, add }: { itemId: string; add: boolean }) => {
      const res = await apiFetch(`/wishlist/${itemId}`, { method: add ? "POST" : "DELETE" });
      if (!res.ok) throw new ApiError(res.status);
    },
    onMutate: async ({ itemId, add }) => {
      await qc.cancelQueries({ queryKey: ["wishlist"] });
      const prev = qc.getQueryData<{ ids: string[] }>(["wishlist", "ids"]);
      if (prev) {
        qc.setQueryData(["wishlist", "ids"], {
          ids: add ? [...new Set([...prev.ids, itemId])] : prev.ids.filter((x) => x !== itemId),
        });
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["wishlist", "ids"], ctx.prev);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["wishlist"] });
    },
  });
}

/* ── TV — live channels ────────────────────────────────────────────────── */

export function useTvHome() {
  return useQuery({ queryKey: ["tv-home"], queryFn: () => apiJson<TvHome>("/tv/home") });
}

export interface TvGuideParams {
  country?: string;
  category?: string;
  favorites?: boolean;
  q?: string;
  limit?: number;
}

/** Windowed guide list: pages of `limit` (default 100) via offset paging. */
export function useTvGuide(params: TvGuideParams) {
  const limit = params.limit ?? 100;
  return useInfiniteQuery({
    queryKey: ["tv-guide", { ...params, limit }],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams();
      if (params.country) qs.set("country", params.country);
      if (params.category) qs.set("category", params.category);
      if (params.favorites) qs.set("favorites", "1");
      if (params.q) qs.set("q", params.q);
      qs.set("offset", String(pageParam));
      qs.set("limit", String(limit));
      return apiJson<TvGuideResponse>(`/tv/guide?${qs}`);
    },
    getNextPageParam: (last: TvGuideResponse, all: TvGuideResponse[]) => {
      const loaded = all.reduce((n, p) => n + p.channels.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });
}

export interface TvGridParams {
  start?: string;
  hours?: number;
  country?: string;
  category?: string;
  favorites?: boolean;
  q?: string;
  offset?: number;
  limit?: number;
}

/** Windowed time×channel grid page: each visible channel's programmes over [start, start+hours). */
export function useTvGrid(params: TvGridParams) {
  return useQuery({
    queryKey: ["tv-grid", params],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (params.start) qs.set("start", params.start);
      if (params.hours) qs.set("hours", String(params.hours));
      if (params.country) qs.set("country", params.country);
      if (params.category) qs.set("category", params.category);
      if (params.favorites) qs.set("favorites", "1");
      if (params.q) qs.set("q", params.q);
      if (params.offset) qs.set("offset", String(params.offset));
      if (params.limit) qs.set("limit", String(params.limit));
      return apiJson<TvGridResponse>(`/tv/grid?${qs}`);
    },
  });
}

export function useTvChannel(id: string | undefined) {
  return useQuery({
    queryKey: ["tv-channel", id],
    enabled: !!id,
    queryFn: () => apiJson<TvChannelCard>(`/tv/channels/${id}`),
  });
}

export function useTvFavorites() {
  return useQuery({
    queryKey: ["tv-favorites"],
    queryFn: async () => (await apiJson<{ favorites: TvChannelCard[] }>("/tv/favorites")).favorites,
  });
}

/**
 * Toggle a channel's favorite flag. Shared by ChannelCard and TvChannelPage
 * so the two stay in lockstep on which views need refreshing. On success,
 * invalidates every TV query whose payload embeds `favorite`. Errors (e.g. a
 * network hiccup) are left for the caller to swallow — no user-facing error
 * UI, matching the prior inline behavior.
 */
export function useToggleTvFavorite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ channelId, isFavorite }: { channelId: string; isFavorite: boolean }) =>
      apiFetch(`/tv/favorites/${channelId}`, { method: isFavorite ? "DELETE" : "PUT" }),
    onSuccess: (_res, { channelId }) => {
      void qc.invalidateQueries({ queryKey: ["tv-home"] });
      void qc.invalidateQueries({ queryKey: ["tv-guide"] });
      void qc.invalidateQueries({ queryKey: ["tv-favorites"] });
      void qc.invalidateQueries({ queryKey: ["tv-channel", channelId] });
    },
  });
}

/**
 * Day schedule for the channel page. `day` is a local "YYYY-MM-DD" (see
 * `tvDayString` in `@/lib/tv-time`) — omit for the API's default (today).
 * Keeps the previous day's data visible while a new day loads (Today/Tomorrow
 * tab switches don't flash to the empty state).
 */
export function useTvProgrammes(id: string | undefined, day?: string) {
  return useQuery({
    queryKey: ["tv-programmes", id, day],
    enabled: !!id,
    placeholderData: keepPreviousData,
    queryFn: () =>
      apiJson<{ programmes: TvProgramme[] }>(`/tv/channels/${id}/programmes${day ? `?day=${day}` : ""}`),
  });
}
