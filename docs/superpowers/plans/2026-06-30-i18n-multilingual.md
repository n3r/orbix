# Orbix Multilingual (i18n) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship working English + Spanish localization of the Orbix UI and catalog metadata (per-profile language), then add German, Portuguese, Russian, French.

**Architecture:** Frontend uses `react-i18next` with per-namespace JSON bundles baked into the Vite build (offline-safe). The API stays locale-agnostic (machine codes + structured data); the client renders all human text. Catalog metadata is localized via additive translation tables (`MediaItemTranslation`, `GenreTranslation`) populated from TMDB's `language` param at scan time and by a re-runnable backfill job; read routes coalesce `requested-language → English base → raw`.

**Tech Stack:** Vite 8 + React 19 + react-i18next + i18next + i18next-browser-languagedetector; Fastify + Prisma + Postgres/pgvector; BullMQ; TMDB v3 API.

## Global Constraints

- **Offline guarantee:** translation bundles and cached metadata must never require the network at runtime. i18n bundles are imported into the build, not fetched from a CDN.
- **Kids filtering is server-enforced on every route** and is unchanged by i18n — localization is a projection layered *after* the existing rating filter.
- **`MediaFile.size` is a `BigInt`** → `.toString()` before serialization (already done in routes; preserve it).
- **`packages/core` imports no DB/network/fs/ffmpeg** — TMDB language support is a pure URL change with injected adapters; core tests use fakes.
- **Default/fallback language is `en`.** It is the permanent fallback for UI keys and metadata fields. Missing translation → fall back, never blank.
- **Internal language codes are ISO 639-1:** `en, es, de, pt, ru, fr`. TMDB tag map: `en→en-US, es→es-ES, de→de-DE, pt→pt-BR, ru→ru-RU, fr→fr-FR`.
- **Run `pnpm lint` per change**, not just typecheck+test (Turbo cache can hide lint-only errors).
- Repo-local pnpm 10.22.0, Node 22.

---

## PHASE 1 — Infrastructure + English + Spanish

### Task 1: i18next bootstrap + language registry

**Files:**
- Create: `apps/web/src/lib/i18n/index.ts`
- Create: `apps/web/src/lib/i18n/languages.ts`
- Create: `apps/web/src/locales/en/common.json`
- Create: `apps/web/src/locales/es/common.json`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/package.json` (deps)
- Test: `apps/web/src/lib/i18n/i18n.test.ts`

**Interfaces:**
- Produces: `i18n` (configured i18next instance, default export of `index.ts`); `SUPPORTED_LANGUAGES: readonly LanguageCode[]`; `type LanguageCode = "en"|"es"|"de"|"pt"|"ru"|"fr"`; `DEFAULT_LANGUAGE = "en"`; `LANGUAGE_LABELS: Record<LanguageCode,string>`; `isLanguageCode(x: string): x is LanguageCode`.

- [ ] **Step 1: Add dependencies**

```bash
pnpm --filter @orbix/web add i18next react-i18next i18next-browser-languagedetector
```

- [ ] **Step 2: Write the language registry**

`apps/web/src/lib/i18n/languages.ts`:

```ts
export const SUPPORTED_LANGUAGES = ["en", "es", "de", "pt", "ru", "fr"] as const;
export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number];
export const DEFAULT_LANGUAGE: LanguageCode = "en";

export const LANGUAGE_LABELS: Record<LanguageCode, string> = {
  en: "English",
  es: "Español",
  de: "Deutsch",
  pt: "Português",
  ru: "Русский",
  fr: "Français",
};

export function isLanguageCode(x: string): x is LanguageCode {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(x);
}
```

- [ ] **Step 3: Write the failing init test**

`apps/web/src/lib/i18n/i18n.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import i18n from "./index";

describe("i18n bootstrap", () => {
  it("initializes with en fallback and resolves a common key", async () => {
    await i18n.changeLanguage("en");
    expect(i18n.t("common:app.name")).toBe("Orbix");
  });
  it("falls back to en for a missing key in es", async () => {
    await i18n.changeLanguage("es");
    // app.name has no es-specific override of the brand; falls through to value
    expect(i18n.t("common:actions.save")).toBe("Guardar");
  });
});
```

- [ ] **Step 4: Run it — expect FAIL (module not found)**

```bash
pnpm --filter @orbix/web exec vitest run src/lib/i18n/i18n.test.ts
```
Expected: FAIL.

- [ ] **Step 5: Seed the two `common` bundles**

`apps/web/src/locales/en/common.json`:
```json
{
  "app": { "name": "Orbix" },
  "actions": { "save": "Save", "cancel": "Cancel", "delete": "Delete", "edit": "Edit", "close": "Close", "back": "Back", "retry": "Retry" },
  "status": { "loading": "Loading…", "saving": "Saving…" }
}
```
`apps/web/src/locales/es/common.json`:
```json
{
  "app": { "name": "Orbix" },
  "actions": { "save": "Guardar", "cancel": "Cancelar", "delete": "Eliminar", "edit": "Editar", "close": "Cerrar", "back": "Atrás", "retry": "Reintentar" },
  "status": { "loading": "Cargando…", "saving": "Guardando…" }
}
```

- [ ] **Step 6: Write the i18n instance**

`apps/web/src/lib/i18n/index.ts`:
```ts
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES } from "./languages";
import enCommon from "../../locales/en/common.json";
import esCommon from "../../locales/es/common.json";

export const NAMESPACES = [
  "common", "auth", "profiles", "nav", "settings",
  "libraries", "catalog", "search", "title", "player", "errors",
] as const;

// Statically import every bundle so Vite includes them in the build (offline-safe).
// Glob keeps this DRY as locale files are added.
const modules = import.meta.glob("../../locales/*/*.json", { eager: true });
const resources: Record<string, Record<string, unknown>> = {};
for (const [path, mod] of Object.entries(modules)) {
  const m = path.match(/locales\/([^/]+)\/([^/]+)\.json$/);
  if (!m) continue;
  const [, lng, ns] = m;
  resources[lng] ??= {};
  resources[lng][ns] = (mod as { default: unknown }).default;
}

void i18n.use(initReactI18next).init({
  resources: resources as never,
  lng: DEFAULT_LANGUAGE,
  fallbackLng: DEFAULT_LANGUAGE,
  supportedLngs: SUPPORTED_LANGUAGES as unknown as string[],
  ns: NAMESPACES as unknown as string[],
  defaultNS: "common",
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;
```
> Note: `enCommon`/`esCommon` imports above are illustrative of bundling; the glob is the actual loader. Remove the unused named imports to satisfy lint (keep only the glob).

- [ ] **Step 7: Wire into the app root**

`apps/web/src/main.tsx` — add `import "./lib/i18n";` before rendering (side-effect import that initializes i18next):
```tsx
import "./lib/i18n";
```
(place after the `./index.css` import line.)

- [ ] **Step 8: Run the test — expect PASS**

```bash
pnpm --filter @orbix/web exec vitest run src/lib/i18n/i18n.test.ts
pnpm --filter @orbix/web typecheck && pnpm --filter @orbix/web lint
```
Expected: PASS, clean typecheck + lint.

- [ ] **Step 9: Commit**

```bash
git add apps/web/package.json apps/web/src/lib/i18n apps/web/src/locales apps/web/src/main.tsx pnpm-lock.yaml
git commit -m "feat(web): bootstrap react-i18next with en/es common bundle"
```

---

### Task 2: Active-language provider (pre-login detection + profile sync + `<html lang>`)

**Files:**
- Create: `apps/web/src/lib/i18n/useActiveLanguage.ts`
- Modify: `apps/web/src/components/shell/AppShell.tsx` (call the sync hook where the active profile is known)
- Test: `apps/web/src/lib/i18n/useActiveLanguage.test.ts`

**Interfaces:**
- Consumes: `i18n` (Task 1), `isLanguageCode`, `DEFAULT_LANGUAGE` (Task 1).
- Produces: `detectInitialLanguage(): LanguageCode` (reads `localStorage["orbix_lang"]` → `navigator.language` prefix → `DEFAULT_LANGUAGE`); `setActiveLanguage(code: LanguageCode): void` (calls `i18n.changeLanguage`, writes `localStorage`, sets `document.documentElement.lang`); `useSyncProfileLanguage(language: string | null | undefined): void` (effect that applies a profile's language when it changes).

- [ ] **Step 1: Write the failing test**

`apps/web/src/lib/i18n/useActiveLanguage.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { detectInitialLanguage, setActiveLanguage } from "./useActiveLanguage";
import i18n from "./index";

beforeEach(() => localStorage.clear());

describe("active language", () => {
  it("detects from localStorage first", () => {
    localStorage.setItem("orbix_lang", "es");
    expect(detectInitialLanguage()).toBe("es");
  });
  it("falls back to en for unsupported browser language", () => {
    expect(detectInitialLanguage()).toBe("en");
  });
  it("setActiveLanguage updates i18n, storage, and <html lang>", async () => {
    await setActiveLanguage("es");
    expect(i18n.language).toBe("es");
    expect(localStorage.getItem("orbix_lang")).toBe("es");
    expect(document.documentElement.lang).toBe("es");
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

```bash
pnpm --filter @orbix/web exec vitest run src/lib/i18n/useActiveLanguage.test.ts
```

- [ ] **Step 3: Implement**

`apps/web/src/lib/i18n/useActiveLanguage.ts`:
```ts
import { useEffect } from "react";
import i18n from "./index";
import { DEFAULT_LANGUAGE, isLanguageCode, type LanguageCode } from "./languages";

const STORAGE_KEY = "orbix_lang";

export function detectInitialLanguage(): LanguageCode {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && isLanguageCode(stored)) return stored;
  const nav = navigator.language?.slice(0, 2).toLowerCase() ?? "";
  if (isLanguageCode(nav)) return nav;
  return DEFAULT_LANGUAGE;
}

export async function setActiveLanguage(code: LanguageCode): Promise<void> {
  await i18n.changeLanguage(code);
  localStorage.setItem(STORAGE_KEY, code);
  document.documentElement.lang = code;
}

/** Apply a profile's persisted language when it becomes known/changes. */
export function useSyncProfileLanguage(language: string | null | undefined): void {
  useEffect(() => {
    if (language && isLanguageCode(language)) void setActiveLanguage(language);
  }, [language]);
}
```

- [ ] **Step 4: Apply detected language at startup**

In `apps/web/src/lib/i18n/index.ts`, set `lng` from a safe detector. Replace the static `lng: DEFAULT_LANGUAGE` with a guarded read (kept inline to avoid an import cycle):
```ts
lng: (() => {
  try {
    const s = localStorage.getItem("orbix_lang");
    if (s && (SUPPORTED_LANGUAGES as readonly string[]).includes(s)) return s;
  } catch { /* SSR/no-storage */ }
  return DEFAULT_LANGUAGE;
})(),
```

- [ ] **Step 5: Call the sync hook in AppShell**

In `apps/web/src/components/shell/AppShell.tsx`, where the active profile is fetched (the `/me/profile` query — see Task 8 for the `language` field), call `useSyncProfileLanguage(profile?.language)`. (If AppShell doesn't already read the profile, add the existing `useQuery` for `/me/profile`.)

- [ ] **Step 6: Run tests + gates**

```bash
pnpm --filter @orbix/web exec vitest run src/lib/i18n
pnpm --filter @orbix/web typecheck && pnpm --filter @orbix/web lint
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/i18n apps/web/src/components/shell/AppShell.tsx
git commit -m "feat(web): active-language detection + profile language sync"
```

---

### Task 3: Error-code → message mapping helper

**Files:**
- Create: `apps/web/src/locales/en/errors.json`
- Create: `apps/web/src/locales/es/errors.json`
- Create: `apps/web/src/lib/i18n/tError.ts`
- Test: `apps/web/src/lib/i18n/tError.test.ts`

**Interfaces:**
- Produces: `errorMessage(code: string | undefined, t: TFunction): string` — maps an API error code to a localized message via the `errors` namespace, returning `errors:unknown` for unmapped codes.

- [ ] **Step 1: Seed error bundles** (cover every code found in the API)

`apps/web/src/locales/en/errors.json`:
```json
{
  "unknown": "Something went wrong. Please try again.",
  "network": "Network error. Please try again.",
  "invalid_credentials": "Invalid email or password.",
  "unauthenticated": "Please sign in to continue.",
  "unauthorized": "You don't have permission to do that.",
  "invalid_profile": "Those profile details aren't valid.",
  "not_found": "Not found.",
  "pin_required": "That profile needs a PIN.",
  "no_sources": "Add a library folder before scanning.",
  "tmdb_not_configured": "Set your TMDB token in Settings first.",
  "tmdbId_required": "A TMDB match is required.",
  "tmdbPosterPath_required": "A poster is required.",
  "not_allowed_for_kids": "This area isn't available on a kids profile.",
  "blocked_by_rating": "This title is blocked by the profile's maturity setting.",
  "invalid_sort": "That sort option isn't valid."
}
```
`apps/web/src/locales/es/errors.json`:
```json
{
  "unknown": "Algo salió mal. Inténtalo de nuevo.",
  "network": "Error de red. Inténtalo de nuevo.",
  "invalid_credentials": "Correo o contraseña no válidos.",
  "unauthenticated": "Inicia sesión para continuar.",
  "unauthorized": "No tienes permiso para hacer eso.",
  "invalid_profile": "Esos datos de perfil no son válidos.",
  "not_found": "No encontrado.",
  "pin_required": "Ese perfil necesita un PIN.",
  "no_sources": "Añade una carpeta de biblioteca antes de escanear.",
  "tmdb_not_configured": "Primero configura tu token de TMDB en Ajustes.",
  "tmdbId_required": "Se requiere una coincidencia de TMDB.",
  "tmdbPosterPath_required": "Se requiere un póster.",
  "not_allowed_for_kids": "Esta sección no está disponible en un perfil infantil.",
  "blocked_by_rating": "Este título está bloqueado por la clasificación del perfil.",
  "invalid_sort": "Esa opción de orden no es válida."
}
```

- [ ] **Step 2: Failing test**

`apps/web/src/lib/i18n/tError.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import i18n from "./index";
import { errorMessage } from "./tError";

describe("errorMessage", () => {
  it("maps a known code", () => {
    expect(errorMessage("invalid_credentials", i18n.getFixedT("en"))).toBe("Invalid email or password.");
  });
  it("falls back to unknown for unmapped code", () => {
    expect(errorMessage("weird_code", i18n.getFixedT("en"))).toBe("Something went wrong. Please try again.");
  });
  it("handles undefined", () => {
    expect(errorMessage(undefined, i18n.getFixedT("en"))).toBe("Something went wrong. Please try again.");
  });
});
```

- [ ] **Step 3: Run — FAIL.** `pnpm --filter @orbix/web exec vitest run src/lib/i18n/tError.test.ts`

- [ ] **Step 4: Implement**

`apps/web/src/lib/i18n/tError.ts`:
```ts
import type { TFunction } from "i18next";

export function errorMessage(code: string | undefined, t: TFunction): string {
  if (!code) return t("errors:unknown");
  const key = `errors:${code}`;
  const msg = t(key);
  return msg === key ? t("errors:unknown") : msg;
}
```

- [ ] **Step 5: Surface the code from `ApiError`.** In `apps/web/src/lib/api.ts`, parse the JSON body's `error` field into `ApiError`:
```ts
export class ApiError extends Error {
  constructor(public status: number, public code?: string, message?: string) {
    super(message ?? `HTTP ${status}`);
    this.name = "ApiError";
  }
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    let code: string | undefined;
    try { code = (await res.clone().json())?.error; } catch { /* non-JSON */ }
    throw new ApiError(res.status, code);
  }
  return (await res.json()) as T;
}
```
Update `apps/web/src/lib/api.test.ts` if it asserts the old `ApiError` signature.

- [ ] **Step 6: Run — PASS + gates.** `pnpm --filter @orbix/web exec vitest run src/lib && pnpm --filter @orbix/web typecheck && pnpm --filter @orbix/web lint`

- [ ] **Step 7: Commit**
```bash
git add apps/web/src/lib/i18n/tError.ts apps/web/src/lib/i18n/tError.test.ts apps/web/src/locales/*/errors.json apps/web/src/lib/api.ts apps/web/src/lib/api.test.ts
git commit -m "feat(web): error-code to localized message mapping"
```

---

### Tasks 4a–4j: Extract UI strings per page-group

> **Mechanical extraction tasks.** Each follows the SAME pattern; do them one file-group at a time, each its own commit. For every group: (1) add an `en/<ns>.json` and `es/<ns>.json` bundle, (2) replace every hardcoded user-facing literal in the listed files with `t("<ns>:<key>")` using `const { t } = useTranslation()` (namespaces auto-loaded since all are registered), (3) keep keys hierarchical and descriptive, (4) for counts use i18next plural keys (`key_one`/`key_other`), (5) for interpolation use `t("k", { name })`, (6) translate the `es` bundle fully.

**Canonical example (LoginPage):**

Before (`apps/web/src/pages/LoginPage.tsx`):
```tsx
<h1 …>Sign in to Orbix</h1>
…
setError("Invalid email or password.");
…
{loading ? "Signing in…" : "Sign In"}
```
After:
```tsx
import { useTranslation } from "react-i18next";
// inside component:
const { t } = useTranslation("auth");
…
<h1 …>{t("auth:login.title")}</h1>
…
setError(t("errors:invalid_credentials"));
…
{loading ? t("auth:login.submitting") : t("auth:login.submit")}
```
`en/auth.json` gets `{ "login": { "title": "Sign in to Orbix", "email": "Email", "password": "Password", "submit": "Sign In", "submitting": "Signing in…", "emailPlaceholder": "you@example.com", "passwordPlaceholder": "Your password" } }`; `es/auth.json` the Spanish equivalents.

Each sub-task ends with:
```bash
pnpm --filter @orbix/web typecheck && pnpm --filter @orbix/web lint && pnpm --filter @orbix/web test
git add apps/web/src/locales apps/web/src/pages apps/web/src/components
git commit -m "feat(web): localize <group> strings"
```

- [ ] **Task 4a — `auth`:** `pages/LoginPage.tsx`, `pages/SetupPage.tsx`. Namespace `auth`.
- [ ] **Task 4b — `profiles`:** `pages/ProfilesPage.tsx`. Namespace `profiles`. Include the language selector copy placeholder keys (used in Task 8).
- [ ] **Task 4c — `nav`:** `components/shell/Sidebar.tsx`, `components/shell/TopBar.tsx`, `components/shell/AppShell.tsx`. Namespace `nav`.
- [ ] **Task 4d — `settings`:** `pages/AdminSettingsPage.tsx` (~30+ strings; encoder names, help text, status). Namespace `settings`.
- [ ] **Task 4e — `libraries`:** `pages/AdminLibrariesPage.tsx` (~25+). Namespace `libraries`. Use plural keys for scan counts.
- [ ] **Task 4f — `catalog`:** `pages/HomePage.tsx`, `pages/LibraryPage.tsx`, `components/MediaRow.tsx`, `components/HomeRows.tsx`, `components/Hero.tsx`, `components/PosterCard.tsx`. Namespace `catalog`.
- [ ] **Task 4g — `search`:** `pages/SearchPage.tsx`. Namespace `search`. `results_one`/`results_other` plural.
- [ ] **Task 4h — `title`:** `pages/TitlePage.tsx`. Namespace `title`. Localize `formatRuntime` via `t("title:runtime", { h, m })` patterns; localize the "Unrated" display label and section headings (Cast, Genres, Overview, More Like This).
- [ ] **Task 4i — `player`:** `components/Player.tsx`, `components/PlayerOverlay.tsx`. Namespace `player`. Includes aria-labels and subtitle track labels.
- [ ] **Task 4j — `fix`:** `pages/FixMatchPage.tsx` (~20+). Namespace `libraries` (reuse) or new `fix`; use `fix`.

---

### Task 5: Bundle-parity test (guards every locale against `en`)

**Files:**
- Test: `apps/web/src/locales/parity.test.ts`

**Interfaces:** Consumes all `locales/**/*.json`.

- [ ] **Step 1: Write the test**

`apps/web/src/locales/parity.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { SUPPORTED_LANGUAGES } from "../lib/i18n/languages";
import { NAMESPACES } from "../lib/i18n";

const bundles = import.meta.glob("./*/*.json", { eager: true }) as Record<string, { default: object }>;

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
    if (enKeys.length === 0) continue;
    for (const lng of SUPPORTED_LANGUAGES) {
      if (lng === "en") continue;
      it(`${lng}/${ns} matches en key set`, () => {
        // Only enforce for locales that have shipped this ns (Phase 2 adds the rest).
        const keys = keysFor(lng, ns);
        if (keys.length === 0) return;
        expect(keys).toEqual(enKeys);
      });
    }
  }
});
```

- [ ] **Step 2: Run — expect PASS for en/es** (de/pt/ru/fr skipped until Phase 2).
```bash
pnpm --filter @orbix/web exec vitest run src/locales/parity.test.ts
```

- [ ] **Step 3: Commit**
```bash
git add apps/web/src/locales/parity.test.ts
git commit -m "test(web): locale bundle key-parity guard"
```

---

### Task 6: Schema — profile language + translation tables

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create (generated): `packages/db/prisma/migrations/<timestamp>_i18n/migration.sql`

**Interfaces:**
- Produces: `Profile.language: string` (default `"en"`); models `MediaItemTranslation(mediaItemId, language, title?, overview?)`, `GenreTranslation(genreId, language, name)`.

- [ ] **Step 1: Edit the schema.** Add to `model Profile`:
```prisma
  language    String   @default("en")
```
Add `translations MediaItemTranslation[]` to `model MediaItem` and `translations GenreTranslation[]` to `model Genre`, and append:
```prisma
model MediaItemTranslation {
  mediaItemId String
  mediaItem   MediaItem @relation(fields: [mediaItemId], references: [id], onDelete: Cascade)
  language    String
  title       String?
  overview    String?

  @@id([mediaItemId, language])
  @@index([mediaItemId])
}

model GenreTranslation {
  genreId  Int
  genre    Genre  @relation(fields: [genreId], references: [id], onDelete: Cascade)
  language String
  name     String

  @@id([genreId, language])
}
```

- [ ] **Step 2: Create the migration** (needs Postgres up: `docker compose up -d postgres`)
```bash
pnpm db:migrate --name i18n
```
Expected: migration created + applied; `pnpm db:generate` runs implicitly.

- [ ] **Step 3: Typecheck the db package**
```bash
pnpm --filter @orbix/db build && pnpm --filter @orbix/db typecheck
```

- [ ] **Step 4: Commit**
```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations
git commit -m "feat(db): per-profile language + metadata translation tables"
```

---

### Task 7: Core — TMDB language param + metadata coalesce helper

**Files:**
- Modify: `packages/core/src/metadata/tmdb.ts`
- Create: `packages/core/src/metadata/localize.ts`
- Modify: `packages/core/src/index.ts` (export `localizeItem`, `localizeGenres`, `tmdbLanguageTag`)
- Test: `packages/core/src/metadata/tmdb.test.ts` (extend), `packages/core/src/metadata/localize.test.ts`

**Interfaces:**
- Produces:
  - `tmdbLanguageTag(code: string): string` — maps `en→en-US … fr→fr-FR`, default `en-US`.
  - `TmdbClient` accepts an optional `language` (TMDB tag) in its constructor and appends `&language=<tag>` (or `?language=` when no query yet) to `movie`, `searchMovie`, `searchMovies`. Add `genreList(kind: "movie"|"tv"): Promise<TmdbGenreRef[]>` hitting `/genre/{kind}/list`.
  - `localizeItem<T extends {title:string; overview?:string|null}>(base: T, tr?: {title?:string|null; overview?:string|null}): T` — returns base with `title`/`overview` replaced by non-empty translation values.
  - `localizeGenres(base: {tmdbId:number|null; name:string}[], translations: Map<number,string>): {name:string}[]`.

- [ ] **Step 1: Failing tests for the language param**

Extend `packages/core/src/metadata/tmdb.test.ts`:
```ts
it("appends language tag to movie/search requests", async () => {
  const calls: string[] = [];
  const fakeFetch = (async (url: string) => {
    calls.push(url);
    return { ok: true, json: async () => ({ id: 1, title: "X", results: [] }) } as Response;
  }) as unknown as typeof fetch;
  const client = new TmdbClient("tok", fakeFetch, "es-ES");
  await client.movie(1);
  expect(calls[0]).toContain("language=es-ES");
});
```

- [ ] **Step 2: Run — FAIL.** `pnpm --filter @orbix/core exec vitest run src/metadata/tmdb.test.ts`

- [ ] **Step 3: Implement language in `TmdbClient`.** Add ctor param + a `withLang(url)` helper:
```ts
constructor(token: string, fetchImpl?: typeof fetch, private readonly language?: string) {
  this.token = token;
  this.fetchImpl = fetchImpl ?? globalThis.fetch;
}
private withLang(url: string): string {
  if (!this.language) return url;
  return url + (url.includes("?") ? "&" : "?") + `language=${this.language}`;
}
```
Wrap each request URL: `await this.get<…>(this.withLang(url))` in `movie`, `searchMovie`, `searchMovies`. Add:
```ts
async genreList(kind: "movie" | "tv"): Promise<TmdbGenreRef[]> {
  const data = await this.get<{ genres: { id: number; name: string }[] }>(
    this.withLang(`${BASE}/genre/${kind}/list`),
  );
  return data.genres.map((g) => ({ tmdbId: g.id, name: g.name }));
}
```

- [ ] **Step 4: Failing test for localize helper**

`packages/core/src/metadata/localize.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { localizeItem, localizeGenres, tmdbLanguageTag } from "./localize";

describe("localize", () => {
  it("prefers translation when present, else base", () => {
    expect(localizeItem({ title: "A", overview: "o" }, { title: "Á", overview: null }))
      .toEqual({ title: "Á", overview: "o" });
  });
  it("ignores empty translation strings", () => {
    expect(localizeItem({ title: "A", overview: "o" }, { title: "" }).title).toBe("A");
  });
  it("maps language codes to TMDB tags", () => {
    expect(tmdbLanguageTag("pt")).toBe("pt-BR");
    expect(tmdbLanguageTag("zz")).toBe("en-US");
  });
  it("localizes genres by tmdbId", () => {
    expect(localizeGenres([{ tmdbId: 1, name: "Action" }], new Map([[1, "Acción"]])))
      .toEqual([{ name: "Acción" }]);
  });
});
```

- [ ] **Step 5: Implement `localize.ts`** (pure, no imports):
```ts
const TAGS: Record<string, string> = {
  en: "en-US", es: "es-ES", de: "de-DE", pt: "pt-BR", ru: "ru-RU", fr: "fr-FR",
};
export function tmdbLanguageTag(code: string): string {
  return TAGS[code] ?? "en-US";
}
export function localizeItem<T extends { title: string; overview?: string | null }>(
  base: T,
  tr?: { title?: string | null; overview?: string | null } | null,
): T {
  if (!tr) return base;
  return {
    ...base,
    title: tr.title && tr.title.trim() ? tr.title : base.title,
    overview: tr.overview && tr.overview.trim() ? tr.overview : base.overview,
  };
}
export function localizeGenres(
  base: { tmdbId: number | null; name: string }[],
  translations: Map<number, string>,
): { name: string }[] {
  return base.map((g) => ({
    name: g.tmdbId != null && translations.has(g.tmdbId) ? translations.get(g.tmdbId)! : g.name,
  }));
}
```

- [ ] **Step 6: Export + run all core tests**

Add to `packages/core/src/index.ts`: `export * from "./metadata/localize";`
```bash
pnpm --filter @orbix/core test && pnpm --filter @orbix/core typecheck && pnpm --filter @orbix/core lint
```
Expected: PASS.

- [ ] **Step 7: Commit**
```bash
git add packages/core/src/metadata packages/core/src/index.ts
git commit -m "feat(core): TMDB language param + metadata localize/fallback helpers"
```

---

### Task 8: Profile language field — validation, persistence, exposure

**Files:**
- Modify: `packages/core/src/profiles/profiles.ts` (+ test)
- Modify: `apps/api/src/routes/profiles.ts`
- Modify: `apps/api/src/lib/catalog-filter.ts` (`activeProfile` selects `language`)

**Interfaces:**
- Consumes: `isLanguageCode`-equivalent set (define `LANGUAGE_CODES` in core or validate against the same six).
- Produces: `validateProfileInput` accepts optional `language` (one of the six, default `en`); `activeProfile(...)` return type gains `language: string`; `/me/profile` and create/patch persist + return `language`.

- [ ] **Step 1: Failing core test**

Add to `packages/core/src/profiles/profiles.test.ts`:
```ts
it("accepts a supported language and defaults to en", () => {
  expect(validateProfileInput({ name: "P", kind: "standard" }).language).toBe("en");
  expect(validateProfileInput({ name: "P", kind: "standard", language: "es" }).language).toBe("es");
});
it("rejects an unsupported language", () => {
  expect(() => validateProfileInput({ name: "P", kind: "standard", language: "zz" })).toThrow(ProfileValidationError);
});
```

- [ ] **Step 2: Run — FAIL.** `pnpm --filter @orbix/core exec vitest run src/profiles/profiles.test.ts`

- [ ] **Step 3: Implement.** In `packages/core/src/profiles/profiles.ts` add to the zod schema:
```ts
language: z.enum(["en", "es", "de", "pt", "ru", "fr"]).default("en"),
```

- [ ] **Step 4: Persist in routes.** In `apps/api/src/routes/profiles.ts`:
  - `create`: add `language: v.language` to `data` and `language: true` to `select`.
  - `patch`: pass `language: body.language ?? existing.language` into `validateProfileInput`, add `language: merged.language` to `data`, `language: true` to `select`.
  - After a successful **patch that changes language to a new value**, enqueue the translate-metadata job for that language (wired in Task 10 — leave a `// TODO(task10)` call site or import the enqueue helper once it exists).

- [ ] **Step 5: Expose language.** In `apps/api/src/lib/catalog-filter.ts`, add `language: true` to the `activeProfile` select and `language: string` to its return type. `/me/profile` already returns the profile object, so the field flows to the client.

- [ ] **Step 6: Run gates.**
```bash
pnpm --filter @orbix/core test && pnpm --filter @orbix/api typecheck && pnpm --filter @orbix/api lint
```

- [ ] **Step 7: Commit**
```bash
git add packages/core/src/profiles apps/api/src/routes/profiles.ts apps/api/src/lib/catalog-filter.ts
git commit -m "feat: per-profile language field (validate, persist, expose)"
```

---

### Task 9: Catalog read-path localization

**Files:**
- Modify: `apps/api/src/routes/catalog.ts` (list + by-id)
- Modify: `apps/api/src/routes/discovery.ts`, `apps/api/src/routes/search`-equivalents that return titles/overviews/genres (audit for `title`/`overview`/`genres` projections)
- Test: `apps/api/src/routes/catalog.localize.test.ts`

**Interfaces:**
- Consumes: `localizeItem`, `localizeGenres` (Task 7); `activeProfile(...).language` (Task 8).

- [ ] **Step 1: Failing API test** (use the existing api test harness pattern; build an app, seed a MediaItem + MediaItemTranslation, set the profile cookie to an es profile):

`apps/api/src/routes/catalog.localize.test.ts`:
```ts
// Seeds an item titled "The Matrix" with an es translation "Matrix" and a
// profile whose language is "es"; asserts GET /items/:id returns the es title,
// and falls back to base when the es row is absent. (Follow existing route-test
// setup in apps/api/src/routes/*.test.ts for app/prisma/cookie wiring.)
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement list route.** In `catalog.ts` `/sections/:id/items`:
  - read `const lang = profile?.language ?? "en"`.
  - when `lang !== "en"`, also `select` `translations: { where: { language: lang }, select: { title: true } }`.
  - map results through `localizeItem` (title only here; overview not in list projection). For the `q` search filter, keep matching the base `title` for now (note this limitation in a code comment; full localized search is Phase-2-eligible but not required by the spec).

- [ ] **Step 4: Implement by-id route.** In `/items/:id`:
  - add to `select`: `translations: { where: { language: lang }, select: { title: true, overview: true } }` and for genres select `genre: { select: { tmdbId: true, name: true, translations: { where: { language: lang }, select: { name: true } } } }`.
  - build `const tr = item.translations[0]`; apply `localizeItem({ title, overview }, tr)`; build the genre translation map and use `localizeGenres`. Preserve the BigInt `.toString()` on files.

- [ ] **Step 5: Run — PASS + gates.**
```bash
pnpm --filter @orbix/api test && pnpm --filter @orbix/api typecheck && pnpm --filter @orbix/api lint
```

- [ ] **Step 6: Commit**
```bash
git add apps/api/src/routes/catalog.ts apps/api/src/routes/discovery.ts apps/api/src/routes/catalog.localize.test.ts
git commit -m "feat(api): localize catalog title/overview/genres by profile language"
```

---

### Task 10: Metadata translation population (enrich + backfill job)

**Files:**
- Modify: `packages/core/src/metadata/enrich.ts` (+ test) — accept active languages, return translations
- Modify: `apps/api/src/plugins/queue.ts` — `saveMetadata` persists translations; add `translate-metadata` job + enqueue helper + SSE progress; wire the activation trigger from Task 8 Step 4
- Test: `packages/core/src/metadata/enrich.test.ts`

**Interfaces:**
- Consumes: `TmdbClient` with `language` + `genreList` (Task 7); translation tables (Task 6).
- Produces: `enrichItem(..., { client, cacheImage, saveMetadata, translateClients?: Map<lang, TmdbLike> })` — after base save, for each `(lang, client)` fetch `movie(tmdbId)` and add `{ language, title, overview }` to the `SaveMetadata` input's new `translations` array. `saveMetadata` upserts `MediaItemTranslation` rows. New API helper `enqueueMetadataTranslation(app, language)`.

- [ ] **Step 1: Failing enrich test.** Extend `enrich.test.ts`: with `translateClients = Map([["es", fakeEsClient]])`, assert `saveMetadata` receives `translations: [{ language: "es", title: "<es title>", overview: "<es overview>" }]`.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement enrich.** Add optional `translateClients?: Map<string, TmdbLike>` to `enrichItem` deps; add `translations?: { language: string; title: string; overview?: string }[]` to `SaveMetadataInput`. After Step 5 persist of base, loop the map: `const m = await client.movie(tmdbId); translations.push({ language, title: m.title, overview: m.overview })`; pass `translations` into `saveMetadata`. Tolerate per-language fetch failure (skip that language, do not fail enrichment).

- [ ] **Step 4: Implement `saveMetadata` persistence** in `queue.ts`: after the base upsert, for each `t` in `input.translations ?? []` `prisma.mediaItemTranslation.upsert({ where: { mediaItemId_language: { mediaItemId, language: t.language } }, create/update: { title, overview } })`. Build `translateClients` from the **active content languages** (distinct `Profile.language` ∪ {en}, minus `en`), each `new TmdbClient(token, undefined, tmdbLanguageTag(lang))`.

- [ ] **Step 5: Implement the backfill job.** Add a BullMQ `translate-metadata` job (payload `{ language }`) whose worker: (a) upserts `GenreTranslation` from `client.genreList("movie")` + `genreList("tv")`, (b) iterates all matched `MediaItem` with `tmdbId`, fetches `movie(tmdbId)` in that language, upserts `MediaItemTranslation`; emits progress over the existing EventEmitter (mirror the scan job's pattern incl. done-cache). Export `enqueueMetadataTranslation(app, language)`. Wire it into Task 8 Step 4's patch handler.

- [ ] **Step 6: Run gates.**
```bash
pnpm --filter @orbix/core test && pnpm --filter @orbix/api typecheck && pnpm --filter @orbix/api lint
```

- [ ] **Step 7: Commit**
```bash
git add packages/core/src/metadata/enrich.ts packages/core/src/metadata/enrich.test.ts apps/api/src/plugins/queue.ts apps/api/src/routes/profiles.ts
git commit -m "feat: populate metadata translations on enrich + backfill job"
```

---

### Task 11: Language switcher UI

**Files:**
- Modify: `apps/web/src/pages/ProfilesPage.tsx` (language picker in create/edit profile form)
- Modify: `apps/web/src/pages/LoginPage.tsx` or a shared pre-login shell (a compact switcher on pre-login screens)
- Possibly: `apps/web/src/pages/AdminSettingsPage.tsx` (note: per-profile, so the canonical place is the profile form; a top-bar quick switch is optional)
- Test: covered by E2E (Task 13) + a render test asserting the picker lists `LANGUAGE_LABELS`.

**Interfaces:** Consumes `LANGUAGE_LABELS`, `setActiveLanguage` (Tasks 1–2); profile create/patch `language` field (Task 8).

- [ ] **Step 1:** Add a `<select>` of `SUPPORTED_LANGUAGES` (labels from `LANGUAGE_LABELS`) to the profile create/edit form; include `language` in the POST/PATCH body.
- [ ] **Step 2:** Add a minimal switcher to the pre-login screens calling `setActiveLanguage(code)` (no profile yet → localStorage only).
- [ ] **Step 3:** Gates + commit.
```bash
pnpm --filter @orbix/web typecheck && pnpm --filter @orbix/web lint && pnpm --filter @orbix/web test
git add apps/web/src/pages apps/web/src/components
git commit -m "feat(web): language switcher (profile form + pre-login)"
```

---

### Task 12: Full-suite gate (Phase 1)

- [ ] **Step 1:** From repo root:
```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```
Expected: all green. Fix any cross-package fallout before proceeding.

- [ ] **Step 2: Commit** any fixups: `git commit -am "chore(i18n): phase-1 full-suite green"`.

---

### Task 13: E2E — Spanish end-to-end (throwaway DB only)

**Files:**
- Create: `apps/web/e2e/i18n.spec.ts`

- [ ] **Step 1:** Spec: complete setup → create a profile with language Español → assert a known UI string renders in Spanish (e.g., the sidebar/home heading) and `<html lang="es">`. (Run only against the throwaway e2e DB per the harness rules; `global-setup` wipes accounts/profiles.)
- [ ] **Step 2:** Run with the stack up:
```bash
docker compose up -d postgres redis
pnpm --filter @orbix/web test:e2e i18n.spec.ts
```
- [ ] **Step 3:** Reap dev servers afterward: `pkill -f "tsx.*watch src/server.ts"; pkill -f vite`.
- [ ] **Step 4: Commit.** `git add apps/web/e2e/i18n.spec.ts && git commit -m "test(e2e): Spanish profile renders localized UI"`

**🚢 Phase 1 deliverable: working English + Spanish across UI and catalog metadata.**

---

## PHASE 2 — German, Portuguese, Russian, French

### Task 14: Add the four UI locale bundles

**Files:**
- Create: `apps/web/src/locales/{de,pt,ru,fr}/<every-namespace>.json`

- [ ] **Step 1:** For each of `de, pt, ru, fr`, create a full translation of every namespace bundle that exists for `en` (mirror the key set exactly). Use correct plural categories — **Russian** requires `_one`/`_few`/`_many`/`_other` forms for count keys; i18next derives the category from `Intl.PluralRules`, so provide all forms Russian uses.
- [ ] **Step 2:** The parity test (Task 5) now enforces these locales automatically. Run:
```bash
pnpm --filter @orbix/web exec vitest run src/locales/parity.test.ts
```
Expected: PASS for all six locales × all namespaces.
- [ ] **Step 3:** Manual check of Russian plurals: render `search:results` with counts 1, 2, 5, 21 and confirm correct forms.
- [ ] **Step 4: Commit** per locale (4 commits) or one: `git add apps/web/src/locales && git commit -m "feat(web): add de/pt/ru/fr UI translations"`

---

### Task 15: Activate the four content languages (metadata)

- [ ] **Step 1:** Content-language activation is automatic: when a profile selects `de/pt/ru/fr`, Task 10's patch trigger enqueues `translate-metadata` for that language and new scans include it. No code change needed — verify by selecting each language on a profile (with the stack + a TMDB token) and confirming `MediaItemTranslation`/`GenreTranslation` rows populate and the catalog renders localized titles.
- [ ] **Step 2:** If a one-shot "translate all active languages now" admin affordance is desired, add a button calling `enqueueMetadataTranslation` per active language. (Optional; YAGNI unless requested.)

---

### Task 16: Final full-suite + multilingual smoke

- [ ] **Step 1:** `pnpm typecheck && pnpm lint && pnpm test && pnpm build` — all green.
- [ ] **Step 2:** Smoke each language by switching a profile and spot-checking UI + a localized overview.
- [ ] **Step 3: Commit** any fixups.

**🚢 Phase 2 deliverable: six languages (en, es, de, pt, ru, fr) across UI and catalog metadata.**

---

## Self-Review Notes (coverage vs spec)

- Spec §2 (frontend) → Tasks 1–5, 11. §3 (metadata) → Tasks 6, 7, 9, 10. §4 (backend text) → Task 3 (error codes) + Task 10 (structured payloads). §5 (testing) → Tasks 1–3,5,7–10 unit + 13 e2e. §6 (rollout) → Phase 1 / Phase 2 split. §7 (authoring) → Tasks 4*, 14 (LLM translations).
- Person names / keywords / poster art / rating *codes* intentionally untouched (spec non-goals).
- BigInt + kids-filter invariants explicitly preserved in Tasks 9–10.
