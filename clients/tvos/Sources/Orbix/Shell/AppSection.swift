import Foundation

/// The top-level destinations reachable from the custom web-parity top bar
/// (`OrbixTopBar`) — the tvOS analogue of the web `TopNav`'s links
/// (`apps/web/src/components/shell/TopNav.tsx`). One case per bar item:
///
/// - `.home` / `.search` — the M3 screens (`HomeView` / `SearchView`), each
///   already owning its own `NavigationStack`.
/// - `.tv` — the worldwide-channels section (hidden for kids profiles;
///   filled in a later phase).
/// - `.category(String)` — a catalog library nav entry keyed by its
///   `MenuItem.libraryId` (the web `/library/:id` route).
/// - `.wishlist` — the per-profile watch-later list (web `/wishlist`).
/// - `.account` — the profile/account hub (web `/account`).
///
/// `.tv`, `.category`, `.wishlist`, and `.account` render placeholders in
/// this phase; the real screens land in Phases 2–5. `Hashable` so it can
/// back a `@State selection` and drive equality checks for the selected
/// item's highlight state in `OrbixTopBar` (the associated `String` on
/// `.category` is `Hashable`, so the whole enum synthesizes cleanly).
enum AppSection: Hashable {
    case home
    case tv
    case category(String)
    case wishlist
    case search
    case account
}
