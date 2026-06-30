import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES } from "./languages";

/**
 * Every translation namespace. Keep in sync with the JSON files under
 * `src/locales/<lng>/<ns>.json`. The bundle-parity test enforces that each
 * locale's key set matches `en` per namespace.
 */
export const NAMESPACES = [
  "common",
  "auth",
  "profiles",
  "nav",
  "account",
  "settings",
  "libraries",
  "fix",
  "catalog",
  "search",
  "title",
  "player",
  "errors",
] as const;

// Statically glob every locale JSON so Vite bundles them into the build
// (offline guarantee: never CDN-fetched at runtime).
const modules = import.meta.glob("../../locales/*/*.json", { eager: true });
const resources: Record<string, Record<string, unknown>> = {};
for (const [path, mod] of Object.entries(modules)) {
  const m = path.match(/locales\/([^/]+)\/([^/]+)\.json$/);
  if (!m) continue;
  const [, lng, ns] = m;
  resources[lng] ??= {};
  resources[lng][ns] = (mod as { default: unknown }).default;
}

/** Read a previously-chosen language from storage, guarded for SSR/no-storage. */
function initialLanguage(): string {
  try {
    const stored = localStorage.getItem("orbix_lang");
    if (stored && (SUPPORTED_LANGUAGES as readonly string[]).includes(stored)) {
      return stored;
    }
  } catch {
    /* no localStorage (SSR / private mode) — fall through */
  }
  return DEFAULT_LANGUAGE;
}

void i18n.use(initReactI18next).init({
  resources: resources as never,
  lng: initialLanguage(),
  fallbackLng: DEFAULT_LANGUAGE,
  supportedLngs: SUPPORTED_LANGUAGES as unknown as string[],
  ns: NAMESPACES as unknown as string[],
  defaultNS: "common",
  interpolation: { escapeValue: false },
  returnNull: false,
});

// Keep <html lang> in sync with the active language for accessibility. This
// covers the initial language resolved from storage at startup (before any
// profile-sync or switcher runs) as well as every later language change.
if (typeof document !== "undefined") {
  const applyHtmlLang = (lng: string) => {
    document.documentElement.lang = lng;
  };
  i18n.on("languageChanged", applyHtmlLang);
  applyHtmlLang(initialLanguage());
}

export default i18n;
