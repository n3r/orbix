import type { TmdbSearchResult, TmdbSearchCandidate, TmdbMovie, TmdbCredits, TmdbKeyword } from "./tmdb";
import type { ImageKind } from "./images";
import type { ExternalRatings } from "./omdb";
import { isRealTranslation } from "./localize";
import { buildQueryLadder } from "./search-title";
import { scoreCandidate, isAcceptable, TITLE_STRONG } from "./match-score";

// ---------------------------------------------------------------------------
// Structural interface — real TmdbClient satisfies this.
// ---------------------------------------------------------------------------

export interface TmdbLike {
  /** Retained for compatibility; enrichItem now resolves via searchMovies. */
  searchMovie(title: string, year?: number): Promise<TmdbSearchResult | null>;
  searchMovies(query: string, year?: number): Promise<TmdbSearchCandidate[]>;
  movie(id: number): Promise<TmdbMovie>;
  credits(id: number): Promise<TmdbCredits>;
  keywords(id: number): Promise<TmdbKeyword[]>;
  releaseCertification(id: number): Promise<string | undefined>;
}

// ---------------------------------------------------------------------------
// I/O shapes
// ---------------------------------------------------------------------------

export interface MetadataTranslation {
  language: string;
  title: string;
  overview?: string;
}

export interface SaveMetadataInput {
  itemId: string;
  tmdbId: number;
  title: string;
  year?: number;
  overview?: string;
  tagline?: string;
  runtimeSec?: number;
  posterPath?: string;
  backdropPath?: string;
  logoPath?: string;
  imdbId?: string;
  tmdbScore?: number;
  imdbRating?: number;
  imdbVotes?: number;
  rtRating?: number;
  metacritic?: number;
  genres: { tmdbId: number; name: string }[];
  cast: { tmdbId: number; name: string; character?: string; order: number }[];
  director?: { tmdbId: number; name: string };
  keywords: { tmdbId: number; name: string }[];
  rating?: string;
  /** Per-language localized title/overview for the active content languages. */
  translations?: MetadataTranslation[];
}

/** Minimal client surface needed to fetch a localized movie record. */
export type TranslateClient = Pick<TmdbLike, "movie">;

export interface EnrichResult {
  matched: boolean;
  tmdbId?: number;
  tvdbId?: number;
}

// ---------------------------------------------------------------------------
// enrichItem
// ---------------------------------------------------------------------------

/**
 * Resolve a movie's TMDB id from a raw parsed title + optional year.
 *
 * Runs the query ladder (cleaned title → drop year → raw → first-3-tokens),
 * scores every candidate against the query, and returns the best one that
 * clears the acceptance gate. Short-circuits as soon as a confident (rule-A)
 * match appears, keeping the common clean-title case at a single API call.
 */
async function resolveTmdbId(
  title: string,
  year: number | undefined,
  client: Pick<TmdbLike, "searchMovies">,
): Promise<number | undefined> {
  const ladder = buildQueryLadder({ title, year });
  let best: { tmdbId: number; rank: number } | undefined;

  for (const attempt of ladder) {
    const candidates = await client.searchMovies(attempt.query, attempt.year);
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]!;
      if (!isAcceptable(attempt.query, candidate, attempt.year, i === 0, attempt.yearFiltered)) {
        continue;
      }
      const rank = scoreCandidate(attempt.query, candidate, attempt.year);
      if (!best || rank > best.rank) best = { tmdbId: candidate.tmdbId, rank };
    }
    // A confident string match is as good as it gets — stop searching.
    if (best && best.rank >= TITLE_STRONG) break;
  }

  return best?.tmdbId;
}

export async function enrichItem(
  item: { id: string; title: string; year?: number; tmdbId?: number },
  deps: {
    client: TmdbLike;
    cacheImage: (tmdbPath: string, kind: ImageKind) => Promise<string>;
    saveMetadata: (input: SaveMetadataInput) => Promise<void>;
    /** Per-language clients used to fetch localized title/overview. */
    translateClients?: Map<string, TranslateClient>;
    /** Resolve + cache a hero logo (fanart.tv → TMDB); returns a metadata-relative path. */
    resolveLogo?: (input: { tmdbId: number; imdbId?: string }) => Promise<string | undefined>;
    /** Fetch external ratings (OMDb) for an IMDb id. */
    fetchRatings?: (imdbId: string) => Promise<ExternalRatings | undefined>;
  },
): Promise<EnrichResult> {
  // Step 1: resolve tmdbId — embedded id wins; otherwise clean the parsed title,
  // walk a query ladder, and accept the best-scored candidate (Plex-style).
  const tmdbId = item.tmdbId ?? (await resolveTmdbId(item.title, item.year, deps.client));

  if (!tmdbId) {
    return { matched: false };
  }

  // Step 2: fetch details in parallel
  const [movie, credits, keywords] = await Promise.all([
    deps.client.movie(tmdbId),
    deps.client.credits(tmdbId),
    deps.client.keywords(tmdbId),
  ]);

  // Step 2b: fetch US content rating — tolerate failures gracefully
  let rating: string | undefined;
  try {
    rating = await deps.client.releaseCertification(tmdbId);
  } catch {
    // Missing certification must NOT fail enrichment
    rating = undefined;
  }

  // Step 3: cache images
  const posterPath = movie.posterPath
    ? await deps.cacheImage(movie.posterPath, "poster")
    : undefined;
  const backdropPath = movie.backdropPath
    ? await deps.cacheImage(movie.backdropPath, "backdrop")
    : undefined;

  // Step 3b: hero logo art (optional dep) — never fail enrichment on its account
  let logoPath: string | undefined;
  if (deps.resolveLogo) {
    try {
      logoPath = await deps.resolveLogo({ tmdbId, imdbId: movie.imdbId });
    } catch {
      logoPath = undefined;
    }
  }

  // Step 3c: external ratings (OMDb, optional dep) — tolerate failures
  let extraRatings: ExternalRatings | undefined;
  if (deps.fetchRatings && movie.imdbId) {
    try {
      extraRatings = await deps.fetchRatings(movie.imdbId);
    } catch {
      extraRatings = undefined;
    }
  }

  // Step 4: extract cast (top 15, sorted by order asc) and director
  const cast = [...credits.cast]
    .sort((a, b) => a.order - b.order)
    .slice(0, 15);

  const directorRaw = credits.crew.find((c) => c.job === "Director");
  const director = directorRaw
    ? { tmdbId: directorRaw.tmdbId, name: directorRaw.name }
    : undefined;

  // Step 4b: fetch localized title/overview for each active content language.
  // A per-language failure must NOT fail enrichment — skip that language.
  const translations: MetadataTranslation[] = [];
  if (deps.translateClients) {
    for (const [language, client] of deps.translateClients) {
      try {
        const localized = await client.movie(tmdbId);
        // TMDB backfills title/overview with the ORIGINAL language when the
        // requested language has no translation; skip those so we don't store a
        // wrong-language title (the catalog then falls back to the base title).
        if (!isRealTranslation(language, localized)) continue;
        translations.push({
          language,
          title: localized.title,
          ...(localized.overview != null ? { overview: localized.overview } : {}),
        });
      } catch {
        // localized fetch failed — fall back to base for this language
      }
    }
  }

  // Step 5: persist
  await deps.saveMetadata({
    itemId: item.id,
    tmdbId,
    title: movie.title,
    year: movie.year,
    overview: movie.overview,
    tagline: movie.tagline,
    runtimeSec: movie.runtimeSec,
    posterPath,
    backdropPath,
    logoPath,
    imdbId: movie.imdbId,
    tmdbScore: movie.tmdbScore,
    imdbRating: extraRatings?.imdbRating,
    imdbVotes: extraRatings?.imdbVotes,
    rtRating: extraRatings?.rtRating,
    metacritic: extraRatings?.metacritic,
    genres: movie.genres,
    cast,
    director,
    keywords: keywords.map((k) => ({ tmdbId: k.tmdbId, name: k.name })),
    rating,
    translations,
  });

  return { matched: true, tmdbId };
}
