import OrbixKit
import SwiftUI

/// SP2 Phase 2 Home screen: a Netflix-style full-bleed `HomeBillboardView`
/// over box-art `RailView` rails loaded from `GET /api/home/rows` (see
/// `apps/web/src/pages/HomePage.tsx` for the web composition this ports). The
/// billboard and rails live in **one** `ScrollView`; the first rail rides up
/// into the billboard's bottom dissolve (`.padding(.top, -80)`, the tvOS
/// analogue of web's `-mt-12 md:-mt-20`), and scrolling the whole thing flips
/// the shell's transparent top bar to solid via `isScrolled`.
///
/// Owns the `NavigationStack` for the whole home→title→season flow: selecting
/// a card pushes a `TitleRoute` (M3 Task 2); the billboard's **Play** pushes a
/// `TitleRoute(autoplay: true)` (the web `?play=1` direct-play deep-link),
/// **More info** a plain `TitleRoute`. `TitlePage`'s own "More Like This" rail
/// is handed the same `path` binding, so selecting a similar title there
/// pushes another `TitlePage` onto this same stack; a series' season chip
/// likewise pushes a `SeasonRoute` (M3 Task 4). `path` is a type-erased
/// `NavigationPath` (rather than `[TitleRoute]`) specifically so it can carry
/// both route types — each route is still a distinct `Hashable` type with its
/// own `.navigationDestination(for:)` below, so `TitleRoute` and `SeasonRoute`
/// can never collide with each other on the same stack.
struct HomeView: View {
    let model: AppModel
    /// Driven from this view's scroll offset; `ShellView` owns the state and
    /// its top bar reacts (transparent → near-solid). See `scrollOffsetReader`.
    @Binding var isScrolled: Bool

    @State private var homeModel = HomeModel()
    @State private var imageLoader = ImageLoader()
    @State private var path = NavigationPath()

    /// tvOS 17 has no `onScrollGeometryChange` (18+), so scroll offset is read
    /// via a `GeometryReader` + `PreferenceKey` in this named coordinate space.
    private static let scrollSpace = "homeScroll"

    var body: some View {
        NavigationStack(path: $path) {
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
            .navigationDestination(for: TitleRoute.self) { route in
                TitlePage(itemId: route.itemId, model: model, path: $path, autoplay: route.autoplay)
            }
            .navigationDestination(for: SeasonRoute.self) { route in
                SeasonEpisodeView(seriesId: route.seriesId, seasonNumber: route.seasonNumber, model: model)
            }
        }
    }

    @ViewBuilder
    private func content(client: OrbixClient) -> some View {
        switch homeModel.loadState {
        case .loading:
            homeSkeleton
        case .error(let message):
            errorView(message: message, client: client)
        case .empty:
            emptyView
        case .loaded(let rows):
            loaded(rows)
        }
    }

    // MARK: - Loaded (billboard + rails)

    private func loaded(_ rows: [HomeRow]) -> some View {
        // One featured title on the billboard (rotates daily); every row
        // (continue watching included) still renders below it, Netflix-style
        // (web `HomePage.tsx` lines 73-84).
        let featured = pickBillboard(rows: rows, seed: dailySeed())
        return ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if let featured {
                    HomeBillboardView(
                        card: featured,
                        model: model,
                        imageLoader: imageLoader,
                        onPlay: { play(featured) },
                        onMoreInfo: { select(featured) }
                    )
                }

                LazyVStack(alignment: .leading, spacing: OrbixSpacing.railGap) {
                    ForEach(rows, id: \.key) { row in
                        RailView(row: row, baseURL: model.baseURL, imageLoader: imageLoader) { card in
                            select(card)
                        }
                    }
                }
                .padding(.horizontal, 64)
                // First rail rides up into the billboard's dissolve (web's
                // `-mt-12 md:-mt-20`); without a billboard, plain top padding.
                .padding(.top, featured != nil ? -80 : 48)
                .padding(.bottom, 80)
            }
            .background(scrollOffsetReader)
        }
        // Billboard art bleeds edge-to-edge under the transparent top bar
        // (web pulls the billboard up under the fixed nav with `-mt-14`).
        .ignoresSafeArea(edges: .top)
        .coordinateSpace(name: Self.scrollSpace)
        .modifier(HomeScrollDetector(isScrolled: $isScrolled))
        .accessibilityIdentifier("homeScroll")
    }

    /// Measures the content's top edge in the named coordinate space; the
    /// value goes negative as the user scrolls up. `isScrolled = offset < -10`.
    /// Feeds `HomeScrollDetector`'s tvOS-17 fallback path.
    private var scrollOffsetReader: some View {
        GeometryReader { proxy in
            Color.clear.preference(
                key: ScrollOffsetKey.self,
                value: proxy.frame(in: .named(Self.scrollSpace)).minY
            )
        }
    }

    // MARK: - Skeleton (web `HomeSkeleton`, HomePage.tsx lines 12-30)

    private var homeSkeleton: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                SkeletonView(cornerRadius: 0)
                    .frame(height: 820)
                    .frame(maxWidth: .infinity)

                VStack(alignment: .leading, spacing: OrbixSpacing.railGap) {
                    ForEach(0..<3, id: \.self) { _ in
                        VStack(alignment: .leading, spacing: 20) {
                            SkeletonView()
                                .frame(width: 320, height: 30)
                            HStack(spacing: OrbixSpacing.cardGap) {
                                ForEach(0..<6, id: \.self) { _ in
                                    SkeletonView(cornerRadius: OrbixRadius.md)
                                        .frame(width: BoxArtCard.width, height: BoxArtCard.height)
                                }
                            }
                        }
                    }
                }
                .padding(.horizontal, 64)
                .padding(.top, -80)
                .padding(.bottom, 80)
            }
        }
        .ignoresSafeArea(edges: .top)
        .allowsHitTesting(false)
        .accessibilityIdentifier("homeSkeleton")
    }

    // MARK: - Empty / error

    private var emptyView: some View {
        ContentUnavailableView(
            "No titles yet",
            systemImage: "film.stack",
            description: Text("Scan a library on the server to see titles here.")
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("homeErrorState")
    }

    // MARK: - Navigation

    /// Pushes the title/detail page (`TitlePage`) for the selected card onto
    /// `path`.
    private func select(_ card: MediaCard) {
        path.append(TitleRoute(itemId: card.id))
    }

    /// The billboard's **Play**: pushes the title page with `autoplay` set —
    /// the tvOS analogue of the web `?play=1` direct-play deep-link.
    /// `TitlePage` presents the player once on load for a movie (a series
    /// autoplay route just shows the page — see `TitlePage.autoplayIfNeeded`).
    private func play(_ card: MediaCard) {
        path.append(TitleRoute(itemId: card.id, autoplay: true))
    }
}

/// Carries the Home `ScrollView`'s top-edge offset out of the geometry reader
/// so `HomeView` can drive `isScrolled` on tvOS 17. Only the top-most reading
/// matters.
private struct ScrollOffsetKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

/// Flips `isScrolled` once Home scrolls its content up past a small threshold,
/// so the shell's top bar goes transparent → near-solid (web `useScrolled`).
///
/// Prefers `onScrollGeometryChange` (tvOS 18+) — the reliable modern signal
/// that every current Apple TV runs — and falls back to the
/// `GeometryReader` + `PreferenceKey` offset in the named coordinate space on
/// the tvOS-17 floor (`onScrollGeometryChange` doesn't exist there). Both read
/// the same "content top moved up ~one nudge" idea: `contentOffset.y > 10`
/// (18+, positive as content scrolls up) mirrors the fallback's `minY < -10`.
private struct HomeScrollDetector: ViewModifier {
    @Binding var isScrolled: Bool

    func body(content: Content) -> some View {
        if #available(tvOS 18.0, *) {
            content.onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentOffset.y > 10
            } action: { _, scrolled in
                if scrolled != isScrolled { isScrolled = scrolled }
            }
        } else {
            content.onPreferenceChange(ScrollOffsetKey.self) { offset in
                let scrolled = offset < -10
                if scrolled != isScrolled { isScrolled = scrolled }
            }
        }
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
    HomeView(model: AppModel(), isScrolled: .constant(false))
}
