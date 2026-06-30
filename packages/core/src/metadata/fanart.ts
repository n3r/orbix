// fanart.tv logo art adapter. fanart.tv serves transparent PNG "HD movie logo"
// title treatments keyed by TMDB or IMDb id. Pure picker (`pickFanartLogoUrl`)
// + a thin injected-fetch wrapper (`fetchFanartLogoUrl`).

export interface RawFanartImage {
  url: string;
  lang?: string;
  likes?: string;
}

export interface RawFanartMovie {
  hdmovielogo?: RawFanartImage[];
  movielogo?: RawFanartImage[];
}

/**
 * Choose the best logo URL from a fanart.tv movie response. Preference: HD
 * logos over SD, requested language (by likes desc) → English → most-liked any.
 * Pure — unit-tested without the network.
 */
export function pickFanartLogoUrl(raw: RawFanartMovie, lang = "en"): string | undefined {
  const pool = [...(raw.hdmovielogo ?? []), ...(raw.movielogo ?? [])];
  if (pool.length === 0) return undefined;
  const likes = (i: RawFanartImage) => Number.parseInt(i.likes ?? "0", 10) || 0;
  const byLikes = (a: RawFanartImage, b: RawFanartImage) => likes(b) - likes(a);

  const inLang = pool.filter((i) => i.lang === lang).sort(byLikes);
  if (inLang[0]) return inLang[0].url;
  const english = pool.filter((i) => i.lang === "en").sort(byLikes);
  if (english[0]) return english[0].url;
  return [...pool].sort(byLikes)[0]?.url;
}

/**
 * Fetch the best fanart.tv movie logo URL by TMDB or IMDb id. Returns undefined
 * when unconfigured, the request fails, or no logo exists.
 */
export async function fetchFanartLogoUrl(
  id: { tmdbId?: number; imdbId?: string },
  deps: { fetchImpl: typeof fetch; apiKey: string; lang?: string },
): Promise<string | undefined> {
  const key = id.tmdbId != null ? String(id.tmdbId) : id.imdbId;
  if (!deps.apiKey || !key) return undefined;
  const url = `https://webservice.fanart.tv/v3/movies/${encodeURIComponent(key)}?api_key=${encodeURIComponent(deps.apiKey)}`;
  const res = await deps.fetchImpl(url);
  if (!res.ok) return undefined;
  const raw = (await res.json()) as RawFanartMovie;
  return pickFanartLogoUrl(raw, deps.lang ?? "en");
}
