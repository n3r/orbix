// Shared response/view types used across the web app.
// These mirror the API response shapes (apps/api) and dedupe the per-file
// interface redefinitions that had accumulated across pages/components.

export interface Source {
  id: string;
  libraryId: string;
  kind: "local" | "smb";
  path: string | null;
  smbHost?: string | null;
  smbShare?: string | null;
  smbSubpath?: string | null;
  smbUsername?: string | null;
  smbDomain?: string | null;
  enabled: boolean;
  status: string;
  statusMessage: string | null;
  lastScanAt: string | null;
}

export interface Library {
  id: string;
  name: string;
  order: number;
  createdAt: string;
  sources: Source[];
}

export interface Profile {
  id: string;
  name: string;
  avatar: string | null;
  kind: string;
  maturityCap: number | null;
}

/** Minimal item shape for poster cards (home rows, library grid, search). */
export interface MediaCard {
  id: string;
  title: string;
  year?: number | null;
  posterPath: string | null;
  matchState?: string;
}

/** One labelled row on the home screen (smart rows, continue watching, etc.). */
export interface HomeRow {
  key: string;
  title: string;
  items: MediaCard[];
}

/** Ratings shown on the title hero. All optional — render only what's present. */
export interface Ratings {
  imdbRating?: number | null;
  imdbVotes?: number | null;
  rtRating?: number | null;
  metacritic?: number | null;
  tmdbScore?: number | null;
}

/** Lightweight season summary for the season selector (series only). */
export interface SeasonSummary {
  seasonNumber: number;
  name: string | null;
  episodeCount: number;
  posterPath: string | null;
}

/** One episode in a season's episode list. */
export interface EpisodeCard {
  id: string;
  episodeNumber: number;
  title: string | null;
  overview: string | null;
  stillPath: string | null;
  runtimeSec: number | null;
  airDate: string | null;
  fileId: string | null;
  progress: { positionSec: number; durationSec: number; finished: boolean } | null;
}

export interface TitleFile {
  id: string;
  path: string;
  container: string | null;
  videoCodec: string | null;
  audioCodecs: string[];
  width: number | null;
  height: number | null;
  durationSec: number | null;
  size: string | null;
}

/** Full title detail (movie or series) returned by GET /items/:id. */
export interface TitleDetail extends Ratings {
  id: string;
  kind: string; // "movie" | "series"
  title: string;
  year: number | null;
  overview: string | null;
  tagline?: string | null;
  runtimeSec: number | null;
  rating: string | null; // MPAA cert
  posterPath: string | null;
  backdropPath: string | null;
  logoPath?: string | null;
  status?: string | null;
  matchState: string;
  genres: string[];
  cast: { name: string; character: string }[];
  director: { name: string } | null;
  files: TitleFile[];
  seasons?: SeasonSummary[];
}
