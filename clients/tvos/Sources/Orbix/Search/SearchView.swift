import OrbixKit
import SwiftUI

/// SP2 M3 Task 5 search screen (Phase 2 Task 6 restyled it to web parity),
/// reached via the "Search" icon in `OrbixTopBar` / `AppSection.search`.
/// Free-text query against `GET /api/search` (`OrbixClient.search(query:)`),
/// debounced so the system keyboard's keystrokes don't each fire a request
/// (see `SearchModel.queryChanged`); results render as a focusable grid of
/// `PosterCard`s, same lockup as `HomeView`'s rails / `LibraryBrowseView`'s
/// grid.
///
/// Web parity (`apps/web/src/pages/SearchPage.tsx`): a teaching landing state
/// before any query, a result-count + semantic/keyword mode badge above the
/// grid, prior results kept visible (dimmed) while a re-search is in flight
/// instead of flashing empty, and a poster-shaped skeleton grid (not a
/// spinner) for the very first search.
///
/// Uses SwiftUI's `.searchable` — the tvOS-idiomatic search affordance as of
/// tvOS 17 (a system-drawn search field that presents the system keyboard on
/// focus; no hand-rolled `TextField`/keyboard handling needed). Owns its own
/// `NavigationStack` + `path`, entirely independent from `HomeView`'s: each
/// tab in a tvOS `TabView` conventionally keeps its own navigation state, and
/// nothing about search's `TitleRoute` push destination (an identical
/// registration to `HomeView`'s — a series result opens its title page, whose
/// seasons/episodes render inline) needs to share a stack with Home to work
/// correctly.
///
/// The system `.searchable` chrome (title + search field + on-screen
/// keyboard grid) renders at the top of the screen, the same place
/// `ShellView`'s `OrbixTopBar` overlay renders — the two collide (see
/// `.superpowers/sdd/phase2-library.png`, the same root cause on the Library
/// screen's `.searchable`). `ShellView` resolves this by not rendering
/// `OrbixTopBar` while `.search` (or `.category`) is selected; see its doc
/// comment for the Menu-button fallback that keeps the user from getting
/// stranded with the bar hidden.
struct SearchView: View {
    let model: AppModel

    @State private var searchModel = SearchModel()
    @State private var imageLoader = ImageLoader()
    @State private var path = NavigationPath()
    @State private var query = ""

    private let gridColumns = [
        GridItem(.adaptive(minimum: 220, maximum: 220), spacing: 32)
    ]

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if let client = model.client {
                    content(client: client)
                } else {
                    // Defensive only: RootView only routes to a TabView
                    // containing SearchView once `model.client` is non-nil —
                    // same invariant HomeView/TitlePage's fallbacks document.
                    ProgressView()
                }
            }
            .navigationTitle("Search")
            .searchable(text: $query, prompt: "Movies, shows, genres…")
            .onChange(of: query) { _, newValue in
                guard let client = model.client else { return }
                searchModel.queryChanged(newValue, client: client)
            }
            .navigationDestination(for: TitleRoute.self) { route in
                TitlePage(itemId: route.itemId, model: model, path: $path, autoplay: route.autoplay)
            }
        }
    }

    @ViewBuilder
    private func content(client: OrbixClient) -> some View {
        switch searchModel.loadState(for: query) {
        case .prompt:
            promptView
        case .firstSearchLoading:
            firstSearchSkeleton
        case .noResults(let searchedQuery):
            noResultsView(query: searchedQuery)
        case .error(let message):
            errorView(message: message, client: client)
        case .loaded(let items):
            resultsContent(items)
        }
    }

    // MARK: - Results (header + grid, dimmed together while re-searching)

    /// Web wraps the result-count/mode-badge header *and* the grid in one
    /// `opacity-50`-while-`isFetching` div (`SearchPage.tsx` lines 79-109) so
    /// re-searching dims the whole block, not just the posters — mirrored
    /// here by applying `.opacity` to this combined `ScrollView` rather than
    /// only to the grid.
    private func resultsContent(_ items: [MediaCard]) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                resultsHeader(count: items.count, usedEmbeddings: searchModel.usedEmbeddings)

                LazyVGrid(columns: gridColumns, alignment: .leading, spacing: 40) {
                    ForEach(items, id: \.id) { card in
                        PosterCard(card: card, baseURL: model.baseURL, imageLoader: imageLoader) {
                            select(card)
                        }
                    }
                }
                // One focus section for the whole results grid — the tvOS
                // focus engine handles up/down/left/right within an adaptive
                // grid the same way it does within a `LazyHStack` rail, so a
                // single section (rather than one per row) is both correct
                // and simpler here.
                .focusSection()
                .accessibilityIdentifier("searchResultsGrid")
            }
            .padding(.horizontal, 64)
            .padding(.vertical, 32)
        }
        // `isSearching` can only be true here (the `.loaded` case) when a new
        // query superseded these still-displayed prior results — see
        // `SearchModel.loadState(for:)`: `isSearching && results.isEmpty`
        // routes to `.firstSearchLoading` instead, so reaching `.loaded`
        // while `isSearching` is true always means "stale-but-visible".
        .opacity(searchModel.isSearching ? 0.5 : 1)
        .animation(.easeInOut(duration: 0.2), value: searchModel.isSearching)
    }

    /// "N results" + the semantic/keyword mode badge (web lines 84-93).
    private func resultsHeader(count: Int, usedEmbeddings: Bool) -> some View {
        HStack(spacing: 16) {
            Text("\(count) \(count == 1 ? "result" : "results")")
                .font(.title3)
                .foregroundStyle(OrbixColor.textDim)
            modeChip(usedEmbeddings: usedEmbeddings)
        }
        .accessibilityIdentifier("searchResultsHeader")
    }

    /// Purple when the response used embedding-based (semantic) search,
    /// neutral when it fell back to keyword matching — ported from web's
    /// `bg-purple-900/50 text-purple-300` vs. `bg-[var(--surface)]
    /// text-[var(--text-dim)]` (`SearchPage.tsx` lines 87-93).
    private func modeChip(usedEmbeddings: Bool) -> some View {
        Text(usedEmbeddings ? "Semantic" : "Keyword")
            .font(.caption.bold())
            .foregroundStyle(usedEmbeddings ? OrbixColor.accent2 : OrbixColor.textDim)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(
                usedEmbeddings ? OrbixColor.accent2.opacity(0.22) : OrbixColor.surface,
                in: RoundedRectangle(cornerRadius: OrbixRadius.chip, style: .continuous)
            )
            .accessibilityIdentifier("searchModeChip")
    }

    /// Pushes the title/detail page for the selected result — same
    /// `TitleRoute` destination and push mechanics as `HomeView.select`.
    private func select(_ card: MediaCard) {
        path.append(TitleRoute(itemId: card.id))
    }

    // MARK: - Landing / skeleton / empty / error states

    /// Teaching landing state shown before any query is typed — ported from
    /// web's centered heading + hint (`SearchPage.tsx` lines 69-74), reusing
    /// the `search:landing`/`search:placeholder` copy as literal English
    /// (Phase 5 moves this into the String Catalog).
    private var promptView: some View {
        VStack(spacing: 12) {
            Text("Search your library")
                .font(OrbixType.rowHeading)
                .foregroundStyle(OrbixColor.text)
            Text("e.g. comedy under 2 hours, something funny and lighthearted")
                .font(.title3)
                .foregroundStyle(OrbixColor.textDim)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 760)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("searchPromptState")
    }

    /// Shown only for the very first search of a query (no prior results to
    /// keep dimmed on screen yet) — a poster-shaped skeleton grid rather than
    /// a spinner, matching web's `SearchSkeletonGrid` (`SearchPage.tsx` line
    /// 77 + 9-21; 14 tiles, `Array.from({ length: 14 })`). Reuses the same
    /// `SkeletonView` tile shape `LibraryBrowseView.skeletonGrid` uses.
    private var firstSearchSkeleton: some View {
        ScrollView {
            LazyVGrid(columns: gridColumns, alignment: .leading, spacing: 40) {
                ForEach(0..<14, id: \.self) { _ in
                    VStack(alignment: .leading, spacing: 10) {
                        SkeletonView(cornerRadius: OrbixRadius.sm)
                            .aspectRatio(2.0 / 3.0, contentMode: .fit)
                        SkeletonView()
                            .frame(width: 140, height: 18)
                    }
                }
            }
            .padding(.horizontal, 64)
            .padding(.vertical, 32)
        }
        .allowsHitTesting(false)
        .accessibilityIdentifier("searchSkeleton")
    }

    private func noResultsView(query: String) -> some View {
        ContentUnavailableView(
            "No results for \"\(query)\"",
            systemImage: "magnifyingglass",
            description: Text("Try a different title, genre, or mood.")
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("searchNoResultsState")
    }

    private func errorView(message: String, client: OrbixClient) -> some View {
        ContentUnavailableView {
            Label("Couldn't search", systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            Button("Retry") {
                searchModel.queryChanged(query, client: client)
            }
            .accessibilityIdentifier("searchRetryButton")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("searchErrorState")
    }
}

/// Drives `SearchView`: debounces the live query text and fetches
/// `GET /api/search`, exposing a single `loadState(for:)` — mirroring
/// `HomeModel`/`TitleModel`'s single-`loadState` shape so loading/empty/
/// error/loaded can't drift out of sync — computed from *both* this model's
/// own fetch state and the view's live `query` text (passed in rather than
/// mirrored into a stored property, so there's exactly one source of truth
/// for "what's currently typed": the `@State` SwiftUI already keeps for the
/// `.searchable` binding).
@MainActor
@Observable
final class SearchModel {
    enum LoadState: Equatable {
        /// The query field is empty — nothing has been typed (or it was
        /// just cleared). The teaching landing state.
        case prompt
        /// A search is in flight and there are no prior results to keep
        /// showing (the very first search of a query, or the query that
        /// follows a no-results/error outcome) — the skeleton grid, not a
        /// spinner.
        case firstSearchLoading
        /// The most recently *completed* search for `String` returned zero
        /// items.
        case noResults(String)
        case error(String)
        /// Either a settled result set, or a re-search in flight that still
        /// has a prior (stale) result set to keep showing dimmed — see
        /// `loadState(for:)` and `SearchView.resultsContent`, which reads
        /// `isSearching` directly to tell the two apart.
        case loaded([MediaCard])
    }

    /// Debounce delay after the query text last changes before the
    /// `/api/search` request actually fires — long enough to collapse a
    /// burst of system-keyboard keystrokes into a single request, short
    /// enough that results still feel responsive once typing pauses. Per
    /// the task brief's 300–400ms guidance.
    private static let debounceNanoseconds: UInt64 = 350_000_000

    private(set) var results: [MediaCard] = []
    private(set) var loadError: String?
    private(set) var isSearching = false

    /// Whether the most recently *completed* search used embedding-based
    /// (semantic) matching rather than falling back to keyword search —
    /// drives `SearchView`'s mode badge. Mirrors web's
    /// `data?.usedEmbeddings ?? false` (`SearchPage.tsx` line 46).
    private(set) var usedEmbeddings = false

    /// The query `results`/`loadError` actually correspond to — distinct
    /// from the live text field value (which `SearchView` reads directly
    /// off its own `@State`) so a `.noResults("arr")` message stays pinned
    /// to the query that was actually searched, not whatever's been typed
    /// since.
    private(set) var searchedQuery = ""

    /// The debounce-then-fetch `Task` for the most recently typed query, if
    /// one is still pending or in flight. Cancelled at the top of every
    /// `queryChanged` call, so at most one is ever running — the mechanism
    /// that turns "a search per keystroke" into "a search per pause in
    /// typing."
    ///
    /// `nonisolated(unsafe)`: mirrors `PairingModel.pollTask`'s reasoning —
    /// `deinit` on a `@MainActor` class is itself nonisolated, so cancelling
    /// this from `deinit` needs the escape hatch. Safe here because by the
    /// time `deinit` runs, nothing else holds a reference to this instance
    /// that could still be calling `queryChanged` concurrently.
    private nonisolated(unsafe) var pendingTask: Task<Void, Never>?

    init() {}

    /// Defensive teardown: cancels a still-pending debounce/fetch if
    /// `SearchView` (and this model with it) goes away before it fires —
    /// e.g. the user leaves the Search tab immediately after typing. The
    /// `[weak self]` capture in `queryChanged` already makes this non-load-
    /// bearing for correctness (a fired task just finds `self` nil and
    /// exits), but cancelling explicitly lets that Task stop cooperatively
    /// (and skip its network call) right away instead of running out its
    /// debounce sleep for no reason.
    deinit {
        pendingTask?.cancel()
    }

    /// `isSearching && results.isEmpty` is the "nothing to keep showing yet"
    /// test — true for the very first search of a query, and also true if a
    /// re-search follows a no-results or error outcome (both leave `results`
    /// empty). Any other combination of `isSearching` + non-empty `results`
    /// falls through to `.loaded`, where `SearchView` dims instead of
    /// replacing the grid — the "keep prior results visible while
    /// re-searching" behavior the web mirrors with `placeholderData:
    /// keepPreviousData`.
    func loadState(for currentText: String) -> LoadState {
        let trimmed = currentText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .prompt }
        if isSearching, results.isEmpty { return .firstSearchLoading }
        if let loadError { return .error(loadError) }
        if results.isEmpty { return .noResults(searchedQuery) }
        return .loaded(results)
    }

    /// Called on every query-text change (`SearchView`'s
    /// `.onChange(of: query)`) — i.e. once per keystroke on the system
    /// keyboard. Cancels any pending debounce/fetch unconditionally, so a
    /// keystroke arriving mid-debounce (or mid-request) restarts the clock
    /// rather than letting a stale query's request land after a newer one.
    /// An emptied-out field short-circuits straight back to `.prompt`
    /// (nothing to debounce for "no query"); a non-empty change starts a
    /// fresh `debounceNanoseconds` timer before actually calling
    /// `OrbixClient.search` — deliberately **without** clearing `results` (or
    /// `usedEmbeddings`) first, so a prior result set stays on screen (dimmed
    /// by `SearchView`) instead of flashing empty while the new search runs.
    func queryChanged(_ text: String, client: OrbixClient) {
        pendingTask?.cancel()

        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            isSearching = false
            loadError = nil
            results = []
            usedEmbeddings = false
            searchedQuery = ""
            return
        }

        isSearching = true
        loadError = nil

        pendingTask = Task { [weak self] in
            do {
                try await Task.sleep(nanoseconds: Self.debounceNanoseconds)
            } catch {
                return // cancelled before the debounce elapsed
            }
            guard let self, !Task.isCancelled else { return }
            await self.performSearch(query: trimmed, client: client)
        }
    }

    private func performSearch(query: String, client: OrbixClient) async {
        do {
            let response = try await client.search(query: query)
            // A newer queryChanged() call may have cancelled this task
            // (and started its own) while the request was in flight — don't
            // let a slow, superseded response clobber newer state.
            guard !Task.isCancelled else { return }
            results = response.items
            usedEmbeddings = response.usedEmbeddings ?? false
            searchedQuery = query
            loadError = nil
        } catch {
            guard !Task.isCancelled else { return }
            loadError = "Couldn't search: \(error)"
            results = []
            usedEmbeddings = false
            searchedQuery = query
        }
        isSearching = false
    }
}

#Preview {
    SearchView(model: AppModel())
}
