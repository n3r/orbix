/**
 * Pure script-detection helpers for TMDB search.
 *
 * Filenames name the same title in any language/script — Russian Cyrillic,
 * Japanese, Chinese, Korean, Hindi, Thai, Arabic, Hebrew, Greek... Knowing
 * the dominant script lets the search layer pick a TMDB `language=` tag so
 * results come back localized and string-compare correctly against the
 * query, and lets it split a mixed-script filename (e.g. a Russian title
 * glued to its English one) into per-script runs to try as separate queries.
 */

export type Script =
  | "latin"
  | "cyrillic"
  | "han"
  | "kana"
  | "hangul"
  | "devanagari"
  | "thai"
  | "arabic"
  | "hebrew"
  | "greek"
  | "georgian"
  | "armenian"
  | "tamil"
  | "telugu"
  | "bengali";

/** Unicode Script-property test for each detectable script. Kana covers both Hiragana and Katakana. */
const SCRIPT_TESTS: [Script, RegExp][] = [
  ["latin", /\p{Script=Latin}/u],
  ["cyrillic", /\p{Script=Cyrillic}/u],
  ["han", /\p{Script=Han}/u],
  ["kana", /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
  ["hangul", /\p{Script=Hangul}/u],
  ["devanagari", /\p{Script=Devanagari}/u],
  ["thai", /\p{Script=Thai}/u],
  ["arabic", /\p{Script=Arabic}/u],
  ["hebrew", /\p{Script=Hebrew}/u],
  ["greek", /\p{Script=Greek}/u],
  ["georgian", /\p{Script=Georgian}/u],
  ["armenian", /\p{Script=Armenian}/u],
  ["tamil", /\p{Script=Tamil}/u],
  ["telugu", /\p{Script=Telugu}/u],
  ["bengali", /\p{Script=Bengali}/u],
];

const LETTER_RE = /\p{L}/u;

/**
 * Classifies a single character into one of our tracked scripts. Returns
 * null for a non-letter (digit/space/punctuation/mark) or a letter of a
 * script we don't track — both are "ignored" by the callers below.
 */
function classifyChar(ch: string): Script | null {
  if (!LETTER_RE.test(ch)) return null;
  for (const [script, re] of SCRIPT_TESTS) {
    if (re.test(ch)) return script;
  }
  return null;
}

/**
 * Dominant script of the string's letters (majority wins; digits and
 * punctuation are ignored). Null when the string has no classifiable letters.
 *
 * Japanese titles interleave Han (kanji) and Kana constantly, so whenever
 * both are present the dominant script is reported as "kana" (Japanese) even
 * when Han letters outnumber Kana ones. Pure Han with no Kana at all is
 * reported as "han" (Chinese).
 */
export function dominantScript(s: string): Script | null {
  const counts = new Map<Script, number>();
  for (const ch of s) {
    const script = classifyChar(ch);
    if (script == null) continue;
    counts.set(script, (counts.get(script) ?? 0) + 1);
  }
  if (counts.size === 0) return null;

  const han = counts.get("han") ?? 0;
  const kana = counts.get("kana") ?? 0;
  if (han > 0 && kana > 0) {
    // Kana-override rule: fold Han into Kana before taking the majority.
    counts.set("kana", han + kana);
    counts.delete("han");
  }

  let best: Script | null = null;
  let bestCount = -1;
  for (const [script, count] of counts) {
    if (count > bestCount) {
      best = script;
      bestCount = count;
    }
  }
  return best;
}

/**
 * TMDB language tag to search with for content named in this script, or null
 * when the script is too ambiguous to imply a language (latin) or unmapped.
 */
const TMDB_LANGUAGE_FOR_SCRIPT: Partial<Record<Script, string>> = {
  // Deliberate: most Cyrillic media content is Russian; a downstream
  // alternative-titles check catches uk/bg/sr.
  cyrillic: "ru-RU",
  han: "zh-CN",
  kana: "ja-JP",
  hangul: "ko-KR",
  devanagari: "hi-IN",
  thai: "th-TH",
  arabic: "ar-SA",
  hebrew: "he-IL",
  greek: "el-GR",
  georgian: "ka-GE",
  armenian: "hy-AM",
  tamil: "ta-IN",
  telugu: "te-IN",
  bengali: "bn-BD",
  // latin is deliberately unmapped — too ambiguous (en/pt/es/fr/de...).
};

/** TMDB language tag to search with for content named in this script, or null when ambiguous (latin) / unmapped. */
export function tmdbLanguageForScript(script: Script): string | null {
  return TMDB_LANGUAGE_FOR_SCRIPT[script] ?? null;
}

interface RunBuilder {
  script: Script;
  text: string;
  letters: number;
}

/**
 * True when two adjacent runs should collapse into one: same script, or the
 * Han/Kana pair specifically (Japanese text interleaves kanji and kana).
 */
function compatible(a: Script, b: Script): boolean {
  if (a === b) return true;
  return (a === "han" || a === "kana") && (b === "han" || b === "kana");
}

/** Label for a run formed by merging a and b: a Han/Kana pair always resolves to "kana" (Japanese). */
function mergeLabel(a: Script, b: Script): Script {
  return a === b ? a : "kana";
}

/** Merges runs[i] and runs[i + 1] in place into a single run labeled `label`. */
function mergeAt(runs: RunBuilder[], i: number, label: Script): void {
  const a = runs[i]!;
  const b = runs[i + 1]!;
  runs.splice(i, 2, { script: label, text: a.text + b.text, letters: a.letters + b.letters });
}

/**
 * Collapses adjacent runs until none are mergeable: first any same-script or
 * Han/Kana neighbors, then any run still left with under 2 letters (absorbed
 * into a neighbor — the previous run when one exists, else the following
 * one). Either pass can create a fresh adjacency for the other, so we keep
 * alternating until a full sweep changes nothing.
 */
function normalizeRuns(runs: RunBuilder[]): RunBuilder[] {
  let changed = true;
  while (changed && runs.length > 1) {
    changed = false;

    for (let i = 0; i < runs.length - 1; i++) {
      if (compatible(runs[i]!.script, runs[i + 1]!.script)) {
        mergeAt(runs, i, mergeLabel(runs[i]!.script, runs[i + 1]!.script));
        changed = true;
        break;
      }
    }
    if (changed) continue;

    for (let i = 0; i < runs.length; i++) {
      if (runs[i]!.letters >= 2) continue;
      if (i > 0) {
        mergeAt(runs, i - 1, runs[i - 1]!.script);
      } else {
        mergeAt(runs, i, runs[i + 1]!.script);
      }
      changed = true;
      break;
    }
  }
  return runs;
}

/**
 * Contiguous same-script letter runs, in order. Digits, spaces and
 * punctuation attach to whichever run is currently open; a change of letter
 * script opens a new run. Runs left with under 2 letters merge into a
 * neighbor, and adjacent Han/Kana runs always merge into one "kana" run
 * (Japanese text interleaves kanji and kana constantly). Used to split
 * bilingual filenames (e.g. a Cyrillic title glued to its English one) into
 * per-script search queries.
 */
export function scriptRuns(s: string): { script: Script; text: string }[] {
  const runs: RunBuilder[] = [];
  let prefix = "";

  for (const ch of s) {
    const script = classifyChar(ch);
    if (script == null) {
      if (runs.length > 0) {
        runs[runs.length - 1]!.text += ch;
      } else {
        prefix += ch;
      }
      continue;
    }

    const last = runs[runs.length - 1];
    if (last && last.script === script) {
      last.text += ch;
      last.letters += 1;
    } else {
      runs.push({ script, text: prefix + ch, letters: 1 });
      prefix = "";
    }
  }

  return normalizeRuns(runs).map((r) => ({ script: r.script, text: r.text.trim() }));
}
