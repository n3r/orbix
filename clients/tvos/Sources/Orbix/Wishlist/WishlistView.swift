import OrbixKit
import SwiftUI

/// SP2 Phase 2 Task 7 "My List" screen, reached from the `OrbixTopBar` heart
/// icon (`AppSection.wishlist`) — tvOS port of
/// `apps/web/src/pages/WishlistPage.tsx`. Loads `GET /api/wishlist` via
/// `WishlistModel` and renders the same 2:3 `PosterCard` grid/skeleton
/// lockup as `LibraryBrowseView`/`SearchView`, minus that screen's sort
/// chips and filter field — the web page has no controls of its own, just a
/// heading and a grid.
///
/// The heading reads "My List" rather than the web `<h1>`'s literal
/// `t("wishlist:heading")` string ("Wishlist"): `ShellView`'s pre-existing
/// `.wishlist` placeholder (and the top bar's heart icon) already established
/// "My List" as this section's tvOS-facing name — Netflix-style naming for a
/// heart-icon watch-later shelf reads more clearly at 10 feet than the web's
/// literal string, and this task's brief calls for "My List" explicitly. The
/// empty-state copy below, by contrast, **is** the web's actual strings verbatim
/// (`wishlist:empty` / `wishlist:emptyHint`) — only the top-level heading
/// diverges.
///
/// Server returns the wishlist newest-first already (`OrbixClient.wishlist()`
/// doc comment; `apps/api` orders by `WishlistEntry.addedAt desc`), so
/// unlike `LibraryBrowseView` there is no client-side sort to apply or chip
/// row to drive it.
///
/// Owns its own `NavigationStack` + `TitleRoute` destination, identical
/// wiring to `LibraryBrowseView`'s, so selecting a card three pages deep
/// behaves identically everywhere in the app (a series' seasons/episodes
/// render inline on the title page — no separate pushed destination).
struct WishlistView: View {
    let model: AppModel
    /// Driven from this view's scroll offset, same wiring as `HomeView`/
    /// `LibraryBrowseView` — `ShellView` owns the state and its top bar
    /// reacts (transparent → near-solid). See `scrollOffsetReader`. Added
    /// P5 Task 6: before this, scrolling Wishlist left the bar however
    /// `HomeView` (the only prior driver) had last left it, instead of
    /// re-solidifying on this section's own scroll.
    @Binding var isScrolled: Bool

    /// Called on Menu when this section's own `path` is already empty — see
    /// `ShellView`'s type doc comment for why the Menu-walk fallback to
    /// `.home` has to be decided here, against this view's own `path`, rather
    /// than via an `.onExitCommand` `ShellView` attaches from outside.
    let onMenuExit: () -> Void

    @State private var wishlistModel = WishlistModel()
    @State private var imageLoader = ImageLoader()
    @State private var path = NavigationPath()

    /// Identical column lockup to `SearchView`/`LibraryBrowseView` — same 2:3
    /// card, same adaptive width, so every poster grid in the app feels like
    /// one system.
    private let gridColumns = [
        GridItem(.adaptive(minimum: 220, maximum: 220), spacing: 32)
    ]

    /// tvOS 17 has no `onScrollGeometryChange` (18+), so scroll offset is read
    /// via a `GeometryReader` + `PreferenceKey` in this named coordinate
    /// space — same idiom as `HomeView.scrollSpace`.
    private static let scrollSpace = "wishlistScroll"

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if let client = model.client {
                    content(client: client)
                        // `.task` reruns on every appearance of this view —
                        // not just once per `WishlistModel` lifetime — because
                        // switching `ShellView.selection` away from `.wishlist`
                        // and back tears down and recreates this whole view
                        // (and `wishlistModel`) fresh (`content` is a plain
                        // `switch` in a `@ViewBuilder`, not a `.tag`-based
                        // `TabView`, so there's nothing to preserve identity
                        // across). (P5 Task 6 correction: an earlier draft of
                        // this comment additionally claimed a `NavigationStack`
                        // push/pop — selecting a card, then Menu-ing back to
                        // this grid — also fires the same appear/disappear
                        // pair; that was never live-verified and shouldn't be
                        // assumed — `NavigationStack` generally keeps a root
                        // view mounted, off-screen, under a pushed destination
                        // rather than tearing it down, so a push/pop by itself
                        // may not actually re-trigger `.task`. The section-switch
                        // teardown above is the mechanism this view actually
                        // relies on.) This re-fetches exactly what's needed:
                        // the wishlist can change while the app runs (a
                        // Phase-3 title-page toggle, or a web user editing it
                        // concurrently), so returning to "My List" should
                        // never show stale membership. Same
                        // idiom as `HomeModel.load`/`LibraryModel.load`, which
                        // have no "already loaded, skip" guard for the same
                        // reason.
                        .task { await wishlistModel.load(client: client) }
                } else {
                    // Defensive only: ShellView only routes to `.wishlist`
                    // once `model.client` is non-nil — same invariant
                    // HomeView/SearchView/LibraryBrowseView's fallbacks
                    // document.
                    ProgressView()
                }
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

    /// Same top padding rationale as `LibraryBrowseView.contentTopPadding`:
    /// `OrbixTopBar` renders over this section (it's a hub, like Library —
    /// see `ShellView.showsTopBar`'s doc comment), and this page has no hero
    /// art meant to bleed under it, so the top padding must clear the bar's
    /// full rendered height rather than deliberately underlap it.
    private static let contentTopPadding: CGFloat = 140

    /// The heading stays mounted across every `loadState` (mirrors the web,
    /// which always renders its `<h1>` regardless of loading/error/empty),
    /// so only the region below it switches.
    @ViewBuilder
    private func content(client: OrbixClient) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 32) {
                heading

                switch wishlistModel.loadState {
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
            .background(scrollOffsetReader)
        }
        .coordinateSpace(name: Self.scrollSpace)
        .modifier(SectionScrollDetector(isScrolled: $isScrolled))
        .accessibilityIdentifier("wishlistScroll")
    }

    /// Measures the content's top edge in the named coordinate space; the
    /// value goes negative as the user scrolls up. Feeds
    /// `SectionScrollDetector`'s tvOS-17 fallback path — same idiom as
    /// `HomeView.scrollOffsetReader`.
    private var scrollOffsetReader: some View {
        GeometryReader { proxy in
            Color.clear.preference(
                key: ScrollOffsetKey.self,
                value: proxy.frame(in: .named(Self.scrollSpace)).minY
            )
        }
    }

    private var heading: some View {
        Text(L10n.t("wishlist.heading"))
            .font(OrbixType.rowHeading)
            .foregroundStyle(OrbixColor.text)
            .accessibilityIdentifier("wishlistHeading")
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
        .accessibilityIdentifier("wishlistGrid")
    }

    /// ~14 tiles, matching the web's `Array.from({length:14})` skeleton
    /// count in `WishlistPage.tsx` (a shorter list than `LibraryBrowseView`'s
    /// 21 — the web page itself uses a smaller skeleton count here, since a
    /// watch-later list is expected to be shorter than a whole library).
    private var skeletonGrid: some View {
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
        .allowsHitTesting(false)
        .accessibilityIdentifier("wishlistSkeleton")
    }

    /// Web's exact copy (`wishlist:empty` / `wishlist:emptyHint` in
    /// `apps/web/src/locales/en/wishlist.json`), as two stacked lines inside
    /// `ContentUnavailableView`'s `description` — the brief's "message + hint"
    /// requirement (`WishlistPage.tsx` lines 21-26).
    private var emptyView: some View {
        ContentUnavailableView {
            Label(L10n.t("wishlist.emptyTitle"), systemImage: "heart")
        } description: {
            VStack(spacing: 6) {
                Text(L10n.t("wishlist.empty"))
                Text(L10n.t("wishlist.emptyHint"))
                    .font(.callout)
            }
        }
        .padding(.top, 60)
        .accessibilityIdentifier("wishlistEmptyState")
    }

    private func errorView(message: String, client: OrbixClient) -> some View {
        ContentUnavailableView {
            Label(L10n.t("wishlist.errorTitle"), systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            Button(L10n.t("common.actions.retry")) {
                Task { await wishlistModel.load(client: client) }
            }
            .accessibilityIdentifier("wishlistRetryButton")
        }
        .padding(.top, 60)
        .accessibilityIdentifier("wishlistErrorState")
    }

    // MARK: - Navigation

    /// Pushes the title/detail page for the selected card — same `TitleRoute`
    /// destination and push mechanics as every other grid in the app.
    private func select(_ card: MediaCard) {
        path.append(TitleRoute(itemId: card.id))
    }
}

/// Drives `WishlistView`: loads `GET /api/wishlist` and exposes a single
/// `loadState`, mirroring `HomeModel`/`LibraryModel`'s shape so
/// loading/error/empty/loaded can't drift out of sync. No sort/filter here
/// (unlike `LibraryModel`), so `pendingTask` only ever guards against the
/// initial `.task` load racing a Retry-button reload — but it still goes
/// through the same cancel-previous-`Task` slot `LibraryModel.load` was
/// fixed to use (commit 4ffe4f1: the initial load and Retry must join the
/// same mechanism, not the bare `guard !isLoading else { return }` re-entrancy
/// check `HomeModel.load` still uses), so a Retry tap while the initial
/// `.task` fetch is still in flight cancels the stale one instead of letting
/// two concurrent fetches race to set `items`.
@MainActor
@Observable
final class WishlistModel {
    enum LoadState: Equatable {
        case loading
        case error(String)
        case empty
        case loaded([MediaCard])
    }

    private(set) var items: [MediaCard] = []
    private(set) var isLoading = false
    private(set) var loadError: String?

    /// Flips to `true` once the first `load` attempt (success or failure)
    /// completes — same reasoning as `HomeModel.hasLoaded`/
    /// `LibraryModel.hasLoaded`: without it, a genuinely empty wishlist would
    /// be indistinguishable from "hasn't loaded yet" for the one frame before
    /// `.task` resolves.
    private(set) var hasLoaded = false

    /// The `load` `Task` most recently started, if one is still pending or in
    /// flight. Cancelled at the top of every `load` call, so at most one is
    /// ever running. `nonisolated(unsafe)`: mirrors `LibraryModel.pendingTask`
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

    /// The view's `.task` (fired on every appearance — see `WishlistView`'s
    /// doc comment) and the error state's Retry button. Routed through the
    /// shared `pendingTask` slot exactly like `LibraryModel.load` post-fix:
    /// a Retry tap while a reappearance's fetch is still in flight cancels
    /// the stale one and replaces it with the newer one, rather than racing
    /// two concurrent fetches to set `items` last.
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
            let fetched = try await client.wishlist()
            // A newer load() call may have cancelled this task (and started
            // its own) while the request was in flight — don't let a slow,
            // superseded response clobber newer state.
            guard !Task.isCancelled else { return }
            items = fetched
            loadError = nil
        } catch {
            guard !Task.isCancelled else { return }
            if case OrbixError.http(_, let code) = error, let code {
                loadError = L10n.errorMessage(code)
            } else {
                loadError = L10n.t("errors.network")
            }
            items = []
        }
        isLoading = false
        hasLoaded = true
    }
}

#Preview {
    WishlistView(model: AppModel(), isScrolled: .constant(false), onMenuExit: {})
}
