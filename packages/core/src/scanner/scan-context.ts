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

const YEAR_TOKEN_RE = /(?:^|[\s.(_[-])((?:19|20)\d{2})(?=[\s.)_\]-]|$)/g;

function fileYears(nameNoExt: string): number[] {
  return [...nameNoExt.matchAll(YEAR_TOKEN_RE)].map((m) => parseInt(m[1]!, 10));
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
 * a numeric-tail disc/volume folder ("RUGRATS_10") when at least one sibling
 * shares the same stem with a different number.
 */
function dirSeasonHint(name: string, siblings: string[]): number | undefined {
  if (BARE_SEASON_DIR_RE.test(name)) return parseInt(name, 10);
  if (YEAR_DIR_RE.test(name)) return parseInt(name, 10);
  const m = NUMERIC_TAIL_DIR_RE.exec(name);
  if (m) {
    const stem = dirKey(m[1]!);
    const n = parseInt(m[2]!, 10);
    for (const sib of siblings) {
      if (sib === name) continue;
      const sm = NUMERIC_TAIL_DIR_RE.exec(sib);
      if (sm && dirKey(sm[1]!) === stem && parseInt(sm[2]!, 10) !== n) return n;
    }
  }
  return undefined;
}

interface Candidate {
  base: string;
  number: string;
  years: number[];
}

/**
 * Classify one directory's files: an ordinal episode run, a numbered movie
 * collection (list indices to strip), or neither.
 *
 * Episodes need evidence beyond "numbers exist" — a naked unpadded trilogy
 * ("1 Братство кольца") must stay movies. The accepted signals: zero-padded
 * numbering (a list convention), a long run (≥5), a shared identical release
 * year, or (for 2-file padded runs) a season-shaped directory. Files carrying
 * DISTINCT years are always a collection of separate movies.
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
    candidates.push({ base: names[i]!, number: m[1]!, years: fileYears(bases[i]!) });
  }
  // A couple of odd siblings ("SP10 - Holiday Special" among "070 - …") must
  // not dissolve a 60-file run — but numbers among a mostly non-numbered
  // folder prove nothing.
  if (!candidates.length || nonConforming * 4 > candidates.length) return {};

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
  const isRun =
    (n >= 3 && (padded || n >= 5 || sharedYear)) ||
    (n === 2 && padded && (sharedYear || seasonHint != null));
  if (!isRun) return {};

  const min = Math.min(...numbers);
  const run = new Map<string, RunEntry>();
  for (let i = 0; i < candidates.length; i++) {
    // Zero-based rips (MakeMKV t00…) shift to 1-based episode numbers.
    run.set(candidates[i]!.base, { episodeNumber: numbers[i]! + (min === 0 ? 1 : 0) });
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
    list.push(basename(p));
  }

  // Sibling directory names per parent, for numeric-tail season detection.
  const siblingsByParent = new Map<string, string[]>();
  for (const dir of byDir.keys()) {
    const parent = dirname(dir);
    let list = siblingsByParent.get(parent);
    if (!list) siblingsByParent.set(parent, (list = []));
    list.push(basename(dir));
  }

  const normalizedRoot = root.replace(/\/+$/, "");
  const dirs = new Map<string, DirAnalysis>();
  for (const [dir, names] of byDir) {
    const name = basename(dir);
    const seasonHint = dirSeasonHint(name, siblingsByParent.get(dirname(dir)) ?? []);
    const analysis: DirAnalysis = dir === normalizedRoot ? {} : analyzeFiles(names, seasonHint);
    if (seasonHint != null) analysis.seasonHint = seasonHint;
    if (analysis.run || analysis.listIndex || analysis.seasonHint != null) dirs.set(dir, analysis);
  }
  return { root: normalizedRoot, dirs };
}
