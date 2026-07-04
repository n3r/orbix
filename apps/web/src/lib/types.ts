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
  summary?: {
    totalItems: number;
    enrichedItems: number;
    missingMetadata: number;
    missingArtwork: number;
    files: number;
    sourceCount: number;
    enabledSourceCount: number;
    sourceErrorCount: number;
    lastScanAt: string | null;
  };
  activeScan?: {
    jobId: string;
    state: string;
    phase: string;
    processed?: number;
    total?: number;
    added?: number;
    updated?: number;
    skipped?: number;
    matched?: number;
    message?: string;
  } | null;
}

export interface Profile {
  id: string;
  name: string;
  avatar: string | null;
  kind: string;
  maturityCap: number | null;
}

/** One catalog category in the profile's nav (one per library). */
export interface MenuItem {
  libraryId: string;
  name: string;
}

/** Editor payload: all libraries + the profile's currently-enabled ordered ids. */
export interface MenuConfig {
  libraries: MenuItem[];
  enabled: string[];
}

/** Account-level identity for admin gating. */
export interface AuthMe {
  accountId: string;
  isAdmin: boolean;
}

/** Minimal item shape for poster cards (home rows, library grid, search). */
export interface MediaCard {
  id: string;
  title: string;
  year?: number | null;
  posterPath: string | null;
  matchState?: string;
}

/** Home-row card: MediaCard plus box art, continue-watching + recency fields. */
export interface HomeCard extends MediaCard {
  backdropPath?: string | null;
  addedAt?: string;
  progress?: { positionSec: number; durationSec: number } | null;
  resume?: { seasonNumber: number; episodeNumber: number; episodeTitle: string | null } | null;
}

/** One labelled row on the home screen (smart rows, continue watching, etc.). */
export interface HomeRow {
  key: string;
  title: string;
  items: HomeCard[];
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

/* ── TV — live channels (mirrors /api/tv/* shapes) ─────────────────────── */

/** One programme slot for now/next display (phase 3 EPG fills these). */
export interface TvProgrammeSlot {
  title: string;
  start: string;
  stop: string;
}

/** Channel card shared by /tv/home rails, /tv/guide rows and /tv/channels/:id. */
export interface TvChannelCard {
  id: string;
  number: number;
  name: string;
  country: string | null;
  categories: string[];
  quality: string | null;
  logo: string | null;
  healthy: boolean;
  favorite: boolean;
  /** Always present; null when there's no EPG match or nothing airs now/next. */
  now: TvProgrammeSlot | null;
  next: TvProgrammeSlot | null;
}

export interface TvHome {
  recents: TvChannelCard[];
  favorites: TvChannelCard[];
  countries: { code: string; channels: TvChannelCard[] }[];
  categories: { id: string; channels: TvChannelCard[] }[];
}

/** Windowed guide page (offset paging — never the whole catalog). */
export interface TvGuideResponse {
  total: number;
  channels: TvChannelCard[];
}

export interface TvPlaySource {
  streamId: string;
  src: string; // "/api/tv/proxy/<streamId>/index.m3u8"
  quality: string | null;
  label: string | null;
}

/** now/next pair returned by the play endpoint; always present, either slot may be null. */
export interface TvNowNext {
  now: TvProgrammeSlot | null;
  next: TvProgrammeSlot | null;
}

export interface TvPlayResponse {
  channel: {
    id: string;
    number: number;
    name: string;
    logo: string | null;
    country: string | null;
    quality: string | null;
  };
  nowNext: TvNowNext;
  sources: TvPlaySource[];
}

/** One entry of a channel's day schedule. */
export interface TvProgramme {
  id: string;
  start: string;
  stop: string;
  title: string;
  description: string | null;
  category: string | null;
}

/** Admin: one configured TV source (iptv-org catalog or an M3U playlist). */
export interface TvSource {
  id: string;
  kind: "iptv-org" | "m3u";
  name: string;
  url: string | null;
  countries: string[];
  epgUrl: string | null;
  enabled: boolean;
  status: string;
  statusMessage: string | null;
  lastSyncAt: string | null;
}

/** Admin: one configured XMLTV guide feed. */
export interface TvEpgSource {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  offsetMin: number;
  status: string;
  statusMessage: string | null;
  lastSyncAt: string | null;
}

/** Admin channel-manager row — unlike TvChannelCard, this INCLUDES hidden channels. */
export interface TvAdminChannel {
  id: string;
  number: number;
  name: string;
  country: string | null;
  categories: string[];
  quality: string | null;
  logo: string | null;
  hidden: boolean;
  kidsAllowed: boolean;
  epgId: string | null;
}
