import type { TmdbSearchResult, TmdbMovie, TmdbCredits, TmdbKeyword } from "./tmdb";
import type { ImageKind } from "./images";

// ---------------------------------------------------------------------------
// Structural interface — real TmdbClient satisfies this.
// ---------------------------------------------------------------------------

export interface TmdbLike {
  searchMovie(title: string, year?: number): Promise<TmdbSearchResult | null>;
  movie(id: number): Promise<TmdbMovie>;
  credits(id: number): Promise<TmdbCredits>;
  keywords(id: number): Promise<TmdbKeyword[]>;
  releaseCertification(id: number): Promise<string | undefined>;
}

// ---------------------------------------------------------------------------
// I/O shapes
// ---------------------------------------------------------------------------

export interface SaveMetadataInput {
  itemId: string;
  tmdbId: number;
  title: string;
  year?: number;
  overview?: string;
  runtimeSec?: number;
  posterPath?: string;
  backdropPath?: string;
  imdbId?: string;
  genres: { tmdbId: number; name: string }[];
  cast: { tmdbId: number; name: string; character?: string; order: number }[];
  director?: { tmdbId: number; name: string };
  keywords: { tmdbId: number; name: string }[];
  rating?: string;
}

export interface EnrichResult {
  matched: boolean;
  tmdbId?: number;
}

// ---------------------------------------------------------------------------
// enrichItem
// ---------------------------------------------------------------------------

export async function enrichItem(
  item: { id: string; title: string; year?: number; tmdbId?: number },
  deps: {
    client: TmdbLike;
    cacheImage: (tmdbPath: string, kind: ImageKind) => Promise<string>;
    saveMetadata: (input: SaveMetadataInput) => Promise<void>;
  },
): Promise<EnrichResult> {
  // Step 1: resolve tmdbId
  const tmdbId =
    item.tmdbId ?? (await deps.client.searchMovie(item.title, item.year))?.tmdbId;

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

  // Step 4: extract cast (top 15, sorted by order asc) and director
  const cast = [...credits.cast]
    .sort((a, b) => a.order - b.order)
    .slice(0, 15);

  const directorRaw = credits.crew.find((c) => c.job === "Director");
  const director = directorRaw
    ? { tmdbId: directorRaw.tmdbId, name: directorRaw.name }
    : undefined;

  // Step 5: persist
  await deps.saveMetadata({
    itemId: item.id,
    tmdbId,
    title: movie.title,
    year: movie.year,
    overview: movie.overview,
    runtimeSec: movie.runtimeSec,
    posterPath,
    backdropPath,
    imdbId: movie.imdbId,
    genres: movie.genres,
    cast,
    director,
    keywords: keywords.map((k) => ({ tmdbId: k.tmdbId, name: k.name })),
    rating,
  });

  return { matched: true, tmdbId };
}
