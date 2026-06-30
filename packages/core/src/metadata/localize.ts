/**
 * Pure metadata-localization helpers. No DB/network — the API layer supplies
 * already-loaded base rows and translation rows.
 *
 * Fallback rule everywhere: a translation value is used only when it is a
 * non-empty string; otherwise the base (default-language / English) value
 * stands. Output is therefore never blank.
 */

const TMDB_LANGUAGE_TAGS: Record<string, string> = {
  en: "en-US",
  es: "es-ES",
  de: "de-DE",
  pt: "pt-BR",
  ru: "ru-RU",
  fr: "fr-FR",
};

/** Map an internal ISO-639-1 code to a TMDB language tag (default en-US). */
export function tmdbLanguageTag(code: string): string {
  return TMDB_LANGUAGE_TAGS[code] ?? "en-US";
}

function pick(translated: string | null | undefined, base: string): string;
function pick(translated: string | null | undefined, base: string | null | undefined): string | null | undefined;
function pick(translated: string | null | undefined, base: string | null | undefined) {
  return translated && translated.trim() ? translated : base;
}

/**
 * Returns the base item with title/overview overridden by non-empty
 * translation values. Unknown/empty translations fall back to the base.
 */
export function localizeItem<T extends { title: string; overview?: string | null }>(
  base: T,
  tr?: { title?: string | null; overview?: string | null } | null,
): T {
  if (!tr) return base;
  return {
    ...base,
    title: pick(tr.title, base.title),
    overview: pick(tr.overview, base.overview),
  };
}

/**
 * Like localizeItem, but for records keyed on `name` (e.g. a TV season) rather
 * than `title`. Non-empty translation values win; otherwise the base stands.
 */
export function localizeName<T extends { name: string | null; overview?: string | null }>(
  base: T,
  tr?: { name?: string | null; overview?: string | null } | null,
): T {
  if (!tr) return base;
  return {
    ...base,
    name: pick(tr.name, base.name),
    overview: pick(tr.overview, base.overview),
  };
}

/**
 * Replaces each genre name with its translation (looked up by TMDB id) when
 * present, else keeps the base name.
 */
export function localizeGenres(
  base: { tmdbId: number | null; name: string }[],
  translations: Map<number, string>,
): { name: string }[] {
  return base.map((g) => {
    const t = g.tmdbId != null ? translations.get(g.tmdbId) : undefined;
    return { name: t && t.trim() ? t : g.name };
  });
}
