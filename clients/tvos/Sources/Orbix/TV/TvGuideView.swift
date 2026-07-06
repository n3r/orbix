import OrbixKit
import SwiftUI

/// The guide's chosen render mode, persisted under the web's own
/// `localStorage` key (`GUIDE_VIEW_STORAGE_KEY` in `TvGuidePage.tsx`) so a
/// user's list/grid choice survives an app relaunch exactly like it survives
/// a browser refresh on web. `.list` is the default (web: an unset/garbled
/// key, or any value other than the literal string `"grid"`, falls back to
/// list — mirrored by `TvGuideView.initialGuideView`, not a `RawRepresentable`
/// decode, to match that exact fallback semantics).
enum GuideView: String {
    case list, grid
}

/// The guide's active filter — All, Favorites, or one facet (a country or a
/// category), mutually exclusive, mirroring the web's `Filter` union
/// (`TvGuidePage.tsx` lines 15-19).
enum GuideFilter: Hashable {
    case all
    case favorites
    case country(String)
    case category(String)
}

/// Phase 4 Task 5 TV Guide screen, reached by pushing `TvGuideRoute` from
/// `TvHomeView`'s header "Guide" button — tvOS port of `apps/web/src/pages/
/// TvGuidePage.tsx`. Renders a header (title, live channel count, list/grid
/// toggle), an on-page search field, a horizontal filter-chip row (All /
/// Favorites / per-country / per-category, facets derived client-side from
/// the unfiltered first page), and the **LIST** view: a virtualized-in-spirit
/// `LazyVStack` of rows with offset paging. The **GRID** toggle only renders
/// a labeled placeholder this task — the real EPG grid lands in Task 6 (see
/// `gridPlaceholder`).
///
/// Pushed onto **`TvHomeView`'s own `NavigationStack`**, not a stack of its
/// own — `TvHomeView` passes its `path` binding through so this screen's
/// info action can push `TvChannelRoute` onto that same stack (that
/// destination is itself only a Task-7 bridge placeholder today; see
/// `TvHomeView.swift`).
///
/// Web→tvOS adaptations (mirrors `LibraryBrowseView`'s precedents exactly):
/// - **Toggle + filter chips → focusable `Capsule` chip buttons**
///   (`GuideChipStyle`, the `SortChipStyle` adaptation the brief calls for —
///   `Capsule` rather than `SortChipStyle`'s rounded-rect, matching the web
///   chip's `rounded-full`). Selected = accent-tinted fill; focused = white
///   fill/text + scale — identical language to `LibraryBrowseView.sortChip`.
/// - **Search → on-page `TextField`** (`LibraryBrowseView.filterField`
///   pattern, not `.searchable` — avoids the `OrbixTopBar` collision
///   documented there), debounced ~300 ms in `TvGuideModel.queryChanged`
///   (the `LibraryModel.queryChanged`/`SearchModel.queryChanged`
///   cancel-previous-`Task` idiom). Placeholder is the web's actual
///   `tv:guidePage.searchPlaceholder` string, **"Search channels"** (no
///   ellipsis in the source JSON, unlike `catalog:browse.searchPlaceholder`'s
///   "Search titles…" — ported verbatim rather than "fixed" to match a
///   sibling screen's punctuation).
/// - **List rows** (web `TvGuidePage.tsx` lines 225-272): number
///   (`.monospacedDigit()`) · flat `ChannelLogoView` · name +
///   `ChannelNowNextView` · `QualityChip`. **Select tunes**, opening
///   `LiveTvOverlay` with every channel loaded so far (`guideModel.channels`,
///   across all fetched pages — not just the on-screen rows) as the zap
///   context, matching web's `setPlaying({ channels, id: c.id })` where
///   `channels` is the full flattened page list, not the virtualizer's
///   visible slice.
/// - **Info action → `.contextMenu`, not a second focusable "i" button.**
///   The brief offered either; a second always-focusable target crammed
///   into an already-tappable row would fight the row's own Select-to-tune
///   affordance for focus — exactly the reasoning `ChannelCard.swift`'s doc
///   comment already gives for its own secondary (favorite-toggle) action,
///   which is also a `.contextMenu` on an otherwise-plain `Button`. Long-press
///   Select opens "Channel details" → pushes `TvChannelRoute` on the shared
///   `path`.
/// - **Paging**: offset/limit paging mirroring `useTvGuide`'s infinite-query
///   shape (`apps/web/src/lib/queries.ts:131-151`) — `hasMore` is exactly
///   web's `getNextPageParam` test, `loaded < total`, so the next page's
///   offset is just `channels.count`. The tail row's `.onAppear` fires the
///   next fetch (web's virtualizer-tail-index effect, `TvGuidePage.tsx`
///   lines 137-145, reimplemented against a plain `LazyVStack` since SwiftUI
///   has no `useVirtualizer` equivalent).
/// - **Facets**: fetched once from the unfiltered `tvGuide({})` first page
///   (web lines 104-116) via `TvGuideModel.loadFacetsIfNeeded`, independent
///   of the active filter/query — exactly like the web's separate `base`
///   query, so switching filters never shrinks the chip row.
/// - **Scroll-to-top on filter/query change** (web lines 127-135): this port
///   resets on the *live* `query` text change rather than waiting for the
///   debounced fetch to actually land — a deliberate simplification (SwiftUI
///   has no cheap way to observe "the model's internal debounce just fired"
///   from the view) that produces the same end state: the list is back at
///   the top by the time the debounced fetch's fresh page-0 data arrives.
struct TvGuideView: View {
    let model: AppModel
    @Binding var path: NavigationPath

    @State private var guideModel = TvGuideModel()
    @State private var imageLoader = ImageLoader()
    @State private var view: GuideView = TvGuideView.initialGuideView()
    @State private var filter: GuideFilter = .all
    @State private var query = ""
    /// Drives the `.fullScreenCover` live-TV cinema — `nil` when closed.
    @State private var liveContext: LivePlayContext?

    private static let guideViewKey = "orbix.tv.guideView"
    private static let topAnchorId = "tvGuideTop"
    /// Web's `ROW_HEIGHT` (`TvGuidePage.tsx` line 36) — taller than a plain
    /// single-line row to fit the now/next block without clipping.
    private static let rowHeight: CGFloat = 92

    private static func initialGuideView() -> GuideView {
        UserDefaults.standard.string(forKey: guideViewKey) == "grid" ? .grid : .list
    }

    var body: some View {
        Group {
            if let client = model.client {
                content(client: client)
                    .task {
                        guideModel.loadFacetsIfNeeded(client: client)
                        await guideModel.load(client: client, filter: filter, query: query)
                    }
            } else {
                // Defensive only: reached solely via a push from `TvHomeView`,
                // which itself only renders once `model.client` is non-nil —
                // same invariant every other screen's fallback documents.
                ProgressView()
            }
        }
        .onChange(of: filter) { _, newValue in
            guard let client = model.client else { return }
            guideModel.filterChanged(to: newValue, client: client, query: query)
        }
        .onChange(of: query) { _, newValue in
            guard let client = model.client else { return }
            guideModel.queryChanged(newValue, client: client, filter: filter)
        }
        .fullScreenCover(item: $liveContext) { context in
            LiveTvOverlay(
                channels: context.channels,
                initialId: context.initialId,
                model: model,
                onClose: { liveContext = nil }
            )
        }
        .accessibilityIdentifier("tvGuideView")
    }

    // MARK: - Content

    /// Same top-padding rationale as `TvHomeView`/`LibraryBrowseView`:
    /// `OrbixTopBar` still renders over the TV section while this screen is
    /// pushed, and there's no hero art meant to bleed under it.
    private static let contentTopPadding: CGFloat = 140

    @ViewBuilder
    private func content(client: OrbixClient) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    header
                    searchField
                    filterChipsRow

                    if view == .grid {
                        gridPlaceholder
                    } else {
                        listBody(client: client)
                    }
                }
                .padding(.horizontal, 64)
                .padding(.top, Self.contentTopPadding)
                .padding(.bottom, 80)
            }
            .accessibilityIdentifier("tvGuideScroll")
            .onChange(of: filter) { _, _ in scrollToTop(proxy) }
            .onChange(of: query) { _, _ in scrollToTop(proxy) }
        }
    }

    private func scrollToTop(_ proxy: ScrollViewProxy) {
        withAnimation { proxy.scrollTo(Self.topAnchorId, anchor: .top) }
    }

    // MARK: - Header (title, count, list/grid toggle)

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text("TV Guide")
                    .font(OrbixType.rowHeading)
                    .foregroundStyle(OrbixColor.text)
                    .accessibilityIdentifier("tvGuideHeading")
                Text(Self.channelCountLabel(guideModel.total))
                    .font(.callout)
                    .foregroundStyle(OrbixColor.textDim)
                    .accessibilityIdentifier("tvGuideCount")
            }
            Spacer()
            viewToggle
        }
        // Always-present anchor for the filter/query scroll-reset — the
        // header itself renders in every state (loading/error/empty/loaded,
        // list/grid), so it's a stable `scrollTo` target regardless of what
        // the body below it is doing.
        .id(Self.topAnchorId)
    }

    /// Web's `tv:guidePage.channelCount_one`/`_other` pluralization
    /// (`en/tv.json`), as an English literal — this app has no i18n layer.
    private static func channelCountLabel(_ count: Int) -> String {
        count == 1 ? "1 channel" : "\(count) channels"
    }

    private var viewToggle: some View {
        HStack(spacing: 12) {
            guideChip(label: "List", isSelected: view == .list, id: "tvGuideToggle_list") {
                setView(.list)
            }
            guideChip(label: "Grid", isSelected: view == .grid, id: "tvGuideToggle_grid") {
                setView(.grid)
            }
        }
        // Own focus section so left/right between the two toggle chips
        // doesn't bleed into the search field or filter row below it — same
        // convention as `LibraryBrowseView.controlsRow`'s single section for
        // its own chip cluster.
        //
        // Deliberately **no** `.accessibilityIdentifier` on this `HStack`
        // itself: a plain layout container with no accessibility traits of
        // its own isn't a distinct accessibility element, so an identifier
        // applied here doesn't stay local to the container — it cascades
        // down and overwrites each child Button's own identifier (confirmed
        // live: both chips reported the container's id instead of their own
        // `tvGuideToggle_list`/`tvGuideToggle_grid`, breaking the brief's
        // required per-chip identifiers). `ScrollView`/`LazyVStack` don't
        // have this problem — see `filterChipsRow`/`listRows`, whose own
        // container identifiers stayed correctly local while every child
        // chip/row kept its own.
        .focusSection()
    }

    private func setView(_ newValue: GuideView) {
        view = newValue
        UserDefaults.standard.set(newValue.rawValue, forKey: Self.guideViewKey)
    }

    // MARK: - Search field (web `<Input>` → on-page `TextField`)

    private var searchField: some View {
        TextField("", text: $query, prompt: Text("Search channels").foregroundStyle(OrbixColor.textDim))
            .textFieldStyle(.plain)
            .font(.system(size: 24))
            .foregroundStyle(OrbixColor.text)
            .padding(.horizontal, 20)
            .padding(.vertical, 14)
            .frame(width: 420)
            .background(OrbixColor.surface2, in: RoundedRectangle(cornerRadius: OrbixRadius.sm, style: .continuous))
            .accessibilityIdentifier("tvGuideSearchField")
    }

    // MARK: - Filter chip row (All / Favorites / per-country / per-category)

    private var filterChipsRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 16) {
                guideChip(label: "All", isSelected: filter == .all, id: "tvGuideFilterChip_all") {
                    filter = .all
                }
                guideChip(label: "Favorites", isSelected: filter == .favorites, id: "tvGuideFilterChip_favorites") {
                    filter = .favorites
                }
                ForEach(guideModel.countries, id: \.self) { code in
                    guideChip(
                        label: tvRegionName(code) ?? code,
                        isSelected: filter == .country(code),
                        id: "tvGuideFilterChip_country_\(code)"
                    ) {
                        filter = .country(code)
                    }
                }
                ForEach(guideModel.categories, id: \.self) { category in
                    guideChip(
                        label: Self.capitalizedCategory(category),
                        isSelected: filter == .category(category),
                        id: "tvGuideFilterChip_category_\(category)"
                    ) {
                        filter = .category(category)
                    }
                }
            }
            .padding(.vertical, 4)
        }
        // Own focus section, same reasoning as `viewToggle` — a horizontally
        // scrolling chip row should contain its own left/right traversal
        // (matches `LibraryBrowseView.controlsRow`/`TvHomeView`'s per-rail
        // sections).
        .focusSection()
        .accessibilityIdentifier("tvGuideFilterChips")
    }

    /// Web `c.id.charAt(0).toUpperCase() + c.id.slice(1)`
    /// (`TvGuidePage.tsx` line 207's `defaultValue`) — mirrors
    /// `TvHomeView.capitalized` exactly (server category ids are always
    /// lowercase single words, so this reads identically to
    /// `String.capitalized` in practice, but matches the web's exact
    /// transform rather than title-casing every word).
    private static func capitalizedCategory(_ id: String) -> String {
        guard let first = id.first else { return id }
        return first.uppercased() + id.dropFirst()
    }

    private func guideChip(label: String, isSelected: Bool, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 22, weight: isSelected ? .semibold : .regular))
        }
        .buttonStyle(GuideChipStyle(isSelected: isSelected))
        .accessibilityIdentifier(id)
    }

    // MARK: - List body (loadState machine)

    @ViewBuilder
    private func listBody(client: OrbixClient) -> some View {
        switch guideModel.loadState {
        case .loading:
            loadingView
        case .error(let message):
            errorView(message: message, client: client)
        case .empty:
            emptyView
        case .loaded(let channels):
            listRows(channels, client: client)
        }
    }

    /// Web's own LIST loading state is a plain "Loading…" line, not a
    /// skeleton grid (`TvGuidePage.tsx` line 216) — ported as-is rather than
    /// inventing a skeleton-row shape this brief doesn't call for.
    private var loadingView: some View {
        HStack {
            Spacer()
            ProgressView()
            Spacer()
        }
        .padding(.top, 60)
        .accessibilityIdentifier("tvGuideLoadingState")
    }

    /// Web's exact copy (`tv:guidePage.empty`, "No channels match.") — also
    /// the state a zero-favorites filter lands on, since the server just
    /// returns `total: 0` for that query (no separate empty-favorites copy
    /// needed).
    private var emptyView: some View {
        ContentUnavailableView {
            Label("No channels match.", systemImage: "list.and.film")
        } description: {
            Text("Try a different search, or a different filter.")
        }
        .padding(.top, 60)
        .accessibilityIdentifier("tvGuideEmptyState")
    }

    private func errorView(message: String, client: OrbixClient) -> some View {
        ContentUnavailableView {
            Label("Couldn't load channels", systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            Button("Retry") {
                Task { await guideModel.load(client: client, filter: filter, query: query) }
            }
            .accessibilityIdentifier("tvGuideRetryButton")
        }
        .padding(.top, 60)
        .accessibilityIdentifier("tvGuideErrorState")
    }

    /// The `LazyVStack` of rows plus offset paging: the tail row's
    /// `.onAppear` fires the next fetch (web's virtualizer-tail effect,
    /// reimplemented against a plain stack — see the type doc comment).
    private func listRows(_ channels: [TvChannelCard], client: OrbixClient) -> some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(Array(channels.enumerated()), id: \.element.id) { index, channel in
                row(channel)
                    .onAppear {
                        guard index == channels.count - 1 else { return }
                        guideModel.loadMore(client: client, filter: filter, query: query)
                    }
            }
            if guideModel.isLoadingMore {
                HStack {
                    Spacer()
                    ProgressView()
                    Spacer()
                }
                .padding()
                .accessibilityIdentifier("tvGuideLoadingMore")
            }
        }
        .focusSection()
        .accessibilityIdentifier("tvGuideList")
    }

    private func row(_ channel: TvChannelCard) -> some View {
        Button {
            liveContext = LivePlayContext(channels: guideModel.channels, initialId: channel.id)
        } label: {
            HStack(spacing: 16) {
                Text("\(channel.number)")
                    .font(.body.monospacedDigit())
                    .foregroundStyle(OrbixColor.textDim)
                    .frame(width: 64, alignment: .trailing)

                ChannelLogoView(
                    logo: channel.logo,
                    name: channel.name,
                    channelId: channel.id,
                    baseURL: model.baseURL,
                    imageLoader: imageLoader
                )
                .frame(width: 100, height: 60)
                .background(OrbixColor.surface)
                .clipShape(RoundedRectangle(cornerRadius: OrbixRadius.sm, style: .continuous))

                VStack(alignment: .leading, spacing: 4) {
                    Text(channel.name)
                        .font(.body.weight(.medium))
                        .foregroundStyle(OrbixColor.text)
                        .lineLimit(1)
                    ChannelNowNextView(now: channel.now, next: channel.next)
                }

                Spacer(minLength: 8)

                if let quality = channel.quality {
                    QualityChip(label: quality)
                }
            }
            .padding(.horizontal, 20)
            .frame(height: Self.rowHeight, alignment: .center)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(GuideRowStyle())
        .contextMenu {
            Button("Channel details") {
                path.append(TvChannelRoute(channelId: channel.id))
            }
        }
        .accessibilityIdentifier("tvGuideRow_\(channel.id)")
        .accessibilityLabel("Watch \(channel.name)")
    }

    // MARK: - Grid placeholder (Task-6 bridge)

    /// Stands in for the real EPG grid until Task 6 lands it — same
    /// "Task-N bridge" phrasing convention as `TvGuidePlaceholderView`/
    /// `TvChannelPlaceholderView` in `TvHomeView.swift`, so every unfinished
    /// destination in the app reads consistently as "not yet built" rather
    /// than "broken".
    private var gridPlaceholder: some View {
        ContentUnavailableView {
            Label("Grid view", systemImage: "square.grid.3x3")
        } description: {
            Text("The full channel grid is coming in a later phase.")
        }
        .padding(.top, 60)
        .accessibilityIdentifier("tvGuideGridPlaceholder")
    }
}

// MARK: - Chip style (Capsule adaptation of LibraryBrowseView's SortChipStyle)

/// Shared by the list/grid toggle and every filter chip — a focusable
/// `Capsule` chip: selected = accent-tinted fill, focused = white fill/text
/// + scale, matching `LibraryBrowseView.SortChipStyle`'s exact treatment
/// (own precedent doc comment there covers the `.focusEffectDisabled()`
/// rationale) but `Capsule()` instead of a rounded rect, mirroring the web
/// chip's `rounded-full` (`TvGuidePage.tsx`'s `Chip` component).
private struct GuideChipStyle: ButtonStyle {
    let isSelected: Bool
    @Environment(\.isFocused) private var isFocused

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(isFocused ? Color.white : (isSelected ? Color.white : OrbixColor.textDim))
            .padding(.horizontal, 24)
            .padding(.vertical, 12)
            .background(background, in: Capsule())
            .overlay(
                Capsule().strokeBorder(OrbixColor.surface2, lineWidth: isSelected || isFocused ? 0 : 1)
            )
            .overlay(
                Capsule().strokeBorder(Color.white, lineWidth: isFocused ? 3 : 0)
            )
            .scaleEffect(isFocused ? 1.06 : 1.0)
            .animation(.easeOut(duration: 0.15), value: isFocused)
            .focusEffectDisabled()
    }

    private var background: Color {
        isFocused ? Color.white.opacity(0.25) : (isSelected ? OrbixColor.accent : OrbixColor.surface)
    }
}

/// A guide row's focus/press treatment: a subtle surface highlight on focus
/// plus a hairline bottom divider (web's `border-b`), no system platter —
/// same `.focusEffectDisabled()` + own-treatment precedent as
/// `LiveTvOverlay.MiniGuideRowStyle`, the closest sibling (a button-per-row
/// list of channels).
private struct GuideRowStyle: ButtonStyle {
    @Environment(\.isFocused) private var isFocused

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(isFocused ? OrbixColor.surface2 : Color.clear)
            .overlay(alignment: .bottom) {
                Rectangle()
                    .fill(OrbixColor.surface2)
                    .frame(height: 1)
            }
            .scaleEffect(isFocused ? 1.01 : 1.0)
            .animation(.easeOut(duration: 0.15), value: isFocused)
            .focusEffectDisabled()
    }
}

/// Drives `TvGuideView`: offset-paged channel list (`GET /api/tv/guide`),
/// facets derived once from the unfiltered first page, and a single
/// `loadState` mirroring every other hub screen's model shape
/// (`HomeModel`/`LibraryModel`/`WishlistModel`/`TvHomeModel`).
///
/// Paging note: `loadMore` is deliberately **not** routed through the same
/// `pendingTask` slot `load`/`queryChanged`/`filterChanged` cancel-previous
/// on — a page-2+ fetch must *coexist* with the already-settled first page,
/// not cancel it. Instead every reset call bumps `requestId`, and every
/// fetch (reset or paging) is stamped with the generation it was launched
/// under; a response that lands after a newer reset has already fired is
/// silently discarded rather than appending stale channels onto a
/// since-cleared list or clobbering a fresher page-0 result.
@MainActor
@Observable
final class TvGuideModel {
    enum LoadState: Equatable {
        case loading
        case error(String)
        case empty
        case loaded([TvChannelCard])
    }

    /// Same debounce value as `SearchModel`/`LibraryModel` (300-400ms per
    /// the brief's guidance; 300 here, the brief's stated figure for this
    /// screen).
    private static let debounceNanoseconds: UInt64 = 300_000_000
    /// Web's `useTvGuide` default page size (`apps/web/src/lib/queries.ts`
    /// line 132) and the server's own `/tv/guide` default (`tv-catalog.ts`
    /// line 190) — kept explicit here so paging math doesn't depend on
    /// silently agreeing with a server default that could change.
    static let pageLimit = 100

    private(set) var channels: [TvChannelCard] = []
    private(set) var total = 0
    private(set) var isLoading = false
    private(set) var isLoadingMore = false
    private(set) var loadError: String?
    private(set) var hasLoaded = false

    /// Sorted country codes / category ids from the unfiltered first page —
    /// fetched once (`loadFacetsIfNeeded`), never re-derived from the active
    /// (possibly filtered) `channels` list.
    private(set) var countries: [String] = []
    private(set) var categories: [String] = []

    /// Web's `getNextPageParam` test verbatim: more pages exist iff fewer
    /// channels are loaded than the server's reported `total`.
    var hasMore: Bool { channels.count < total }

    /// Bumped on every reset (`load`/`queryChanged`/`filterChanged`); see
    /// the type doc comment's paging note.
    private var requestId = 0

    private nonisolated(unsafe) var pendingTask: Task<Void, Never>?
    private nonisolated(unsafe) var facetsTask: Task<Void, Never>?

    init() {}

    deinit {
        pendingTask?.cancel()
        facetsTask?.cancel()
    }

    var loadState: LoadState {
        guard channels.isEmpty else { return .loaded(channels) }
        if isLoading || !hasLoaded { return .loading }
        if let loadError { return .error(loadError) }
        return .empty
    }

    /// Fetches the unfiltered first page once, purely for its facets (web's
    /// separate `base = useTvGuide({})` query, `TvGuidePage.tsx` lines
    /// 106-116) — best-effort: a failed facet fetch just leaves the chip row
    /// at All/Favorites only, since the main channel list's own error state
    /// (surfaced by `load`) is what the user actually needs to see/retry.
    func loadFacetsIfNeeded(client: OrbixClient) {
        guard facetsTask == nil else { return }
        facetsTask = Task { [weak self] in
            guard let self, let response = try? await client.tvGuide(limit: Self.pageLimit) else { return }
            guard !Task.isCancelled else { return }
            var countrySet = Set<String>()
            var categorySet = Set<String>()
            for channel in response.channels {
                if let country = channel.country { countrySet.insert(country) }
                categorySet.formUnion(channel.categories)
            }
            self.countries = countrySet.sorted()
            self.categories = categorySet.sorted()
        }
    }

    /// The view's initial `.task` and the error state's Retry button:
    /// fetches page 0, cancelling any pending fetch first and joining the
    /// started `Task` (the `LibraryModel`/`WishlistModel` `load()`-joins-
    /// `pendingTask` fix: awaiting `task.value` here, not just firing it,
    /// so a caller that `await`s `load` observes the *settled* state, not a
    /// still-`isLoading` snapshot taken the instant before the fetch
    /// actually starts).
    func load(client: OrbixClient, filter: GuideFilter, query: String) async {
        pendingTask?.cancel()
        requestId += 1
        let id = requestId
        let task = Task { [weak self] in
            guard let self, !Task.isCancelled else { return }
            await self.performLoad(client: client, filter: filter, query: query, offset: 0, requestId: id)
        }
        isLoading = true
        loadError = nil
        pendingTask = task
        await task.value
    }

    /// `TvGuideView`'s `.onChange(of: query)` — once per keystroke on the
    /// system keyboard. Cancels any pending debounce/fetch, then restarts a
    /// fresh `debounceNanoseconds` timer before actually resetting to page 0
    /// (the `SearchModel.queryChanged`/`LibraryModel.queryChanged`
    /// cancel-previous idiom, verbatim).
    func queryChanged(_ text: String, client: OrbixClient, filter: GuideFilter) {
        pendingTask?.cancel()
        requestId += 1
        let id = requestId
        isLoading = true
        loadError = nil
        pendingTask = Task { [weak self] in
            do {
                try await Task.sleep(nanoseconds: Self.debounceNanoseconds)
            } catch {
                return // cancelled before the debounce elapsed
            }
            guard let self, !Task.isCancelled else { return }
            await self.performLoad(client: client, filter: filter, query: text, offset: 0, requestId: id)
        }
    }

    /// `TvGuideView`'s `.onChange(of: filter)` — a discrete chip press, not
    /// typed text, so it skips the debounce sleep but still goes through the
    /// same cancel-previous mechanism (`LibraryModel.sortChanged`'s
    /// precedent) so a slow in-flight fetch for a stale filter can never
    /// clobber a newer one.
    func filterChanged(to filter: GuideFilter, client: OrbixClient, query: String) {
        pendingTask?.cancel()
        requestId += 1
        let id = requestId
        isLoading = true
        loadError = nil
        pendingTask = Task { [weak self] in
            guard let self, !Task.isCancelled else { return }
            await self.performLoad(client: client, filter: filter, query: query, offset: 0, requestId: id)
        }
    }

    /// The tail row's `.onAppear` — fetches the next 100 and appends. Not
    /// routed through `pendingTask` (see the type doc comment); guarded
    /// against re-entrancy and against paging when there's nothing more to
    /// load or a reset is already in flight (which will replace `channels`
    /// out from under an in-progress page fetch anyway).
    func loadMore(client: OrbixClient, filter: GuideFilter, query: String) {
        guard !isLoading, !isLoadingMore, hasMore else { return }
        isLoadingMore = true
        let id = requestId
        Task { [weak self] in
            guard let self else { return }
            await self.performLoad(client: client, filter: filter, query: query, offset: self.channels.count, requestId: id)
        }
    }

    private func performLoad(client: OrbixClient, filter: GuideFilter, query: String, offset: Int, requestId id: Int) async {
        do {
            let response = try await fetch(client: client, filter: filter, query: query, offset: offset)
            // A newer reset (load/queryChanged/filterChanged) may have
            // superseded this fetch — whether it's a page-0 reset or a
            // page-2+ append, a stale response must never land on top of
            // newer state.
            guard id == requestId else { return }
            if offset == 0 {
                channels = response.channels
            } else {
                channels.append(contentsOf: response.channels)
            }
            total = response.total
            loadError = nil
        } catch {
            guard id == requestId else { return }
            if offset == 0 {
                loadError = "Couldn't load channels: \(error)"
                channels = []
            }
            // A failed page-2+ fetch is silent: the already-loaded channels
            // stay on screen; `isLoadingMore` still clears below so the tail
            // row's `.onAppear` can retry on next scroll-to-tail.
        }
        if offset == 0 {
            isLoading = false
        } else {
            isLoadingMore = false
        }
        hasLoaded = true
    }

    private func fetch(client: OrbixClient, filter: GuideFilter, query: String, offset: Int) async throws -> TvGuideResponse {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let q = trimmed.isEmpty ? nil : trimmed
        switch filter {
        case .all:
            return try await client.tvGuide(q: q, offset: offset, limit: Self.pageLimit)
        case .favorites:
            return try await client.tvGuide(favorites: true, q: q, offset: offset, limit: Self.pageLimit)
        case .country(let code):
            return try await client.tvGuide(country: code, q: q, offset: offset, limit: Self.pageLimit)
        case .category(let category):
            return try await client.tvGuide(category: category, q: q, offset: offset, limit: Self.pageLimit)
        }
    }
}

#Preview {
    NavigationStack {
        TvGuideView(model: AppModel(), path: .constant(NavigationPath()))
    }
}
