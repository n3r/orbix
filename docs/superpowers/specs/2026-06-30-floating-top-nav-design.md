# Floating Top-Nav Redesign — Design Spec

**Date:** 2026-06-30
**Branch:** `menu-update`
**Status:** Approved (design decisions confirmed via Q&A)

## 1. Goal & motivation

The current navigation is a persistent left **`Sidebar`** (`apps/web/src/components/shell/Sidebar.tsx`) that reads like a B2B SaaS admin panel: a vertical rail with Home, Search, a "Library" section tree, an "Admin" block (Manage/Settings), and a profile footer. We want a **floating, Netflix-style top navigation** that feels like a cinema app.

Target layout:

```
[Orbix logo]   Home · TV · Movies · Shows · Docs …        ♥   🔍   (Avatar)
  left                     center                              right
```

- **Left (sticks left):** Orbix logo → Home.
- **Center (middle):** `Home`, `TV` (placeholder), then the active profile's **catalog categories** as inline links.
- **Right (sticks right):** `♥` Heart (placeholder), `🔍` Search → `/search`, profile **Avatar** → `/account`.

## 2. Confirmed decisions

1. **Catalog category = existing `Section`.** Each profile chooses **which** sections appear in its nav and **in what order** (per-profile, self-service), with a small editor. No new "Category" entity.
2. **Account page is a tabbed hub.** Avatar → `/account`. Profile header + Switch Profile + Logout always; admin-only tabs hold the existing Library-management and Settings UIs; the per-profile menu editor also lives here. Old `/admin/*` routes redirect in.
3. **Catalog renders as inline category links** in the center of the bar (not a dropdown). Overflow collapses into a "More ▾" menu so the bar never wraps.
4. **Floating bar is transparent → solid on scroll** (transparent over a top-gradient scrim at the top of the page, fading to a solid blurred background once scrolled).
5. **Mobile uses a bottom tab bar.** Top bar keeps Logo + Search + Avatar; primary nav (Home, TV, Catalog, Search, Account) moves to a fixed bottom tab bar. The Catalog tab opens a sheet listing the profile's categories.
6. **Admin gating wires up `Account.isAdmin`.** `/auth/me` exposes account-level `isAdmin`; admin tabs/routes require `isAdmin && profile.kind !== "kids"`. (`Account.isAdmin` already defaults `true`, so no setup-wizard change is needed.)
7. **TV and Heart are inert placeholders** — visible, `aria-disabled`, `title="Coming soon"`, no route.

## 3. Data model

New join table in `packages/db/prisma/schema.prisma`:

```prisma
model ProfileMenuEntry {
  id        String  @id @default(cuid())
  profileId String
  sectionId String
  position  Int
  section   Section @relation(fields: [sectionId], references: [id], onDelete: Cascade)

  @@unique([profileId, sectionId])
  @@index([profileId])
}
```

- A back-relation `menuEntries ProfileMenuEntry[]` is added to `Section`.
- **No FK on `profileId`** to a `Profile` row is added beyond what's needed; we keep it a plain column with an index (profiles are referenced by id elsewhere the same way — e.g. `PlaybackState.profileId`). When a profile is deleted, its entries are orphaned but harmless and filtered out at read time; a follow-up cleanup can be added if desired. `onDelete: Cascade` on `section` ensures entries vanish when a section is removed.
- Migration: `pnpm db:migrate` generates a new migration; the api container applies it on boot via `prisma migrate deploy`.

**Resolution semantics (the load-bearing rule):**

- A profile with **zero** entries shows **all** sections in default order (`Section.order`, then library order). Customization is opt-in, so the nav is never empty before anyone configures it.
- A profile with entries shows exactly those sections, in `position` order, **dropping any entry whose section no longer exists**.
- No section-level kids filtering: today all profiles see all sections, and kids safety is enforced per-item by rating. We preserve that — the menu lists sections for every profile kind.

## 4. Core (pure) logic

Add to `packages/core` a pure resolver (framework-agnostic, no DB):

```ts
// packages/core/src/menu/resolve.ts
export interface MenuSection { sectionId: string; name: string; libraryName: string; order: number }
export interface MenuEntry { sectionId: string; position: number }

/** Resolve the ordered catalog menu for a profile.
 *  - no entries  → all sections in default order
 *  - has entries → entries' sections in position order, dropping missing ones
 */
export function resolveProfileMenu(
  sections: MenuSection[],
  entries: MenuEntry[],
): { sectionId: string; name: string; libraryName: string }[]
```

Unit-tested for: empty entries → all (ordered), entries reorder, entry referencing a deleted section is dropped, default order respects `order` then library.

## 5. API

All under the `/api` prefix. The active profile comes from the `orbix_profile` cookie via `activeProfile()`.

- **`GET /auth/me`** (existing, `apps/api/src/routes/auth.ts`) — additionally returns `isAdmin` by looking up the account: `{ accountId, isAdmin }`.
- **`GET /me/menu`** — resolved nav categories for the active profile: `{ items: [{ sectionId, name, libraryName }] }`. Requires auth + an active profile (404/empty-safe). Loads all sections + the profile's `ProfileMenuEntry` rows, calls `resolveProfileMenu`.
- **`GET /me/menu/config`** — for the editor: `{ sections: [{ sectionId, name, libraryName }], enabled: string[] }` where `sections` is every section (default order) and `enabled` is the resolved ordered list of sectionIds currently shown. (When the profile has no entries, `enabled` equals all sections in default order.)
- **`PUT /me/menu`** — body `{ sectionIds: string[] }`. Replaces the active profile's entries transactionally: validate each id is a real section, delete existing rows for the profile, insert `{ position: index }`. Returns the new resolved menu. Self-service (auth + active profile; any profile kind may edit its own menu).

New menu routes live in `apps/api/src/routes/menu.ts`, registered under `/api` in `app.ts`.

**Admin gating.** Add a `requireAdmin(app)` preHandler in `apps/api/src/lib/auth.ts` that 403s unless the session's account has `isAdmin`. Existing admin routes (`libraries.ts`, `settings.ts`, scan, maintenance, match/poster) keep `requireNonKids` **and** add `requireAdmin`. Net rule for admin access: authenticated **and** `account.isAdmin` **and** active profile not kids.

## 6. Web — components & routing

### Shell

- **New `TopNav`** (`apps/web/src/components/shell/TopNav.tsx`): the floating bar. Sections: left logo, center nav, right actions. Reads categories from a new `useMenu()` hook (`GET /me/menu`) and admin status from `useAuthMe()` (`GET /auth/me`). Transparent-over-scrim at `scrollY≈0`, solid+blurred once scrolled (scroll listener with rAF throttle; cleaned up on unmount). Category links target `/library/:sectionId`. Active state by `pathname`. Overflow categories collapse into a "More ▾" menu.
- **New `BottomNav`** (`apps/web/src/components/shell/BottomNav.tsx`, `md:hidden`): fixed bottom tab bar — Home, TV (placeholder), Catalog, Search, Account. The **Catalog** tab opens a bottom sheet listing the profile's categories (same `useMenu()` data).
- **`AppShell`** (`apps/web/src/components/shell/AppShell.tsx`): replace the sidebar/drawer layout with `TopNav` (fixed, full width) + `main` (content flows under the transparent bar; add top padding so non-hero pages aren't clipped) + `BottomNav` (mobile; add bottom padding so content isn't hidden). Keep the TMDB-attribution footer.
- **Remove** `Sidebar.tsx` and the mobile-drawer usage of `TopBar.tsx` (delete `TopBar` if it becomes unused).

### Account hub

- **New `AccountPage`** (`apps/web/src/pages/AccountPage.tsx`) with tabbed sub-navigation:
  - **Overview** (`/account`): profile header (avatar + name), **Switch Profile** (→ `/profiles`), **Log out** (the existing `POST /auth/logout` + `window.location.href="/login"` flow moves here from `Sidebar`). Always shown.
  - **My Menu** (`/account/menu`): the `ProfileMenuEditor`. Always shown (self-service).
  - **Library** (`/account/library`): renders the existing `AdminLibrariesPage` content. Admin only.
  - **Settings** (`/account/settings`): renders the existing `AdminSettingsPage` content. Admin only.
  - Admin tabs hidden when `!isAdmin || profile.kind === "kids"`.
- **`ProfileMenuEditor`** (`apps/web/src/components/account/ProfileMenuEditor.tsx`): lists every section with a checkbox (enabled) and up/down reorder buttons (no drag-and-drop dependency added); Save calls `PUT /me/menu` and invalidates the `["menu"]` query so the nav updates live. Loads from `GET /me/menu/config`.

### Router (`apps/web/src/router.tsx`)

- Add under the `RequireProfile` group: `/account`, `/account/menu`, `/account/library`, `/account/settings` (or a single `/account` route that renders tabs by sub-path — implementer's choice, must be deep-linkable).
- **Redirects:** `/admin/libraries` → `/account/library`, `/admin/settings` → `/account/settings`.
- Keep `AdminLibrariesPage`/`AdminSettingsPage` as the tab bodies (imported by `AccountPage`), not as standalone routed pages.

### Search

- `SearchPage` (`apps/web/src/pages/SearchPage.tsx`) reworked into a **full-page search**: a prominent search bar pinned near the top, **autofocused on mount**. Existing NL-constraint + vector-ranking logic and the `/search` API are unchanged. The nav's search icon simply navigates to `/search`.

### Hooks / types (`apps/web/src/lib/queries.ts`)

- `useMenu()` → `GET /me/menu` (`queryKey: ["menu"]`).
- `useMenuConfig()` → `GET /me/menu/config`.
- `useAuthMe()` → `GET /auth/me` returning `{ accountId, isAdmin }`.
- `saveMenu(sectionIds)` mutation → `PUT /me/menu`.

## 7. Visual direction

- Floating bar height ~56–64px; logo as a wordmark (reuse "Orbix" styling) with room for a future logo image.
- Transparent state: no background, a subtle top-down dark gradient scrim for legibility over hero art; text/icons light.
- Scrolled state: `bg-[var(--surface)]/80` + `backdrop-blur`, hairline bottom border.
- Inline category links use the existing NavLink hover/active treatment (active = brighter text / subtle underline or pill).
- Placeholders (TV, Heart) rendered dimmed with `cursor-default`, `aria-disabled`, `title="Coming soon"`.
- New icons stay inline SVG (no icon library added), consistent with the current codebase.

## 8. Testing

- **Core unit:** `resolveProfileMenu` — default-all, reorder, drop-missing, default ordering.
- **API:** `GET /me/menu` (default vs customized), `PUT /me/menu` (replace + validation of unknown sectionId), `GET /me/menu/config`, `GET /auth/me` returns `isAdmin`, admin routes 403 when `isAdmin` false.
- **Web (vitest):** `ProfileMenuEditor` enable/disable + reorder + save; `TopNav` renders categories and marks active link; admin tabs hidden for non-admin/kids.
- **E2E (Playwright):** update specs that navigated via the sidebar or logged out from it to use the new top nav + `/account`. Add a smoke: customize menu in the editor → nav reflects the new set/order. (Run only against the throwaway e2e DB.)

## 9. Out of scope / deferred

- Real "TV" and "Heart/My List" features (placeholders only now).
- A standalone desktop `/catalog` landing page (desktop uses inline links; mobile uses the Catalog sheet).
- Drag-and-drop reordering (up/down buttons suffice for now).
- Admin-managed per-profile menus for *other* profiles (only self-service for the active profile now).
- Cleanup job for orphaned `ProfileMenuEntry` rows after a profile delete.

## 10. Affected files (summary)

- **DB:** `packages/db/prisma/schema.prisma` (+ migration).
- **Core:** `packages/core/src/menu/resolve.ts` (+ test, + export in index).
- **API:** `apps/api/src/routes/menu.ts` (new), `apps/api/src/routes/auth.ts` (isAdmin), `apps/api/src/lib/auth.ts` (`requireAdmin`), `apps/api/src/app.ts` (register menu routes), admin route files (add `requireAdmin`).
- **Web:** `components/shell/TopNav.tsx`, `BottomNav.tsx` (new), `AppShell.tsx` (rewrite), remove `Sidebar.tsx` (+ maybe `TopBar.tsx`); `pages/AccountPage.tsx` (new), `components/account/ProfileMenuEditor.tsx` (new); `pages/SearchPage.tsx` (rework); `router.tsx`; `lib/queries.ts`, `lib/types.ts`.
- **Tests:** core/api/web unit specs + e2e updates.
