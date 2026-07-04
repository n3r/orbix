import OrbixKit
import SwiftUI

/// SP2 M3 home screen: Netflix-style rails loaded from `GET /api/home/rows`
/// (see `apps/api/src/routes/discovery.ts`'s smart-rows hydration), replacing
/// the M1 `SpikeListView` flat poster grid. Each row renders as a titled,
/// horizontally-scrolling, independently focus-sectioned rail of
/// `PosterCard`s. Selecting a card is a no-op placeholder for now — real
/// navigation to a title/detail page is M3 Task 2.
struct HomeView: View {
    let model: AppModel

    @State private var homeModel = HomeModel()
    @State private var imageLoader = ImageLoader()

    var body: some View {
        Group {
            if let client = model.client {
                content(client: client)
                    .task { await homeModel.load(client: client) }
            } else {
                // Defensive only: RootView only routes to HomeView once
                // `model.client` is non-nil (same invariant
                // ProfilePickerView/PairingView's fallbacks document).
                ProgressView()
            }
        }
    }

    @ViewBuilder
    private func content(client: OrbixClient) -> some View {
        switch homeModel.loadState {
        case .loading:
            ProgressView("Loading…")
                .font(.title3)
        case .error(let message):
            errorView(message: message, client: client)
        case .empty:
            emptyView
        case .loaded(let rows):
            rails(rows)
        }
    }

    private func rails(_ rows: [HomeRow]) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 56) {
                ForEach(rows, id: \.key) { row in
                    railView(row)
                }
            }
            .padding(.horizontal, 64)
            .padding(.vertical, 48)
        }
    }

    @ViewBuilder
    private func railView(_ row: HomeRow) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(row.title)
                .font(.title3.bold())
                .padding(.leading, 4)

            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 32) {
                    ForEach(row.items, id: \.id) { card in
                        PosterCard(card: card, baseURL: model.baseURL, imageLoader: imageLoader) {
                            select(card)
                        }
                    }
                }
                // Vertical headroom so a card's scale-on-focus growth
                // doesn't visually clip against the rail above/below.
                .padding(.horizontal, 4)
                .padding(.vertical, 16)
            }
            // Each rail is its own focus section: the tvOS focus engine
            // moves within a rail on left/right and hands off to the
            // adjacent rail on up/down, rather than treating every poster
            // on screen as one flat focus group.
            .focusSection()
        }
        .accessibilityIdentifier("homeRail_\(row.key)")
    }

    private var emptyView: some View {
        ContentUnavailableView(
            "No titles yet",
            systemImage: "film.stack",
            description: Text("Scan a library on the server to see titles here.")
        )
        .accessibilityIdentifier("homeEmptyState")
    }

    private func errorView(message: String, client: OrbixClient) -> some View {
        ContentUnavailableView {
            Label("Couldn't load titles", systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            Button("Retry") {
                Task { await homeModel.load(client: client) }
            }
            .accessibilityIdentifier("homeRetryButton")
        }
        .accessibilityIdentifier("homeErrorState")
    }

    /// Selecting a card will eventually push the title/detail page
    /// (`TitlePage`, M3 Task 2, via a `NavigationStack` this view will then
    /// wrap its content in). Until that exists, selection is a diagnostic
    /// no-op rather than a dead end with no feedback at all.
    private func select(_ card: MediaCard) {
        // TODO(M3 Task 2): push TitlePage(itemId: card.id) once it exists.
        print("[HomeView] selected \(card.title) (\(card.id)) — navigation lands in M3 Task 2")
    }
}

/// Drives `HomeView`: loads `/api/home/rows` and exposes the result as a
/// single `loadState` the view switches on, so "loading" vs "error" vs
/// "empty" vs "loaded" can't drift out of sync the way separately-checked
/// `isLoading`/`loadError`/`rows` conditions in the view would.
@MainActor
@Observable
final class HomeModel {
    enum LoadState: Equatable {
        case loading
        case error(String)
        case empty
        case loaded([HomeRow])
    }

    private(set) var rows: [HomeRow] = []
    private(set) var isLoading = false
    private(set) var loadError: String?

    /// Flips to `true` once the first `load` attempt (success or failure)
    /// completes. Without this, a library that genuinely has zero titles
    /// would be indistinguishable from "hasn't loaded yet" for the single
    /// frame before `.task` starts the first `load` — `loadState` instead
    /// stays on `.loading` until that first attempt resolves one way or
    /// the other.
    private(set) var hasLoaded = false

    init() {}

    var loadState: LoadState {
        guard rows.isEmpty else { return .loaded(rows) }
        if isLoading || !hasLoaded { return .loading }
        if let loadError { return .error(loadError) }
        return .empty
    }

    /// Fetches `/api/home/rows`. Safe to call again (e.g. the error state's
    /// Retry button) once the previous call has finished — a call arriving
    /// while one's already in flight is a no-op rather than racing a second
    /// fetch (mirrors `ProfilePickerModel.load`'s re-entrancy guard).
    func load(client: OrbixClient) async {
        guard !isLoading else { return }
        isLoading = true
        loadError = nil
        do {
            let homeRows = try await client.homeRows()
            rows = homeRows.rows
        } catch {
            loadError = "Couldn't load titles: \(error)"
        }
        isLoading = false
        hasLoaded = true
    }
}

#Preview {
    HomeView(model: AppModel())
}
