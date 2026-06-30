// Shared response/view types used across the web app.
// These mirror the API response shapes (apps/api) and dedupe the per-file
// interface redefinitions that had accumulated across pages/components.

export interface Source {
  id: string;
  sectionId: string;
  path: string;
  enabled: boolean;
  lastScanAt: string | null;
}

export interface Section {
  id: string;
  name: string;
  libraryId: string;
  kind: string;
  order: number;
  sources?: Source[];
}

export interface Library {
  id: string;
  name: string;
  type: string;
  createdAt: string;
  sections: Section[];
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
