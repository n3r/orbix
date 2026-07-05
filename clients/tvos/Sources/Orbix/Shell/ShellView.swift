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
/// Each section hosts its own `NavigationStack`: `HomeView` and `SearchView`
/// already do internally; the placeholder sections wrap their
/// `ContentUnavailableView` in one so a later phase can push detail routes
/// onto it without restructuring the shell.
///
/// `isScrolled` is owned here and driven by `HomeView`'s scroll offset (the
/// bar goes transparent → near-solid). Only Home scrolls its content under the
/// bar, so leaving Home resets it to `false` — a non-Home section never leaves
/// the bar stuck solid.
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
/// section's content gets an explicit `.onExitCommand` that sends
/// `selection` back to `.home` — the tvOS Menu/Back button's fallback once a
/// `NavigationStack` has nothing left of its own to pop. Without this, Menu
/// at `.search`'s stack root would fall through to the system default (exit
/// to the Home Screen) since there is no bar left to hand focus back to.
/// `.category` keeps its own `.onExitCommand { selection = .home }` as a
/// harmless defensive leftover from the bar-hidden era rather than something
/// newly required — its bar is back, so (like `.tv`/`.wishlist`/`.account`,
/// which have never had one) Menu at its stack root should already have
/// somewhere to hand focus back to without it.
/// Verified live: Menu from the Search landing state returns to the bar (on
/// Home) rather than backgrounding the app; a `NavigationStack` push (e.g. a
/// search result's `TitlePage`) still pops one level per Menu press first, as
/// normal, before this fallback ever fires.
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
            }
        }
        .onChange(of: selection) { _, newValue in
            if newValue != .home { isScrolled = false }
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
            SearchView(model: model)
                .onExitCommand { selection = .home }
        case .tv:
            placeholder(
                title: "Live TV",
                systemImage: "tv",
                message: "Worldwide channels are coming to the TV app in a later phase.",
                id: "section_tv"
            )
        case .category(let libraryId):
            LibraryBrowseView(libraryId: libraryId, libraryName: categoryName(for: libraryId), model: model)
                // Forces a fresh view + `LibraryModel` when switching between
                // categories — same enum case, different associated
                // `libraryId`, so SwiftUI would otherwise reuse the existing
                // view/state rather than reloading for the new library.
                .id(libraryId)
                .onExitCommand { selection = .home }
        case .wishlist:
            placeholder(
                title: "My List",
                systemImage: "heart",
                message: "Your watch-later list is coming to the TV app in a later phase.",
                id: "section_wishlist"
            )
        case .account:
            placeholder(
                title: "Account",
                systemImage: "person.crop.circle",
                message: "Profile and account settings are coming to the TV app in a later phase.",
                id: "section_account"
            )
        }
    }

    /// The web `LibraryPage`'s `<h1>` is actually always the static
    /// `t("catalog:browse.title")` ("Browse"), not the library's name — this
    /// looks up the real name from the profile's menu instead (more useful
    /// heading on TV, where the category is also named in the top bar), but
    /// keeps "Browse" as the fallback for parity if a library ever isn't in
    /// `menuItems` (e.g. a stale/removed category).
    private func categoryName(for libraryId: String) -> String {
        model.menuItems.first { $0.libraryId == libraryId }?.name ?? "Browse"
    }

    /// A section placeholder for the not-yet-built destinations. Wrapped in a
    /// `NavigationStack` so each section keeps its own navigation state (the
    /// same shape `HomeView`/`SearchView` already have internally).
    private func placeholder(title: String, systemImage: String, message: String, id: String) -> some View {
        NavigationStack {
            ContentUnavailableView {
                Label(title, systemImage: systemImage)
            } description: {
                Text(message)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityIdentifier(id)
        }
    }
}

#Preview {
    ShellView(model: AppModel())
}
