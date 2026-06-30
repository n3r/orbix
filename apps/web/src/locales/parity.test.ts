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

function keysFor(lng: string, ns: string): string[] {
  const mod = bundles[`./${lng}/${ns}.json`];
  return mod ? flatten(mod.default).sort() : [];
}

describe("locale bundle parity", () => {
  for (const ns of NAMESPACES) {
    const enKeys = keysFor("en", ns);
    if (enKeys.length === 0) continue; // namespace not yet authored in en

    for (const lng of SUPPORTED_LANGUAGES) {
      if (lng === "en" || !shippedLocales.has(lng)) continue;
      it(`${lng}/${ns} has exactly the en key set`, () => {
        expect(keysFor(lng, ns)).toEqual(enKeys);
      });
    }
  }
});
