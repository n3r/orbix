import { basename, dirname } from "node:path";

// ---------------------------------------------------------------------------
// Sibling-aware scan context.
//
// A single path often cannot say whether "001 - Не сдавать корабль!.mkv" is an
// episode or a numbered movie disc — but the DIRECTORY can: a folder holding a
// consistent run of ordinal-numbered files is an episode pack (the Plex/
// Jellyfin reading), while numbered files that each carry their own release
// year are a collection of separate movies. The scanner builds this context
// once from the full file list (pure string work, no I/O) and hands it to
// parseMediaPath.
// ---------------------------------------------------------------------------

/** Per-file verdict inside a detected ordinal run. */
export interface RunEntry {
  episodeNumber: number;
}

export interface DirAnalysis {
  /** basename → run entry when this directory holds an ordinal episode run. */
  run?: Map<string, RunEntry>;
  /** basenames whose leading ordinal is a collection list index (movies). */
  listIndex?: Set<string>;
  /** Season implied by the dir name: bare "01", a year "2003", a disc "RUGRATS_10". */
  seasonHint?: number;
}

export interface ScanContext {
  /** Library source root — the walk boundary; never a show title. */
  root?: string;
  /** dirname → analysis, for directories that contain scanned files. */
  dirs?: Map<string, DirAnalysis>;
}

/** Number + optional tail after an optional common prefix. */
const ORDINAL_REST_RE = /^[\s._)-]*(\d{1,3})(?:[.)\]\s_-]+(.*))?$/;

/** A CD/part split of one movie — its numbering is never episodes. */
const SPLIT_PREFIX_RE = /(?:^|[\s._-])(?:cd|dis[ck]|dvd|pt|part|часть|chast)[\s._-]*$/i;

// A release-noise token. When a year sits next to one ("…HDTVRip.2017.…",
// "…1969.BDRip") it is a release tag; a year with only prose neighbours
// ("01 - The 1969 Landing") is part of an episode title. Distinguishing the
// two is what keeps a numbered documentary run whose titles mention years from
// being misread as a collection of separate films.
const NOISE_TOKEN_RE =
  /^(?:bd|bdrip|bdremux|blu-?ray|brrip|web|webrip|webdl|hdtv|hdtvrip|dvd|dvdrip|hdrip|satrip|iptvrip|tvrip|vhsrip|dcprip|remux|x26[45]|h26[45]|hevc|avc|xvid|divx|\d{3,4}[pi]|4k|uhd|hdr|hdr10|sdr|rus|eng|dub|sub|союзмультфильм)$/i;
const YEAR_ONLY_RE = /^(?:19|20)\d{2}$/;

/**
 * Years in a filename that read as RELEASE tags: a 4-digit year with a
 * release-noise token immediately before or after it. A collection of separate
 * films carries a distinct release year per file; an episode run whose titles
 * merely mention years does not.
 */
function releaseYears(nameNoExt: string): number[] {
  const tokens = nameNoExt.split(/[\s._()[\]-]+/).filter(Boolean);
  const out: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!YEAR_ONLY_RE.test(tokens[i]!)) continue;
    const prevNoise = i > 0 && NOISE_TOKEN_RE.test(tokens[i - 1]!);
    const nextNoise = i + 1 < tokens.length && NOISE_TOKEN_RE.test(tokens[i + 1]!);
    if (prevNoise || nextNoise) out.push(parseInt(tokens[i]!, 10));
  }
  return out;
}

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

/** Longest common prefix, backed off past any trailing digits. */
function commonPrefix(names: string[]): string {
  let p = names[0] ?? "";
  for (const n of names.slice(1)) {
    let i = 0;
    while (i < p.length && i < n.length && p[i] === n[i]) i++;
    p = p.slice(0, i);
  }
  return p.replace(/\d+$/, "");
}

const BARE_SEASON_DIR_RE = /^(?:0?[1-9]|[1-4]\d)$/;
const YEAR_DIR_RE = /^(?:19|20)\d{2}$/;
const NUMERIC_TAIL_DIR_RE = /^(.*?)[\s._-](\d{1,2})$/;

function dirKey(s: string): string {
  return s.replace(/[\s._]+/g, " ").trim().toLowerCase();
}

/**
 * Season number implied by a directory's own name: a bare 1–2 digit folder
 * ("01"), a year folder ("2003" → season 2003, the date-based convention), or
 * a numeric-tail disc/volume folder ("RUGRATS_10"). The disc case requires the
 * stem to recur across ≥3 sibling folders (RUGRATS_1…RUGRATS_12) — a two- or
 * three-film sequel set ("Rambo 2"/"Rambo 3") is NOT a disc series and must
 * not inject a season hint. `stemCounts` maps a normalized stem to how many
 * sibling dirs carry it (precomputed once per parent — see buildScanContext).
 */
function dirSeasonHint(name: string, stemCounts: Map<string, number>): number | undefined {
  if (BARE_SEASON_DIR_RE.test(name)) return parseInt(name, 10);
  if (YEAR_DIR_RE.test(name)) return parseInt(name, 10);
  const m = NUMERIC_TAIL_DIR_RE.exec(name);
  if (m && (stemCounts.get(dirKey(m[1]!)) ?? 0) >= 3) return parseInt(m[2]!, 10);
  return undefined;
}

interface Candidate {
  base: string;
  number: string;
  /** Text after the ordinal ("Prologue" in "00 - Prologue"); "" for bare rips. */
  tail: string;
  years: number[];
}

/**
 * Classify one directory's files: an ordinal episode run, a numbered movie
 * collection (list indices to strip), or neither.
 *
 * Episodes need evidence beyond "numbers exist" — a naked unpadded trilogy
 * ("1 Братство кольца") must stay movies. The accepted signals: zero-padded
 * numbering (a list convention), a long run (≥5), a shared identical release
 * year, or (for a padded 2-file run) a shared release year or a season/year
 * directory. Files carrying DISTINCT release years are always a collection of
 * separate movies.
 */
function analyzeFiles(names: string[], seasonHint: number | undefined): Pick<DirAnalysis, "run" | "listIndex"> {
  if (names.length < 2) return {};
  const bases = names.map(stripExt);
  const prefix = commonPrefix(bases);
  if (SPLIT_PREFIX_RE.test(prefix)) return {};

  const candidates: Candidate[] = [];
  let nonConforming = 0;
  for (let i = 0; i < names.length; i++) {
    const rest = bases[i]!.slice(prefix.length);
    const m = ORDINAL_REST_RE.exec(rest);
    if (!m) {
      nonConforming++; // falls back to the normal parse (a movie/extra)
      continue;
    }
    candidates.push({ base: names[i]!, number: m[1]!, tail: m[2]?.trim() ?? "", years: releaseYears(bases[i]!) });
  }
  // A stray sibling or two ("SP10 - Holiday Special" among "070 - …", a lone
  // "Behind The Scenes.mkv" beside a 3-part run) must not dissolve the run, but
  // strays outnumbering half the ordinals means the folder isn't really a run.
  if (!candidates.length || nonConforming * 2 > candidates.length) return {};

  const numbers = candidates.map((c) => parseInt(c.number, 10));
  if (new Set(numbers).size !== numbers.length) return {};

  const distinctYears = new Set(candidates.flatMap((c) => c.years));
  if (distinctYears.size >= 2) {
    // Collection of separate movies — strip the leading index from titles.
    return { listIndex: new Set(candidates.filter((c) => /^\d/.test(stripExt(c.base))).map((c) => c.base)) };
  }

  const n = candidates.length;
  const padded = candidates.some((c) => c.number.length >= 2 && c.number.startsWith("0"));
  const sharedYear = distinctYears.size === 1 && candidates.every((c) => c.years.length > 0);
  // A 2-file run needs corroboration (padding alone is weak): a shared release
  // year, or a season/year directory. The disc-folder seasonHint is already
  // gated to real disc series (≥3 same-stem siblings), so a 2-film sequel set
  // ("Rambo 2"/"Rambo 3") never supplies it.
  const isRun = n >= 3 ? padded || n >= 5 || sharedYear : padded && (sharedYear || seasonHint != null);
  if (!isRun) return {};

  // A zero-based shift (t00 → E1) is only right for TITLE-LESS disc rips
  // (MakeMKV "A1_t00"); a titled run that starts at "00 - Prologue" keeps its
  // real numbering (00 stays a special/prologue, not everything shifted +1).
  const min = Math.min(...numbers);
  const titled = candidates.some((c) => c.tail !== "");
  const shift = min === 0 && !titled ? 1 : 0;
  const run = new Map<string, RunEntry>();
  for (let i = 0; i < candidates.length; i++) {
    run.set(candidates[i]!.base, { episodeNumber: numbers[i]! + shift });
  }
  return { run };
}

/**
 * Build the sibling context for one source scan. Pure: consumes the file list
 * the scanner already holds. Files directly in the root never form runs — a
 * library root is a pile of unrelated items, not a pack.
 */
export function buildScanContext(root: string, filePaths: string[]): ScanContext {
  const byDir = new Map<string, string[]>();
  for (const p of filePaths) {
    const dir = dirname(p);
    let list = byDir.get(dir);
    if (!list) byDir.set(dir, (list = []));
    // NFC-compose the basename: parseMediaPath keys its lookups with the
    // NFC filename, so scan-context must key its maps the same way or every
    // lookup misses for decomposed (macOS/SMB) Cyrillic/accented names.
    list.push(basename(p).normalize("NFC"));
  }

  // Per parent directory, how many child dirs share each numeric-tail stem
  // ("RUGRATS_" → 12). Precomputed once so dirSeasonHint is O(1), not an
  // O(children²) sibling scan for pathological numeric-tailed layouts.
  const stemCountsByParent = new Map<string, Map<string, number>>();
  for (const dir of byDir.keys()) {
    const m = NUMERIC_TAIL_DIR_RE.exec(basename(dir).normalize("NFC"));
    if (!m) continue;
    const parent = dirname(dir);
    let counts = stemCountsByParent.get(parent);
    if (!counts) stemCountsByParent.set(parent, (counts = new Map()));
    const stem = dirKey(m[1]!);
    counts.set(stem, (counts.get(stem) ?? 0) + 1);
  }

  const normalizedRoot = root.replace(/\/+$/, "");
  const dirs = new Map<string, DirAnalysis>();
  for (const [dir, names] of byDir) {
    const name = basename(dir).normalize("NFC");
    const seasonHint = dirSeasonHint(name, stemCountsByParent.get(dirname(dir)) ?? new Map());
    const analysis: DirAnalysis = dir === normalizedRoot ? {} : analyzeFiles(names, seasonHint);
    if (seasonHint != null) analysis.seasonHint = seasonHint;
    if (analysis.run || analysis.listIndex || analysis.seasonHint != null) dirs.set(dir, analysis);
  }
  return { root: normalizedRoot, dirs };
}
