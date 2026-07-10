import OrbixKit
import SwiftUI

/// The app shell for the `.ready` phase: a custom web-parity top bar
/// (`OrbixTopBar`) overlaid on the selected section's content, replacing the
/// stock tvOS `TabView` that `RootView` used before. Owns the current
/// `selection` and renders exactly one section at a time.
///
/// Content sits in a `ZStack(alignment: .top)` *under* the transparent bar,
/// so a section's billboard (Phase 2) can ride edge-to-edge beneath it. The
/// bar is its own `.focusSection()`, so the tvOS focus engine keeps
/// left/right movement in the bar and drops into the section's content on a
/// down press.
///
/// Each section hosts its own `NavigationStack` — `HomeView`, `SearchView`,
/// `LibraryBrowseView`, `WishlistView`, `TvHomeView`, and (Phase 5 Task 3)
/// `AccountView` all own one directly, so a later phase can push detail
/// routes from any of them without restructuring the shell. As of Task 3
/// there are no more bare-`ContentUnavailableView` placeholder sections left
/// in this switch.
///
/// `isScrolled` is owned here and driven by whichever section is on screen's
/// own scroll offset (the bar goes transparent → near-solid) — `HomeView`,
/// `LibraryBrowseView`, and `WishlistView` each thread it through via
/// `SectionScrollDetector` (P5 Task 6; before that fix only `HomeView` drove
/// it, so scrolling Library/Wishlist never re-solidified the bar — it just
/// showed whatever `isScrolled` Home had last left behind). `.tv` and
/// `.account` don't scroll their content under the bar today, so they're not
/// wired to it (left as a follow-up if either grows a scrolling root). Every
/// section switch resets `isScrolled = false` — each section starts fresh at
/// its own scroll top, so a section can never inherit a stuck-solid (or
/// stuck-transparent) bar from whatever the previously active section had
/// scrolled to.
///
/// **Bar suppression is `.search`-only.** `SearchView` uses SwiftUI's
/// `.searchable`, whose system chrome (title + search field + on-screen
/// keyboard grid) renders at the same top-of-screen position as this
/// `OrbixTopBar` overlay — the two visibly collide
/// (`.superpowers/sdd/phase2-library.png` is the recorded artifact of the
/// same collision when `LibraryBrowseView` also used `.searchable`). Padding
/// the section's own content down would not fix this: the collision is
/// between two independent top-of-screen chromes, not between the bar and
/// scrollable content. So `showsTopBar` simply omits the overlay for
/// `.search` — it reads as its own full-screen surface, the way a modal
/// would on the web, rather than a page under a fixed nav.
///
/// **`.category` (library) keeps the bar.** On the web, `LibraryPage` renders
/// under the persistent `TopNav` — the nav *is* the category switcher, and
/// hiding it on a library page would be a parity regression (a user could
/// switch Movies → Series from Home but not from within a library itself).
/// The `.searchable` collision that used to justify hiding it here too is
/// gone: `LibraryBrowseView` no longer uses `.searchable` at all — the web's
/// on-page filter `<Input>` (next to the sort `<select>`) is ported as an
/// ordinary in-content `TextField` in its controls row, so there is no
/// second top-of-screen chrome left to collide with the bar.
///
/// Hiding the bar for `.search` removes it (and the "down press drops from
/// bar into content" focus handoff) from the hierarchy entirely, so that
/// section needs its own Menu/Back fallback back to `.home` too — see
/// `SearchView`'s `onMenuExit` below for how that's wired now.
///
/// **Every non-Home hub section (`.tv`, `.category`, `.wishlist`, `.account`,
/// `.search`) needs a Menu-walk fallback to `.home`** per spec §6 "Menu
/// walks: player → page → section root → Home" — at `.home` itself, system
/// behavior (background) stands, same as always. Two distinct situations
/// both have to route there, and neither can be solved by one
/// `.onExitCommand` slapped on an outer ancestor (verified live, the hard
/// way — see below):
///
/// 1. **Menu pressed with focus still on the bar** (`.tv`/`.category`/
///    `.wishlist`/`.account`, whose bar is visible per `showsTopBar`) —
///    backgrounds the app if nothing catches it (gate-reproduced against
///    Wishlist). Fixed by attaching `.onExitCommand { selection = .home }`
///    directly to `OrbixTopBar` in `body` below — safe there because the bar
///    has no `NavigationStack` of its own to ever need a Back-pop first.
///
/// 2. **Menu pressed with focus already in a section's content** — must pop
///    that section's own `NavigationStack` one level at a time (e.g. a pushed
///    `TitlePage`) before ever falling through to `.home`. This is *not* a
///    matter of attachment position the way situation 1 is: verified live
///    that **any** `.onExitCommand` anywhere in a `NavigationStack`'s ancestor
///    chain — even attached immediately adjacent to it, no wrapping view in
///    between — intercepts Menu unconditionally and disables that stack's own
///    pop-on-Menu entirely for its whole subtree, at any push depth. (Proof:
///    `HomeView`'s stack has no `.onExitCommand` anywhere near it, and a
///    pushed `TitlePage` there pops correctly on the first Menu press; every
///    section that had one nearby — including the original defensive
///    `.category`-only handler this replaced — instead jumped straight to
///    `.home`, skipping the pop.) So the pop-vs-go-home decision can't be left
///    to implicit priority between an `.onExitCommand` and the stack; it has
///    to be made explicitly, using that section's own `path`. `SearchView`,
///    `LibraryBrowseView`, `WishlistView`, and (Phase 4 Task 4) `TvHomeView`
///    each now take an `onMenuExit: () -> Void` and attach their *own*
///    `.onExitCommand` internally: pop `path.removeLast()` when it's
///    non-empty, else call `onMenuExit` (set to `{ selection = .home }`
///    below). `.account` (Phase 5 Task 3: `AccountView`) follows the same
///    per-section pattern but simpler — its `NavigationStack` has no
///    `navigationDestination` at all, hence no `path` that could ever be
///    non-empty, so its own `.onExitCommand` calls `onMenuExit`
///    unconditionally rather than checking `path.isEmpty` first.
///
/// Verified live: Menu from Wishlist's root content → Home; Menu with focus
/// on the bar at Wishlist → Home (not background); pushing a `TitlePage` from
/// a library grid and pressing Menu pops back to the grid first, and only a
/// second Menu press at that grid's root returns to `.home`.
struct ShellView: View {
    let model: AppModel

    @State private var selection: AppSection = .home
    @State private var isScrolled = false

    var body: some View {
        ZStack(alignment: .top) {
            OrbixColor.bg.ignoresSafeArea()

            content

            if showsTopBar {
                OrbixTopBar(model: model, selection: $selection, isScrolled: isScrolled)
                    // Menu-walk fallback for focus still on the bar at a
                    // non-Home section — see the type doc comment for why
                    // this needs its own attachment point (separate from
                    // `sectionContent`'s below) and why it's safe here: the
                    // bar has no `NavigationStack` of its own to pop first.
                    .onExitCommand { selection = .home }
            }
        }
        // Every section switch resets `isScrolled` — including switching
        // *into* Home, which previously kept whatever value a non-Home
        // section had last left it at (see the type doc comment). Each
        // section owns fresh scroll state.
        .onChange(of: selection) { _, _ in
            isScrolled = false
        }
    }

    /// `false` for `.search` only — see the type's doc comment on why the bar
    /// is suppressed there and *not* for `.category`, which renders it like
    /// every other hub section (web parity: the nav stays visible, and
    /// doubles as the category switcher, on library pages).
    private var showsTopBar: Bool {
        switch selection {
        case .search:
            return false
        default:
            return true
        }
    }

    @ViewBuilder
    private var content: some View {
        switch selection {
        case .home:
            HomeView(model: model, isScrolled: $isScrolled)
        case .search:
            // Pops its own `path` first, falling to `.home` only once empty —
            // see the type doc comment for why this can't just be an
            // `.onExitCommand` attached out here instead.
            SearchView(model: model, onMenuExit: { selection = .home })
        case .tv:
            // Pops its own `path` first (only pushed route today is
            // `TvGuideRoute`), falling to `.home` only once empty — see the
            // type doc comment for why this can't just be an
            // `.onExitCommand` attached out here instead.
            TvHomeView(model: model, onMenuExit: { selection = .home })
        case .category(let libraryId):
            LibraryBrowseView(
                libraryId: libraryId,
                libraryName: categoryName(for: libraryId),
                model: model,
                isScrolled: $isScrolled,
                onMenuExit: { selection = .home }
            )
            // Forces a fresh view + `LibraryModel` when switching between
            // categories — same enum case, different associated
            // `libraryId`, so SwiftUI would otherwise reuse the existing
            // view/state rather than reloading for the new library.
            .id(libraryId)
        case .wishlist:
            WishlistView(model: model, isScrolled: $isScrolled, onMenuExit: { selection = .home })
        case .account:
            // Pops nothing (this section pushes no routes at all) — falls
            // straight to `.home` on Menu; see the type doc comment for why
            // this section's own `.onExitCommand` can be unconditional,
            // unlike `SearchView`/`LibraryBrowseView`/`WishlistView`/
            // `TvHomeView`'s `path.isEmpty` check.
            AccountView(model: model, onMenuExit: { selection = .home })
        }
    }

    /// The web `LibraryPage`'s `<h1>` is actually always the static
    /// `t("catalog:browse.title")` ("Browse"), not the library's name — this
    /// looks up the real name from the profile's menu instead (more useful
    /// heading on TV, where the category is also named in the top bar), but
    /// keeps "Browse" as the fallback for parity if a library ever isn't in
    /// `menuItems` (e.g. a stale/removed category).
    private func categoryName(for libraryId: String) -> String {
        model.menuItems.first { $0.libraryId == libraryId }?.name ?? L10n.t("catalog.browse.title")
    }
}

#Preview {
    ShellView(model: AppModel())
}
