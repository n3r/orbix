import OrbixKit
import SwiftUI

/// SP2 M3 Task 5 search screen, reached via the "Search" tab in `RootView`'s
/// `.ready`-case `TabView` (alongside `HomeView`'s "Home" tab). Free-text
/// query against `GET /api/search` (`OrbixClient.search(query:)`), debounced
/// so the system keyboard's keystrokes don't each fire a request (see
/// `SearchModel.queryChanged`); results render as a focusable grid of
/// `PosterCard`s, same lockup as `HomeView`'s rails.
///
/// Uses SwiftUI's `.searchable` — the tvOS-idiomatic search affordance as of
/// tvOS 17 (a system-drawn search field that presents the system keyboard on
/// focus; no hand-rolled `TextField`/keyboard handling needed). Owns its own
/// `NavigationStack` + `path`, entirely independent from `HomeView`'s: each
/// tab in a tvOS `TabView` conventionally keeps its own navigation state, and
/// nothing about search's `TitleRoute`/`SeasonRoute` push destinations
/// (identical registrations to `HomeView`'s — a series result's season chip
/// must be able to push a `SeasonRoute` here exactly as it does from Home)
/// needs to share a stack with Home to work correctly.
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
                TitlePage(itemId: route.itemId, model: model, path: $path)
            }
            .navigationDestination(for: SeasonRoute.self) { route in
                SeasonEpisodeView(seriesId: route.seriesId, seasonNumber: route.seasonNumber, model: model)
            }
        }
    }

    @ViewBuilder
    private func content(client: OrbixClient) -> some View {
        switch searchModel.loadState(for: query) {
        case .prompt:
            promptView
        case .loading:
            loadingView
        case .noResults(let searchedQuery):
            noResultsView(query: searchedQuery)
        case .error(let message):
            errorView(message: message, client: client)
        case .loaded(let items):
            resultsGrid(items)
        }
    }

    private func resultsGrid(_ items: [MediaCard]) -> some View {
        ScrollView {
            LazyVGrid(columns: gridColumns, alignment: .leading, spacing: 40) {
                ForEach(items, id: \.id) { card in
                    PosterCard(card: card, baseURL: model.baseURL, imageLoader: imageLoader) {
                        select(card)
                    }
                }
            }
            .padding(.horizontal, 64)
            .padding(.vertical, 32)
        }
        // One focus section for the whole results grid — the tvOS focus
        // engine handles up/down/left/right within an adaptive grid the same
        // way it does within a `LazyHStack` rail, so a single section (rather
        // than one per row) is both correct and simpler here.
        .focusSection()
        .accessibilityIdentifier("searchResultsGrid")
    }

    /// Pushes the title/detail page for the selected result — same
    /// `TitleRoute` destination and push mechanics as `HomeView.select`.
    private func select(_ card: MediaCard) {
        path.append(TitleRoute(itemId: card.id))
    }

    // MARK: - Loading / empty / error / prompt states

    private var promptView: some View {
        ContentUnavailableView(
            "Search Orbix",
            systemImage: "magnifyingglass",
            description: Text("Find movies and shows by title, genre, or mood.")
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("searchPromptState")
    }

    private var loadingView: some View {
        ProgressView("Searching…")
            .font(.title3)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityIdentifier("searchLoadingState")
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
        /// just cleared).
        case prompt
        /// A non-empty query is debouncing or its search request is in
        /// flight.
        case loading
        /// The most recently *completed* search for `String` returned zero
        /// items.
        case noResults(String)
        case error(String)
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

    func loadState(for currentText: String) -> LoadState {
        let trimmed = currentText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .prompt }
        if isSearching { return .loading }
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
    /// `OrbixClient.search`.
    func queryChanged(_ text: String, client: OrbixClient) {
        pendingTask?.cancel()

        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            isSearching = false
            loadError = nil
            results = []
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
            searchedQuery = query
            loadError = nil
        } catch {
            guard !Task.isCancelled else { return }
            loadError = "Couldn't search: \(error)"
            results = []
            searchedQuery = query
        }
        isSearching = false
    }
}

#Preview {
    SearchView(model: AppModel())
}
