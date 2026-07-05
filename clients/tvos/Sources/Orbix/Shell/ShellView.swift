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
struct ShellView: View {
    let model: AppModel

    @State private var selection: AppSection = .home
    @State private var isScrolled = false

    var body: some View {
        ZStack(alignment: .top) {
            OrbixColor.bg.ignoresSafeArea()

            content

            OrbixTopBar(model: model, selection: $selection, isScrolled: isScrolled)
        }
        .onChange(of: selection) { _, newValue in
            if newValue != .home { isScrolled = false }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch selection {
        case .home:
            HomeView(model: model, isScrolled: $isScrolled)
        case .search:
            SearchView(model: model)
        case .tv:
            placeholder(
                title: "Live TV",
                systemImage: "tv",
                message: "Worldwide channels are coming to the TV app in a later phase.",
                id: "section_tv"
            )
        case .category(let libraryId):
            placeholder(
                title: categoryName(for: libraryId),
                systemImage: "square.stack",
                message: "Browsing this library on tvOS is coming in a later phase.",
                id: "section_category"
            )
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

    private func categoryName(for libraryId: String) -> String {
        model.menuItems.first { $0.libraryId == libraryId }?.name ?? "Library"
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
