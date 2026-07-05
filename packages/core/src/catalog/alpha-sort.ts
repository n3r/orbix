/**
 * Script-bucketed alphabetical ordering for the library Browse tab.
 *
 * Titles sort by the script of their first letter/digit (leading whitespace
 * and punctuation skipped; no article stripping): Latin, then Cyrillic, then
 * any other letter script, then digits/symbols/empty last. Buckets are
 * implicit — a catalog with no Cyrillic titles simply has no Cyrillic block.
 */

const FIRST_ALNUM = /[\p{L}\p{N}]/u;

/** Bucket of a display title's first letter/digit; lower buckets sort first. */
export function titleScriptBucket(title: string): number {
  const first = title.match(FIRST_ALNUM)?.[0];
  if (first === undefined) return 3;
  if (/\p{Script=Latin}/u.test(first)) return 0;
  if (/\p{Script=Cyrillic}/u.test(first)) return 1;
  if (/\p{L}/u.test(first)) return 2;
  return 3; // digit
}

/**
 * Comparator factory over display titles: script bucket first, then a
 * case-insensitive, numeric-aware collation in the given locale (the active
 * profile's language — always one of the app's supported language codes).
 */
export function compareDisplayTitles(locale: string): (a: string, b: string) => number {
  const collator = new Intl.Collator([locale, "en"], { sensitivity: "base", numeric: true });
  return (a, b) => titleScriptBucket(a) - titleScriptBucket(b) || collator.compare(a, b);
}
