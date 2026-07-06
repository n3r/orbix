import OrbixKit
import SwiftUI

/// Route the header's Guide button pushes onto `TvHomeView`'s own stack —
/// destination is the real `TvGuideView` as of Phase 4 Task 5 (previously a
/// labeled placeholder; see git history for `TvGuidePlaceholderView`).
struct TvGuideRoute: Hashable {}

/// Route a guide row's info action pushes onto the same shared stack (see
/// `TvGuideView.row`'s `.contextMenu`). The full channel/schedule page lands
/// in Task 7 — this task only needs the push target to exist end-to-end (the
/// route type, the push, and a small labeled placeholder destination), per
/// that task's own "Task-7 bridge" instruction — mirrors exactly how
/// `TvGuideRoute` itself was bridged in Task 4.
struct TvChannelRoute: Hashable {
    let channelId: String
}

/// Placeholder pushed for `TvChannelRoute` today — replaced by the real
/// channel/schedule page in Task 7 without touching `TvGuideView`'s info
/// action or the stack wiring here.
private struct TvChannelPlaceholderView: View {
    let channelId: String

    var body: some View {
        ContentUnavailableView {
            Label("Channel", systemImage: "tv")
        } description: {
            Text("The channel page is coming in a later phase.")
        }
        .accessibilityIdentifier("tvChannelPlaceholder")
    }
}

/// Phase 4 Task 4 TV Home screen, reached by selecting **TV** in
/// `OrbixTopBar` (`AppSection.tv`) — tvOS port of `apps/web/src/pages/
/// TvHomePage.tsx`. Loads `GET /api/tv/home` via `TvHomeModel` and renders
/// Recents → Favorites → per-country → per-category `ChannelRailView`s, each
/// only when non-empty (web lines 96-125); a channel select opens
/// `LiveTvOverlay` full-screen with that rail's own list as the zap context.
///
/// Owns its own `NavigationStack`, shared (via its `path` binding) with
/// everything the header Guide button and its descendants push:
/// `TvGuideRoute` → the real `TvGuideView` (Task 5), whose own info action
/// pushes `TvChannelRoute` (still a Task-7 bridge placeholder) onto this
/// same stack. Also takes the same Menu-walk `onMenuExit` idiom every other
/// hub section takes (`LibraryBrowseView`/`WishlistView`/`SearchView`): pop
/// this view's own `path` one level per Menu press before ever falling
/// through to `onMenuExit` — see `ShellView`'s type doc comment for why that
/// decision has to be made here rather than via an outer `.onExitCommand`.
struct TvHomeView: View {
    let model: AppModel

    /// Called on Menu when this section's own `path` is already empty.
    let onMenuExit: () -> Void

    @State private var tvModel = TvHomeModel()
    @State private var imageLoader = ImageLoader()
    @State private var path = NavigationPath()
    /// Drives the `.fullScreenCover` live-TV cinema — `nil` when closed.
    @State private var liveContext: LivePlayContext?

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if let client = model.client {
                    content(client: client)
                        .task { await tvModel.load(client: client) }
                } else {
                    // Defensive only: ShellView only routes to `.tv` once
                    // `model.client` is non-nil — same invariant every other
                    // hub section's fallback documents.
                    ProgressView()
                }
            }
            .navigationDestination(for: TvGuideRoute.self) { _ in
                TvGuideView(model: model, path: $path)
            }
            .navigationDestination(for: TvChannelRoute.self) { route in
                TvChannelPlaceholderView(channelId: route.channelId)
            }
        }
        .onExitCommand {
            if path.isEmpty {
                onMenuExit()
            } else {
                path.removeLast()
            }
        }
        .fullScreenCover(item: $liveContext) { context in
            LiveTvOverlay(
                channels: context.channels,
                initialId: context.initialId,
                model: model,
                onClose: { liveContext = nil }
            )
        }
    }

    // MARK: - Content

    /// Same top-padding rationale as `LibraryBrowseView`/`WishlistView`:
    /// `OrbixTopBar` renders over this section and there's no hero art meant
    /// to bleed under it.
    private static let contentTopPadding: CGFloat = 140

    /// Header (heading + Guide button) stays mounted across every
    /// `loadState`, matching every other hub screen's "controls stay put,
    /// only the region below switches" convention.
    @ViewBuilder
    private func content(client: OrbixClient) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                header

                switch tvModel.loadState {
                case .loading:
                    skeletonRails
                case .error(let message):
                    errorView(message: message, client: client)
                case .empty:
                    emptyView
                case .loaded(let home):
                    rails(home, client: client)
                }
            }
            .padding(.top, Self.contentTopPadding)
            .padding(.bottom, 80)
        }
        .accessibilityIdentifier("tvHomeScroll")
    }

    private var header: some View {
        HStack {
            Text("Live TV")
                .font(OrbixType.rowHeading)
                .foregroundStyle(OrbixColor.text)
                .accessibilityIdentifier("tvHomeHeading")
            Spacer()
            // Web's visible Guide affordance (`TvHomePage.tsx` lines 86-90,
            // "the Hulu lesson"); destination is the real `TvGuideView`
            // (Phase 4 Task 5).
            Button("Guide") { path.append(TvGuideRoute()) }
                .buttonStyle(OrbixButtonStyle(.ghost))
                .accessibilityIdentifier("tvGuideButton")
        }
        .padding(.horizontal, 64)
    }

    // MARK: - Rails (loaded)

    @ViewBuilder
    private func rails(_ home: TvHome, client: OrbixClient) -> some View {
        LazyVStack(alignment: .leading, spacing: OrbixSpacing.railGap) {
            if !home.recents.isEmpty {
                ChannelRailView(
                    id: "recents",
                    title: "Recently watched",
                    channels: home.recents,
                    baseURL: model.baseURL,
                    imageLoader: imageLoader,
                    onPlay: play,
                    onToggleFavorite: { toggleFavorite($0, client: client) }
                )
            }
            if !home.favorites.isEmpty {
                ChannelRailView(
                    id: "favorites",
                    title: "Favorites",
                    channels: home.favorites,
                    baseURL: model.baseURL,
                    imageLoader: imageLoader,
                    onPlay: play,
                    onToggleFavorite: { toggleFavorite($0, client: client) }
                )
            }
            ForEach(home.countries, id: \.code) { country in
                if !country.channels.isEmpty {
                    ChannelRailView(
                        id: "country_\(country.code)",
                        title: tvRegionName(country.code) ?? country.code,
                        channels: country.channels,
                        baseURL: model.baseURL,
                        imageLoader: imageLoader,
                        onPlay: play,
                        onToggleFavorite: { toggleFavorite($0, client: client) }
                    )
                }
            }
            ForEach(home.categories, id: \.id) { category in
                if !category.channels.isEmpty {
                    ChannelRailView(
                        id: "category_\(category.id)",
                        title: Self.capitalized(category.id),
                        channels: category.channels,
                        baseURL: model.baseURL,
                        imageLoader: imageLoader,
                        onPlay: play,
                        onToggleFavorite: { toggleFavorite($0, client: client) }
                    )
                }
            }
        }
        .padding(.horizontal, 64)
    }

    /// Web `c.id.charAt(0).toUpperCase() + c.id.slice(1)` (`TvHomePage.tsx`
    /// line 118's `defaultValue`) — uppercase just the first character,
    /// leave the rest untouched (server category ids are always lowercase
    /// single words, so this reads identically to `String.capitalized` in
    /// practice, but matches the web's exact transform rather than title-
    /// casing every word).
    private static func capitalized(_ id: String) -> String {
        guard let first = id.first else { return id }
        return first.uppercased() + id.dropFirst()
    }

    // MARK: - Skeleton / empty / error (web `TvRailSkeleton` / `EmptyState`)

    /// 3 skeleton rails, matching the web's `Array.from({ length: 3 })`
    /// (`TvHomePage.tsx` lines 70-72).
    private var skeletonRails: some View {
        VStack(alignment: .leading, spacing: OrbixSpacing.railGap) {
            ForEach(0..<3, id: \.self) { _ in
                VStack(alignment: .leading, spacing: 20) {
                    SkeletonView()
                        .frame(width: 260, height: 30)
                    HStack(spacing: OrbixSpacing.cardGap) {
                        ForEach(0..<6, id: \.self) { _ in
                            SkeletonView(cornerRadius: OrbixRadius.md)
                                .frame(width: ChannelCard.width, height: ChannelCard.height)
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 64)
        .allowsHitTesting(false)
        .accessibilityIdentifier("tvHomeSkeleton")
    }

    /// Member-only empty copy — the brief's explicit wording (not the web's
    /// `tv:empty.memberBody` string verbatim). The admin "Set up TV" CTA
    /// stays web-only (`TvHomePage.tsx`'s `EmptyState` admin branch is not
    /// ported); kids never reach here since the TV nav item is hidden
    /// (`OrbixTopBar.isKids`) and `/tv/*` 403s kids server-side regardless.
    private var emptyView: some View {
        ContentUnavailableView {
            Label("Live TV", systemImage: "tv")
        } description: {
            Text("Live channels aren't set up yet. Ask your server admin to add a TV source.")
        }
        .padding(.top, 60)
        .accessibilityIdentifier("tvHomeEmptyState")
    }

    private func errorView(message: String, client: OrbixClient) -> some View {
        ContentUnavailableView {
            Label("Couldn't load channels", systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            Button("Retry") {
                Task { await tvModel.load(client: client) }
            }
            .accessibilityIdentifier("tvHomeRetryButton")
        }
        .padding(.top, 60)
        .accessibilityIdentifier("tvHomeErrorState")
    }

    // MARK: - Actions

    /// Opens `LiveTvOverlay` with the selecting rail's own channel list as
    /// the zap context (web `openPlayer`, `TvHomePage.tsx` lines 58-59).
    private func play(_ channel: TvChannelCard, context: [TvChannelCard]) {
        liveContext = LivePlayContext(channels: context, initialId: channel.id)
    }

    private func toggleFavorite(_ channel: TvChannelCard, client: OrbixClient) {
        Task { await tvModel.toggleFavorite(channel, client: client) }
    }
}

/// Drives `TvHomeView`: loads `GET /api/tv/home` and exposes a single
/// `loadState`, mirroring `HomeModel`/`WishlistModel`/`LibraryModel`'s shape
/// so loading/error/empty/loaded can't drift out of sync. Unlike those
/// models, "empty" isn't "the one array is empty" but "every rail across the
/// whole response is empty" (`Self.isEmpty`, web lines 77-81).
@MainActor
@Observable
final class TvHomeModel {
    enum LoadState: Equatable {
        case loading
        case error(String)
        case empty
        case loaded(TvHome)
    }

    private(set) var home: TvHome?
    private(set) var isLoading = false
    private(set) var loadError: String?

    /// Flips to `true` once the first `load` attempt (success or failure)
    /// completes — same reasoning as `HomeModel.hasLoaded`: without it, a
    /// server with genuinely zero channels would be indistinguishable from
    /// "hasn't loaded yet" for the one frame before `.task` resolves.
    private(set) var hasLoaded = false

    /// The `load` `Task` most recently started, if one is still pending or in
    /// flight. Cancelled at the top of every `load` call, so at most one is
    /// ever running — same `nonisolated(unsafe)` rationale as
    /// `WishlistModel.pendingTask` (a `deinit` on a `@MainActor` class is
    /// itself nonisolated, so cancelling from `deinit` needs the escape
    /// hatch; safe because nothing else can still be calling into this
    /// instance once `deinit` runs).
    private nonisolated(unsafe) var pendingTask: Task<Void, Never>?

    init() {}

    deinit {
        pendingTask?.cancel()
    }

    var loadState: LoadState {
        if let home, !Self.isEmpty(home) {
            return .loaded(home)
        }
        if isLoading || !hasLoaded { return .loading }
        if let loadError { return .error(loadError) }
        return .empty
    }

    /// The view's initial `.task` and the error state's Retry button. Routed
    /// through the shared `pendingTask` slot exactly like
    /// `WishlistModel.load`: a Retry tap while a fetch is still in flight
    /// cancels the stale one instead of racing two concurrent fetches to set
    /// `home` last.
    func load(client: OrbixClient) async {
        pendingTask?.cancel()
        let task = Task { [weak self] in
            guard let self, !Task.isCancelled else { return }
            await self.performLoad(client: client)
        }
        isLoading = true
        loadError = nil
        pendingTask = task
        await task.value
    }

    private func performLoad(client: OrbixClient) async {
        do {
            let fetched = try await client.tvHome()
            guard !Task.isCancelled else { return }
            home = fetched
            loadError = nil
        } catch {
            guard !Task.isCancelled else { return }
            loadError = "Couldn't load channels: \(error)"
            home = nil
        }
        isLoading = false
        hasLoaded = true
    }

    /// Optimistic favorite toggle (mirrors `TitleModel.toggleWishlist`'s
    /// flip-then-revert-on-throw idiom): flip the matching channel's
    /// `favorite` field across *every* rail immediately, call the server,
    /// and restore the pre-toggle snapshot on failure. Deliberately does not
    /// remove/insert the channel into the Favorites rail itself (that would
    /// require a full reload to rebuild rail membership) — only the boolean
    /// the card's context-menu label reflects; a later reload of this screen
    /// picks up the server's actual rail membership.
    func toggleFavorite(_ channel: TvChannelCard, client: OrbixClient) async {
        guard let original = home else { return }
        let newValue = !channel.favorite
        home = Self.applyingFavorite(newValue, channelId: channel.id, to: original)
        do {
            try await client.setTvFavorite(channelId: channel.id, on: newValue)
        } catch {
            home = original
        }
    }

    private static func isEmpty(_ home: TvHome) -> Bool {
        home.recents.isEmpty
            && home.favorites.isEmpty
            && home.countries.allSatisfy { $0.channels.isEmpty }
            && home.categories.allSatisfy { $0.channels.isEmpty }
    }

    private static func applyingFavorite(_ favorite: Bool, channelId: String, to home: TvHome) -> TvHome {
        func apply(_ list: [TvChannelCard]) -> [TvChannelCard] {
            list.map { channel in
                guard channel.id == channelId else { return channel }
                var updated = channel
                updated.favorite = favorite
                return updated
            }
        }
        return TvHome(
            recents: apply(home.recents),
            favorites: apply(home.favorites),
            countries: home.countries.map { TvCountryRail(code: $0.code, channels: apply($0.channels)) },
            categories: home.categories.map { TvCategoryRail(id: $0.id, channels: apply($0.channels)) }
        )
    }
}

#Preview {
    TvHomeView(model: AppModel(), onMenuExit: {})
}
