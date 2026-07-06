import OrbixKit
import SwiftUI

/// SP2 Phase 2 Task 5 library browse screen, reached by selecting a catalog
/// category from `OrbixTopBar` (`AppSection.category(libraryId)`) — tvOS port
/// of `apps/web/src/pages/LibraryPage.tsx`. Loads
/// `GET /api/libraries/:id/items?sort=&q=` via `LibraryModel` and renders a
/// poster grid reusing `Home/PosterCard`'s 2:3 card and `SearchView`'s grid
/// lockup.
///
/// Two web controls have no tvOS equivalent and are adapted rather than
/// ported 1:1:
/// - the web `<select>` (sort) → a row of three focusable **chip** buttons
///   (`LibrarySort.allCases`), since tvOS has no native picker control;
/// - the web `<Input>` (title filter) → an on-page `TextField` (`filterField`)
///   sitting in the controls row next to the sort chips, exactly where the
///   web renders its `<Input>` beside the `<select>` (`LibraryPage.tsx`).
///   **Not** `.searchable(text:)`: that system chrome renders at the same
///   top-of-screen position as `ShellView`'s `OrbixTopBar` and visibly
///   collided with it (`.superpowers/sdd/phase2-library.png`) — an on-page
///   field avoids a second top-of-screen surface entirely, and doubles as
///   truer web parity (the web filter is an inline `<Input>`, not a modal
///   search overlay). Selecting it still opens the system on-screen keyboard
///   like any tvOS `TextField` (see the manual-entry field in
///   `RootView.swift` for the same pattern); debounced in `LibraryModel` so
///   the keyboard's keystrokes don't each fire a request (mirrors
///   `SearchView`/`SearchModel`'s idiom exactly) — `queryChanged` is
///   unchanged, only what feeds `query` moved from `.searchable` to this
///   field.
///
/// Owns its own `NavigationStack` — `ShellView` gives this view `.id(libraryId)`
/// so switching categories in the top bar (same `.category` `AppSection`
/// case, different associated `libraryId`) tears down and rebuilds this view
/// (and `LibraryModel`, and `path`) from scratch rather than reusing stale
/// state for the newly-selected library.
struct LibraryBrowseView: View {
    let libraryId: String
    let libraryName: String
    let model: AppModel

    /// Called on Menu when this section's own `path` is already empty — see
    /// `ShellView`'s type doc comment for why the Menu-walk fallback to
    /// `.home` has to be decided here, against this view's own `path`, rather
    /// than via an `.onExitCommand` `ShellView` attaches from outside.
    let onMenuExit: () -> Void

    @State private var libraryModel = LibraryModel()
    @State private var imageLoader = ImageLoader()
    @State private var path = NavigationPath()
    @State private var sort: LibrarySort = .title
    @State private var query = ""

    /// Identical column lockup to `SearchView.gridColumns` — same 2:3 card,
    /// same adaptive width, so the two poster grids feel like one system.
    private let gridColumns = [
        GridItem(.adaptive(minimum: 220, maximum: 220), spacing: 32)
    ]

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if let client = model.client {
                    content(client: client)
                        .task { await libraryModel.load(client: client, libraryId: libraryId, sort: sort, q: query) }
                } else {
                    // Defensive only: ShellView only routes to a `.category`
                    // section once `model.client` is non-nil — same
                    // invariant HomeView/SearchView's fallbacks document.
                    ProgressView()
                }
            }
            // No `.navigationTitle`/`.searchable` here — both were system
            // top-of-screen chrome that collided with `OrbixTopBar` (see the
            // type doc comment); the in-content `heading` below already
            // shows `libraryName`, and `filterField` replaces `.searchable`.
            .onChange(of: query) { _, newValue in
                guard let client = model.client else { return }
                libraryModel.queryChanged(newValue, client: client, libraryId: libraryId, sort: sort)
            }
            .onChange(of: sort) { _, newValue in
                guard let client = model.client else { return }
                libraryModel.sortChanged(to: newValue, client: client, libraryId: libraryId, q: query)
            }
            .navigationDestination(for: TitleRoute.self) { route in
                TitlePage(itemId: route.itemId, model: model, path: $path, autoplay: route.autoplay)
            }
        }
        // Pop one level of `path` per Menu press before ever falling through
        // to `onMenuExit` — see `ShellView`'s type doc comment for why this
        // has to be an explicit `path.isEmpty` check here rather than relying
        // on any implicit priority between this and the stack's own pop.
        .onExitCommand {
            if path.isEmpty {
                onMenuExit()
            } else {
                path.removeLast()
            }
        }
    }

    // MARK: - Content

    /// `OrbixTopBar` renders again for `.category` (see `ShellView`'s doc
    /// comment on `showsTopBar`) — unlike Home's billboard, this page has no
    /// hero art meant to bleed under it, so its `ScrollView` does *not*
    /// `.ignoresSafeArea`, and this top padding must clear the bar's full
    /// rendered height rather than deliberately underlap it. The bar itself
    /// (`OrbixTopBar.body`) adds 24pt vertical padding above and below a
    /// ~41pt-tall content row (its tallest label is 34pt tracked text) beyond
    /// the safe area, i.e. ~90pt; 140 leaves a clean ~50pt gap below it
    /// instead of the heading brushing up against it.
    private static let contentTopPadding: CGFloat = 140

    /// Heading + controls row (filter field + sort chips) stay mounted across
    /// every `loadState` (web always renders its `<h1>` and controls row
    /// regardless of loading/error/empty), so only the region below them
    /// switches on loading/error/empty/loaded.
    @ViewBuilder
    private func content(client: OrbixClient) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 32) {
                heading
                controlsRow

                switch libraryModel.loadState {
                case .loading:
                    skeletonGrid
                case .error(let message):
                    errorView(message: message, client: client)
                case .empty:
                    emptyView
                case .loaded(let items):
                    grid(items)
                }
            }
            .padding(.horizontal, 64)
            .padding(.top, Self.contentTopPadding)
            .padding(.bottom, 80)
        }
        .accessibilityIdentifier("libraryScroll")
    }

    private var heading: some View {
        Text(libraryName)
            .font(OrbixType.rowHeading)
            .foregroundStyle(OrbixColor.text)
            .accessibilityIdentifier("libraryHeading")
    }

    // MARK: - Controls row (web `<Input>` filter + `<select>` sort)

    /// Filter field + sort chips, side by side, matching the web controls
    /// row's `<Input>` then `<select>` order (`LibraryPage.tsx`). Both are
    /// one `.focusSection()` — the filter field joins the sort chips' focus
    /// row rather than getting its own adjacent section, since visually
    /// they're one horizontal row and this reads as a single left↔right
    /// sweep for the remote (verified live: focus moves cleanly field→chips
    /// and back, same as any other single-row `.focusSection()` in this app).
    private var controlsRow: some View {
        HStack(spacing: 16) {
            filterField
            sortChips
        }
        .focusSection()
        .accessibilityIdentifier("libraryControlsRow")
    }

    /// The web `<Input>` title filter, ported as an on-page `TextField`
    /// rather than `.searchable` — see the type doc comment for why. Bound to
    /// the same `query` state `.searchable` used to be, so
    /// `LibraryModel.queryChanged`'s debounce (wired via `.onChange(of: query)`
    /// in `body`) keeps working untouched; only the source of `query` moved.
    /// Selecting it opens the system on-screen keyboard like any tvOS
    /// `TextField` (the `RootView.swift` manual-entry field is the same
    /// pattern). Prompt copy is the web's actual placeholder string
    /// (`catalog:browse.searchPlaceholder` in `apps/web/src/locales/en/catalog.json`),
    /// not a generic "Filter" — reused verbatim for parity.
    private var filterField: some View {
        TextField("", text: $query, prompt: Text("Search titles…").foregroundStyle(OrbixColor.textDim))
            .textFieldStyle(.plain)
            .font(.system(size: 24))
            .foregroundStyle(OrbixColor.text)
            .padding(.horizontal, 20)
            .padding(.vertical, 14)
            .frame(width: 360)
            .background(OrbixColor.surface2, in: RoundedRectangle(cornerRadius: OrbixRadius.sm, style: .continuous))
            .accessibilityIdentifier("libraryFilterField")
    }

    // MARK: - Sort chips (web `<select>` → segmented chip row)

    private var sortChips: some View {
        HStack(spacing: 16) {
            ForEach(LibrarySort.allCases, id: \.self) { option in
                sortChip(option)
            }
        }
        .accessibilityIdentifier("librarySortChips")
    }

    private func sortChip(_ option: LibrarySort) -> some View {
        let isSelected = sort == option
        return Button {
            sort = option
        } label: {
            Text(option.label)
                .font(.system(size: 24, weight: isSelected ? .semibold : .regular))
        }
        .buttonStyle(SortChipStyle(isSelected: isSelected))
        .accessibilityIdentifier("librarySortChip_\(option.rawValue)")
    }

    // MARK: - Grid / skeleton / empty / error

    private func grid(_ items: [MediaCard]) -> some View {
        LazyVGrid(columns: gridColumns, alignment: .leading, spacing: 40) {
            ForEach(items, id: \.id) { card in
                PosterCard(card: card, baseURL: model.baseURL, imageLoader: imageLoader) {
                    select(card)
                }
            }
        }
        .focusSection()
        .accessibilityIdentifier("libraryGrid")
    }

    /// ~21 tiles, matching web's `Array.from({length:21})`. Uses a plain
    /// `2:3` `SkeletonView` (rather than duplicating `PosterCard`'s private
    /// poster-size constants) so the tile still sizes with the adaptive grid
    /// column exactly like a real `PosterCard` would.
    private var skeletonGrid: some View {
        LazyVGrid(columns: gridColumns, alignment: .leading, spacing: 40) {
            ForEach(0..<21, id: \.self) { _ in
                VStack(alignment: .leading, spacing: 10) {
                    SkeletonView(cornerRadius: OrbixRadius.sm)
                        .aspectRatio(2.0 / 3.0, contentMode: .fit)
                    SkeletonView()
                        .frame(width: 140, height: 18)
                }
            }
        }
        .allowsHitTesting(false)
        .accessibilityIdentifier("librarySkeleton")
    }

    private var emptyView: some View {
        ContentUnavailableView {
            Label("No items found", systemImage: "square.stack")
        } description: {
            Text("Try a different search, or check back after your next library scan.")
        }
        .padding(.top, 60)
        .accessibilityIdentifier("libraryEmptyState")
    }

    private func errorView(message: String, client: OrbixClient) -> some View {
        ContentUnavailableView {
            Label("Couldn't load titles", systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            Button("Retry") {
                Task { await libraryModel.load(client: client, libraryId: libraryId, sort: sort, q: query) }
            }
            .accessibilityIdentifier("libraryRetryButton")
        }
        .padding(.top, 60)
        .accessibilityIdentifier("libraryErrorState")
    }

    // MARK: - Navigation

    /// Pushes the title/detail page for the selected card — same `TitleRoute`
    /// destination and push mechanics as `HomeView.select`/`SearchView.select`.
    private func select(_ card: MediaCard) {
        path.append(TitleRoute(itemId: card.id))
    }
}

/// The server's three allowed `sort` values
/// (`apps/api/src/routes/catalog.ts`'s `allowedSorts`), as a segmented chip
/// row. Chip labels are intentionally shorter than the web `<select>`'s
/// option text ("Title (A–Z)" / "Recently Added" / "Year") — these sit in a
/// compact horizontal row read at 10 feet rather than an expanded dropdown,
/// so "Title" / "Added" / "Year" read just as clearly at a fraction of the
/// width.
enum LibrarySort: String, CaseIterable {
    case title, added, year

    var label: String {
        switch self {
        case .title: return "Title"
        case .added: return "Added"
        case .year: return "Year"
        }
    }
}

/// A sort chip's focus/selection styling. Like `BoxArtCardStyle`/
/// `ProfileTileButtonStyle`, this disables tvOS's automatic focus platter
/// (`.focusEffectDisabled()`): a bright system platter drawn behind a chip
/// that already carries its own solid fill (clear/bordered when idle, accent
/// when selected) would double up against that fill rather than read as one
/// cohesive control, the same clash those two styles document. In its place:
/// a focused chip goes fully white (fill + text) and scales up slightly —
/// unambiguous regardless of selection — while an unfocused-but-selected chip
/// is tinted `OrbixColor.accent` (the brief's explicit requirement) and an
/// idle chip sits on `OrbixColor.surface` with a thin `OrbixColor.surface2`
/// border (the web `<select>`'s own idle treatment).
///
/// (These are still comfortably tap-target-sized text buttons, not tiny
/// artwork tiles, so a system platter *would* have been visually tolerable —
/// unlike a poster/box-art card — but the accent-tinted selected state reads
/// more clearly without one competing for the same corner radius.)
private struct SortChipStyle: ButtonStyle {
    let isSelected: Bool
    @Environment(\.isFocused) private var isFocused

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(isFocused ? Color.white : (isSelected ? Color.white : OrbixColor.textDim))
            .padding(.horizontal, 28)
            .padding(.vertical, 14)
            .background(background, in: RoundedRectangle(cornerRadius: OrbixRadius.sm, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: OrbixRadius.sm, style: .continuous)
                    .strokeBorder(idleBorder, lineWidth: isSelected || isFocused ? 0 : 1)
            )
            .overlay(
                RoundedRectangle(cornerRadius: OrbixRadius.sm, style: .continuous)
                    .strokeBorder(Color.white, lineWidth: isFocused ? 3 : 0)
            )
            .scaleEffect(isFocused ? 1.06 : 1.0)
            .animation(.easeOut(duration: 0.15), value: isFocused)
            .focusEffectDisabled()
    }

    private var background: Color {
        isFocused ? Color.white.opacity(0.25) : (isSelected ? OrbixColor.accent : OrbixColor.surface)
    }

    private var idleBorder: Color { OrbixColor.surface2 }
}

/// Drives `LibraryBrowseView`: loads `GET /api/libraries/:id/items` and
/// exposes a single `loadState`, mirroring `HomeModel`/`SearchModel`'s shape
/// so loading/error/empty/loaded can't drift out of sync. Query-text changes
/// are debounced (the `SearchModel.queryChanged` cancel-previous `Task`
/// idiom, verbatim); sort-chip changes are a discrete button press (not
/// typed text) so they skip the debounce sleep but still go through the same
/// cancel-previous `Task` so a slow in-flight fetch for a stale sort/query
/// combination can never clobber a newer one.
@MainActor
@Observable
final class LibraryModel {
    enum LoadState: Equatable {
        case loading
        case error(String)
        case empty
        case loaded([MediaCard])
    }

    /// Debounce delay after the query text last changes before
    /// `libraryItems` actually fires — same rationale and value as
    /// `SearchModel.debounceNanoseconds`.
    private static let debounceNanoseconds: UInt64 = 350_000_000

    private(set) var items: [MediaCard] = []
    private(set) var isLoading = false
    private(set) var loadError: String?

    /// Flips to `true` once the first `load` attempt (success or failure)
    /// completes — same reasoning as `HomeModel.hasLoaded`: without it, a
    /// library with genuinely zero items would be indistinguishable from
    /// "hasn't loaded yet" for the one frame before `.task` resolves.
    private(set) var hasLoaded = false

    /// The debounce-then-fetch (or discrete sort-change fetch) `Task` most
    /// recently started, if one is still pending or in flight. Cancelled at
    /// the top of every `queryChanged`/`sortChanged` call, so at most one is
    /// ever running. `nonisolated(unsafe)`: mirrors `SearchModel.pendingTask`
    /// — `deinit` on a `@MainActor` class is itself nonisolated, so
    /// cancelling this from `deinit` needs the escape hatch; safe because
    /// nothing else can still be calling into this instance once `deinit` runs.
    private nonisolated(unsafe) var pendingTask: Task<Void, Never>?

    init() {}

    deinit {
        pendingTask?.cancel()
    }

    var loadState: LoadState {
        guard items.isEmpty else { return .loaded(items) }
        if isLoading || !hasLoaded { return .loading }
        if let loadError { return .error(loadError) }
        return .empty
    }

    /// The view's initial `.task` and the error state's Retry button: fetches
    /// immediately (no debounce), guarded against re-entrancy via the shared
    /// `pendingTask` slot — a sort/filter change while initial load or a retry
    /// is in flight will cancel the stale fetch and replace it with the newer
    /// one, preventing stale responses from clobbering fresh state.
    func load(client: OrbixClient, libraryId: String, sort: LibrarySort, q: String) async {
        pendingTask?.cancel()
        let task = Task { [weak self] in
            guard let self, !Task.isCancelled else { return }
            await self.performLoad(client: client, libraryId: libraryId, sort: sort, q: q)
        }
        isLoading = true
        loadError = nil
        pendingTask = task
        await task.value
    }

    /// Sort-chip selection.
    func sortChanged(to sort: LibrarySort, client: OrbixClient, libraryId: String, q: String) {
        pendingTask?.cancel()
        isLoading = true
        loadError = nil
        pendingTask = Task { [weak self] in
            guard let self, !Task.isCancelled else { return }
            await self.performLoad(client: client, libraryId: libraryId, sort: sort, q: q)
        }
    }

    /// `filterField` text change (one call per keystroke on the system
    /// keyboard). Mirrors `SearchModel.queryChanged` exactly: cancel
    /// whatever's pending, then restart a fresh `debounceNanoseconds` timer
    /// before actually calling `libraryItems`. Unlike `SearchModel`, an empty
    /// query is itself a valid, meaningful request here (it's "the whole
    /// library, sorted" — `libraryItems` treats `q: ""` as "no filter"), so
    /// this always schedules a fetch rather than short-circuiting to a
    /// prompt state.
    func queryChanged(_ text: String, client: OrbixClient, libraryId: String, sort: LibrarySort) {
        pendingTask?.cancel()
        isLoading = true
        loadError = nil
        pendingTask = Task { [weak self] in
            do {
                try await Task.sleep(nanoseconds: Self.debounceNanoseconds)
            } catch {
                return // cancelled before the debounce elapsed
            }
            guard let self, !Task.isCancelled else { return }
            await self.performLoad(client: client, libraryId: libraryId, sort: sort, q: text)
        }
    }

    private func performLoad(client: OrbixClient, libraryId: String, sort: LibrarySort, q: String) async {
        let trimmed = q.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let fetched = try await client.libraryItems(id: libraryId, sort: sort.rawValue, q: trimmed)
            // A newer queryChanged()/sortChanged() call may have cancelled
            // this task (and started its own) while the request was in
            // flight — don't let a slow, superseded response clobber newer
            // state.
            guard !Task.isCancelled else { return }
            items = fetched
            loadError = nil
        } catch {
            guard !Task.isCancelled else { return }
            loadError = "Couldn't load titles: \(error)"
            items = []
        }
        isLoading = false
        hasLoaded = true
    }
}

#Preview {
    LibraryBrowseView(libraryId: "lib_1", libraryName: "Movies", model: AppModel(), onMenuExit: {})
}
