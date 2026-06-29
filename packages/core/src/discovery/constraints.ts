/**
 * NL search constraint parser.
 * Pure function — no I/O, deterministic.
 */

export interface ParsedConstraints {
  runtimeMaxSec?: number;
  runtimeMinSec?: number;
  decadeStart?: number; // inclusive year
  decadeEnd?: number;   // inclusive year
  genres: string[];     // canonical TMDB genre names
  ratingMax?: string;   // e.g. "PG"
  residualText: string; // query with matched constraint phrases removed, trimmed/collapsed
}

// ---------------------------------------------------------------------------
// Genre word → canonical TMDB genre name
// ---------------------------------------------------------------------------
const GENRE_MAP: Record<string, string> = {
  funny: "Comedy",
  comedy: "Comedy",
  comedic: "Comedy",
  scary: "Horror",
  horror: "Horror",
  thriller: "Thriller",
  tense: "Thriller",
  suspenseful: "Thriller",
  action: "Action",
  romantic: "Romance",
  romance: "Romance",
  "sci-fi": "Science Fiction",
  "science fiction": "Science Fiction",
  scifi: "Science Fiction",
  drama: "Drama",
  dramatic: "Drama",
  documentary: "Documentary",
  animated: "Animation",
  animation: "Animation",
  family: "Family",
  adventure: "Adventure",
  fantasy: "Fantasy",
  mystery: "Mystery",
  musical: "Music",
  music: "Music",
  western: "Western",
  war: "War",
  crime: "Crime",
  biographical: "History",
  historical: "History",
};

// Multi-word keys need to be tried first (longest match wins)
const GENRE_KEYS_SORTED = Object.keys(GENRE_MAP).sort(
  (a, b) => b.length - a.length
);

// ---------------------------------------------------------------------------
// Rating patterns
// ---------------------------------------------------------------------------
interface RatingRule {
  pattern: RegExp;
  value: string;
}

const RATING_RULES: RatingRule[] = [
  {
    pattern: /\b(for\s+kids?|for\s+children|family[\s-]friendly|kid[\s-]friendly)\b/gi,
    value: "PG",
  },
  { pattern: /\bPG-13\b/gi, value: "PG-13" },
  { pattern: /\bPG\b/gi, value: "PG" },
  { pattern: /\bG\s+rated\b/gi, value: "G" },
  { pattern: /\brated\s+G\b/gi, value: "G" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function secondsFromHours(val: number): number {
  return Math.round(val * 3600);
}

function secondsFromMinutes(val: number): number {
  return Math.round(val * 60);
}

// Collapse multiple whitespace and trim
function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Core parser
// ---------------------------------------------------------------------------

export function parseConstraints(query: string): ParsedConstraints {
  let residual = query;
  let runtimeMaxSec: number | undefined;
  let runtimeMinSec: number | undefined;
  let decadeStart: number | undefined;
  let decadeEnd: number | undefined;
  const genreSet = new Set<string>();
  let ratingMax: string | undefined;

  // -------------------------------------------------------------------------
  // 1. Runtime – max (under / less than / below)
  // -------------------------------------------------------------------------
  // Matches: "under 2 hours", "less than 90 minutes", "below 1.5 hrs", etc.
  const runtimeMaxRe =
    /\b(under|less\s+than|below)\s+(\d+(?:\.\d+)?)\s+(hours?|hrs?|h|minutes?|mins?|min)\b/gi;
  residual = residual.replace(runtimeMaxRe, (match, _op, numStr, unit) => {
    const val = parseFloat(numStr);
    const u = unit.toLowerCase();
    if (u.startsWith("h")) {
      runtimeMaxSec = secondsFromHours(val);
    } else {
      runtimeMaxSec = secondsFromMinutes(val);
    }
    return " ";
  });

  // -------------------------------------------------------------------------
  // 2. Runtime – min (over / more than / at least)
  // -------------------------------------------------------------------------
  const runtimeMinRe =
    /\b(over|more\s+than|at\s+least)\s+(\d+(?:\.\d+)?)\s+(hours?|hrs?|h|minutes?|mins?|min)\b/gi;
  residual = residual.replace(runtimeMinRe, (match, _op, numStr, unit) => {
    const val = parseFloat(numStr);
    const u = unit.toLowerCase();
    if (u.startsWith("h")) {
      runtimeMinSec = secondsFromHours(val);
    } else {
      runtimeMinSec = secondsFromMinutes(val);
    }
    return " ";
  });

  // -------------------------------------------------------------------------
  // 3. Decade
  // -------------------------------------------------------------------------

  // "from the 90s" / "in the 1990s" / "from the 2000s" / bare "80s"
  const decadeRe =
    /\b(?:(?:from|in)\s+the\s+)?((?:19|20)\d0s|\d0s)\b/gi;
  residual = residual.replace(decadeRe, (match, decStr) => {
    // Normalise: "90s" → 1990, "2000s" → 2000, "1990s" → 1990
    const raw = decStr.replace(/s$/i, ""); // e.g. "90", "1990", "2000"
    let decade: number;
    if (raw.length === 2) {
      // Ambiguous short form: treat 20-99 as 1920-1999, 00-10 won't appear as 2-digit
      decade = parseInt(raw, 10) < 100 ? 1900 + parseInt(raw, 10) : parseInt(raw, 10);
    } else {
      decade = parseInt(raw, 10);
    }
    // Round down to decade boundary
    decade = Math.floor(decade / 10) * 10;
    decadeStart = decade;
    decadeEnd = decade + 9;
    return " ";
  });

  // "before YYYY" → decadeEnd = YYYY - 1
  const beforeYearRe = /\bbefore\s+((?:19|20)\d{2})\b/gi;
  residual = residual.replace(beforeYearRe, (_match, yr) => {
    decadeEnd = parseInt(yr, 10) - 1;
    return " ";
  });

  // "after YYYY" → decadeStart = YYYY + 1
  const afterYearRe = /\bafter\s+((?:19|20)\d{2})\b/gi;
  residual = residual.replace(afterYearRe, (_match, yr) => {
    decadeStart = parseInt(yr, 10) + 1;
    return " ";
  });

  // -------------------------------------------------------------------------
  // 4. Rating
  // -------------------------------------------------------------------------
  for (const rule of RATING_RULES) {
    rule.pattern.lastIndex = 0; // reset global regex state
    if (rule.pattern.test(residual)) {
      ratingMax = rule.value;
      rule.pattern.lastIndex = 0;
      residual = residual.replace(rule.pattern, " ");
      break; // first match wins
    }
    rule.pattern.lastIndex = 0;
  }

  // -------------------------------------------------------------------------
  // 5. Genres
  // -------------------------------------------------------------------------
  // Try multi-word phrases first (already sorted longest-first)
  for (const key of GENRE_KEYS_SORTED) {
    // Build a word-boundary aware pattern; handle special regex chars
    const escaped = key.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "gi");
    if (re.test(residual)) {
      const canonical = GENRE_MAP[key];
      genreSet.add(canonical);
      re.lastIndex = 0;
      residual = residual.replace(re, " ");
    }
  }

  // -------------------------------------------------------------------------
  // 6. Clean up residual
  // -------------------------------------------------------------------------
  residual = collapse(residual);

  return {
    ...(runtimeMaxSec !== undefined && { runtimeMaxSec }),
    ...(runtimeMinSec !== undefined && { runtimeMinSec }),
    ...(decadeStart !== undefined && { decadeStart }),
    ...(decadeEnd !== undefined && { decadeEnd }),
    genres: [...genreSet],
    ...(ratingMax !== undefined && { ratingMax }),
    residualText: residual,
  };
}
