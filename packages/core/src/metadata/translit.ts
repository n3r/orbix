// ---------------------------------------------------------------------------
// Reverse transliteration of romanized Russian (Latin → Cyrillic).
//
// Many library filenames carry ROMANIZED Russian titles ("Zheleznyj chelovek"
// = "Железный человек"). TMDB cannot match the romanization, but it can match
// the Cyrillic string (searched with language=ru-RU), so we convert back
// before searching. The output feeds the fuzzy acceptance gate in
// match-score.ts, which absorbs the inherent lossiness of romanization
// (dropped soft signs, е/э ambiguity) — so this aims for "within an edit or
// two of the true title", not perfection.
//
// Pure, dependency-free string logic.
// ---------------------------------------------------------------------------

// Signals, roughly ordered by strength:
//  - digraphs English orthography never uses (ж х ц щ as zh/kh/ts/shch, ы+х)
//  - iotated vowels (ю я ё as yu/ya/yo)
//  - vowel+j codas (-oj/-ej/-yj/-aj → й)
//  - Slavic noun/adjective endings (-ый/-ий/-ии/-ая/-ия/-ние/-ова/-ский)
//  - word-initial consonant clusters English disallows (вв вз вп вн зв зн зл дн мн хр гд)
//  - a longish word ending in bare -i (plural/genitive: "Hroniki", "Kibertaksi")
const SLAVIC_SIGNALS = new RegExp(
  [
    "shch|zh|kh|ts|yh",
    "y[uao]",
    "[aeiouy]j",
    String.raw`(?:iy|yi|ii|aya|iya|nie|ova|sky)\b`,
    String.raw`\b(?:vv|vz|vp|vn|zv|zn|zl|dn|mn|hr|gd)`,
    String.raw`[a-z]{3}i\b`,
  ].join("|"),
  "i",
);

/**
 * True when a Latin string shows signals of romanized Slavic (digraphs like
 * zh/kh/ts/yu/ya, word-final -yj/-ij/-aya/-iya, un-English consonant
 * clusters, …). Loose gate — a false positive only costs one wasted TMDB
 * search, while a false negative loses a match, so it errs toward firing.
 */
export function looksRomanizedSlavic(s: string): boolean {
  return SLAVIC_SIGNALS.test(s);
}

/**
 * Multi-letter units, tried before single letters (greedy longest-match).
 * "jo" → ё covers the German/ISO romanization style; every other j is
 * resolved contextually in the scanner.
 */
const DIGRAPHS: ReadonlyArray<readonly [string, string]> = [
  ["zh", "ж"],
  ["kh", "х"],
  ["ch", "ч"],
  ["sh", "ш"],
  ["ts", "ц"],
  ["yu", "ю"],
  ["ya", "я"],
  ["yo", "ё"],
  ["jo", "ё"],
];

/**
 * Single-letter fallbacks. Notes on the ambiguous ones:
 *  - h → х: bare h is the dominant romanization of х in real filenames
 *    ("Hroniki", "Holop", "Dyhanie") — kh is handled as a digraph above.
 *  - y → ы: the iotated readings (ю я ё е) are consumed by digraphs first.
 *  - c → ц: scientific/ISO transliteration; bare c is rare in romanized
 *    Russian (к is always k), so ц is the safer reading.
 *  - e → е: word-initial e is remapped to э in the scanner, since initial е
 *    is conventionally romanized "ye"/"je".
 *  - ' / ` → ь: apostrophes are the standard soft-sign notation ("Obitel'").
 *  - j is deliberately absent — it is resolved contextually in the scanner.
 */
const SINGLES = new Map<string, string>([
  ["a", "а"],
  ["b", "б"],
  ["c", "ц"],
  ["d", "д"],
  ["e", "е"],
  ["f", "ф"],
  ["g", "г"],
  ["h", "х"],
  ["i", "и"],
  ["k", "к"],
  ["l", "л"],
  ["m", "м"],
  ["n", "н"],
  ["o", "о"],
  ["p", "п"],
  ["q", "к"],
  ["r", "р"],
  ["s", "с"],
  ["t", "т"],
  ["u", "у"],
  ["v", "в"],
  ["w", "в"],
  ["x", "кс"],
  ["y", "ы"],
  ["z", "з"],
  ["'", "ь"],
  ["`", "ь"],
]);

/** Vowels after which j reads as ж ("Prodoljenie"); jo → ё is a digraph. */
const J_ZH_VOWELS = new Set(["a", "e", "i", "u"]);

/** Vowels before a word-final y that make it read as й ("Nochnoy" → Ночной). */
const Y_CODA_VOWELS = new Set(["a", "e", "i", "o", "u"]);

/** Latin-letter test on an already-lowercased string ("" for out-of-range). */
function isLetter(ch: string): boolean {
  return ch >= "a" && ch <= "z";
}

/** Letters plus soft-sign apostrophes count as word-internal. */
function isWordChar(ch: string): boolean {
  return isLetter(ch) || ch === "'" || ch === "`";
}

/**
 * Best-effort reverse romanization of a Latin string to Russian Cyrillic.
 * Returns null when the input contains no Latin letters to convert. Digits,
 * spaces and punctuation pass through unchanged. Capitalization is preserved:
 * an uppercase source letter yields an uppercase first output letter.
 */
export function reverseTransliterateRu(latin: string): string | null {
  if (!/[a-zA-Z]/.test(latin)) return null;

  const lower = latin.toLowerCase();
  const out: string[] = [];
  let i = 0;

  while (i < lower.length) {
    const wordStart = !isWordChar(lower.charAt(i - 1));
    let mapped: string | null = null;
    let len = 1;

    if (lower.startsWith("shch", i)) {
      // The one four-letter cluster; must win over sh+ch.
      mapped = "щ";
      len = 4;
    } else if (wordStart && lower.startsWith("ye", i)) {
      // Word-initial е is conventionally romanized "ye" ("Yeralash" →
      // "Ералаш"); elsewhere y+e really is ые ("Prostye" → "Простые").
      mapped = "е";
      len = 2;
    } else if (
      (lower.startsWith("iy", i) || lower.startsWith("yi", i)) &&
      !isLetter(lower.charAt(i + 2))
    ) {
      // Word-final adjective ending: "Obitaemiy" → "Обитаемый".
      mapped = "ый";
      len = 2;
    } else {
      for (const [src, dst] of DIGRAPHS) {
        if (lower.startsWith(src, i)) {
          mapped = dst;
          len = src.length;
          break;
        }
      }
    }

    if (mapped === null) {
      const ch = lower.charAt(i);
      if (ch === "j") {
        // Ambiguous j: before a vowel it reads as ж (translit-chat style,
        // "Prodoljenie" → "Продолжение"); in codas it is й ("Bolshoj" →
        // "Болшой", "-skij" → "-ский").
        mapped = J_ZH_VOWELS.has(lower.charAt(i + 1)) ? "ж" : "й";
      } else if (
        ch === "y" &&
        Y_CODA_VOWELS.has(lower.charAt(i - 1)) &&
        !isLetter(lower.charAt(i + 1))
      ) {
        // BGN/Wikipedia-style й coda: a word-final vowel+y ("Nochnoy",
        // "Bolshoy", "May") is й, not ы. Mid-word y stays ы ("Prostye").
        mapped = "й";
      } else if (ch === "e" && wordStart) {
        // Bare word-initial e usually encodes э ("Eterna" → "Этерна"),
        // because initial е is romanized "ye"/"je". Mid-word e stays е.
        mapped = "э";
      } else {
        mapped = SINGLES.get(ch) ?? null;
      }
    }

    if (mapped === null) {
      // Digits, spaces, punctuation (and any stray non-Latin char) pass through.
      out.push(latin.charAt(i));
      i += 1;
      continue;
    }

    if (latin.charAt(i) !== lower.charAt(i)) {
      mapped = mapped.charAt(0).toUpperCase() + mapped.slice(1);
    }
    out.push(mapped);
    i += len;
  }

  return out.join("");
}
