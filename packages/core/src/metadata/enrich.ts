import type { TmdbSearchResult, TmdbSearchCandidate, TmdbMovie, TmdbCredits, TmdbKeyword } from "./tmdb";
import type { ImageKind } from "./images";
import type { ExternalRatings } from "./omdb";
import { isRealTranslation } from "./localize";
import { buildQueryLadder } from "./search-title";
import {
  scoreCandidate,
  isAcceptable,
  titleSimilarity,
  acronymMatches,
  TITLE_STRONG,
  TITLE_WEAK,
} from "./match-score";

// ---------------------------------------------------------------------------
// Structural interface — real TmdbClient satisfies this.
// ---------------------------------------------------------------------------

export interface TmdbLike {
  /** Retained for compatibility; enrichItem now resolves via searchMovies. */
  searchMovie(title: string, year?: number): Promise<TmdbSearchResult | null>;
  searchMovies(query: string, year?: number, language?: string): Promise<TmdbSearchCandidate[]>;
  /** Every known title for a movie (display/original/alternative/translated). */
  allTitles(id: number): Promise<string[]>;
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

/** How many unaccepted candidates the deep-check phase may fetch titles for. */
const DEEP_CHECK_LIMIT = 3;

/**
 * Resolve a movie's TMDB id from a raw parsed title + optional year.
 *
 * Phase 1 — query ladder: cleaned title → drop year → parenthetical/script
 * variants → raw → first-3-tokens, scoring every candidate and accepting the
 * best that clears the gate. Short-circuits on a confident (rule-A) match,
 * keeping the common clean-title case at a single API call.
 *
 * Phase 2 — deep check: TMDB's search index matches alternative/translated
 * titles in ANY language, but returns only the display title — so a foreign
 * query can surface the right film yet fail the cheap string gate. For the
 * top-ranked unaccepted candidates, fetch every known title (alternative +
 * translated) and verify the query against them directly.
 */
export async function resolveTmdbId(
  title: string,
  year: number | undefined,
  client: Pick<TmdbLike, "searchMovies" | "allTitles">,
): Promise<number | undefined> {
  const ladder = buildQueryLadder({ title, year });
  let best: { tmdbId: number; rank: number; exactYear: boolean } | undefined;
  /** Candidates seen but not accepted — the deep-check pool, best rank kept. */
  const pool = new Map<number, { candidate: TmdbSearchCandidate; rank: number }>();

  for (const attempt of ladder) {
    const candidates = await client.searchMovies(attempt.query, attempt.year, attempt.language);
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]!;
      const rank = scoreCandidate(attempt.query, candidate, attempt.year ?? year);
      const exactYear = year != null && candidate.year != null && candidate.year === year;
      // Derived (truncated) attempts may only SURFACE candidates for the deep
      // check — an exact match against a lossy query proves nothing.
      if (!attempt.derived && isAcceptable(attempt.query, candidate, attempt.year, i === 0)) {
        // When the item has a year, year agreement dominates similarity: a
        // strong-sim wrong-year candidate (an unreleased reboot titled exactly
        // like the query) must not beat an exact-year acceptance.
        const better =
          !best ||
          (exactYear && !best.exactYear) ||
          (exactYear === best.exactYear && rank > best.rank);
        if (better) best = { tmdbId: candidate.tmdbId, rank, exactYear };
      } else {
        const prev = pool.get(candidate.tmdbId);
        if (!prev || rank > prev.rank) pool.set(candidate.tmdbId, { candidate, rank });
      }
    }
    // A confident, year-consistent match is as good as it gets — stop searching.
    if (best && best.rank >= TITLE_STRONG && (year == null || best.exactYear)) break;
  }
  if (best) return best.tmdbId;

  // ── Phase 2: deep check ────────────────────────────────────────────────────
  // Only FAITHFUL queries may verify a candidate — a derived (truncated) query
  // matching an alt title exactly proves nothing about the full title.
  const deepQueries = [...new Set(ladder.filter((a) => !a.derived).map((a) => a.query))];
  // Exact-year candidates are verified first: franchise alt-title data is often
  // polluted (a sequel carrying the opener's title), and the item's own year is
  // the strongest disambiguator we have.
  const top = [...pool.values()]
    .sort((a, b) => {
      const ay = year != null && a.candidate.year === year ? 1 : 0;
      const by = year != null && b.candidate.year === year ? 1 : 0;
      if (ay !== by) return by - ay;
      return b.rank - a.rank;
    })
    .slice(0, DEEP_CHECK_LIMIT);

  for (const { candidate } of top) {
    let titles: string[];
    try {
      titles = await client.allTitles(candidate.tmdbId);
    } catch {
      continue; // a failed titles fetch must not fail enrichment
    }
    const exactYear = year != null && candidate.year != null && candidate.year === year;
    for (const q of deepQueries) {
      for (const t of titles) {
        const sim = titleSimilarity(q, { title: t });
        if (sim >= TITLE_STRONG || (sim >= TITLE_WEAK && exactYear) || acronymMatches(q, t)) {
          return candidate.tmdbId;
        }
      }
    }
  }

  return undefined;
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
