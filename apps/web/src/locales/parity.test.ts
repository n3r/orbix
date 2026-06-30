import { describe, it, expect } from "vitest";
import { SUPPORTED_LANGUAGES } from "../lib/i18n/languages";
import { NAMESPACES } from "../lib/i18n";

// Every locale JSON bundle, eagerly loaded so this runs without a server.
const bundles = import.meta.glob("./*/*.json", { eager: true }) as Record<
  string,
  { default: object }
>;

/** Locales that have shipped at least one bundle (Phase 2 adds de/pt/ru/fr). */
const shippedLocales = new Set(
  Object.keys(bundles)
    .map((p) => p.match(/^\.\/([^/]+)\//)?.[1])
    .filter((x): x is string => Boolean(x)),
);

function flatten(obj: object, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === "object" ? flatten(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

// i18next plural keys carry a CLDR category suffix; the count of forms differs
// per language (e.g. Russian uses _one/_few/_many/_other where English uses
// _one/_other). Compare the LOGICAL base keys, suffix-agnostic, so a locale
// with the correct (different) number of plural forms still passes parity.
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

function baseKeys(lng: string, ns: string): string[] {
  const mod = bundles[`./${lng}/${ns}.json`];
  if (!mod) return [];
  return [...new Set(flatten(mod.default).map((k) => k.replace(PLURAL_SUFFIX, "")))].sort();
}

describe("locale bundle parity", () => {
  for (const ns of NAMESPACES) {
    const enKeys = baseKeys("en", ns);
    if (enKeys.length === 0) continue; // namespace not yet authored in en

    for (const lng of SUPPORTED_LANGUAGES) {
      if (lng === "en" || !shippedLocales.has(lng)) continue;
      it(`${lng}/${ns} covers exactly the en logical key set`, () => {
        expect(baseKeys(lng, ns)).toEqual(enKeys);
      });
    }
  }
});
