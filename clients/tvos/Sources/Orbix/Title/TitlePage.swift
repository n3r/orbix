import OrbixKit
import SwiftUI

/// A pushed title/detail-page destination on the shared `NavigationStack`
/// path `HomeView` owns (see `HomeView.path`, a type-erased `NavigationPath`
/// specifically so it can also carry `SeasonRoute` — see that type in
/// `SeasonEpisodeView.swift`). A dedicated wrapper type (rather than pushing
/// a bare `String`) so `.navigationDestination(for:)` can't collide with
/// some unrelated `String`-valued destination a future task pushes onto the
/// same stack (e.g. a search query) — `TitleRoute` is specifically "go to
/// the title page for this item id."
struct TitleRoute: Hashable {
    let itemId: String
    /// Direct-play deep-link (the web `?play=1`): when set, `TitlePage`
    /// presents the player once on load for a **movie** with a playable file.
    /// A series `autoplay` route just shows the title page — resolving the
    /// first owned episode is the Phase-3 title/episode rebuild's job.
    /// Still `Hashable` (String + Bool) so it can ride the `NavigationPath`.
    var autoplay: Bool = false
}

/// Phase 3 Task 3 title/detail page for a single item (movie or series),
/// reached by selecting a `PosterCard`/billboard "More Info" from `HomeView`
/// (or from this page's own "More Like This" rail, which pushes another
/// `TitlePage` onto the same stack — see `path`). Loads `GET /api/items/:id`
/// (+ `/similar`, best effort) via `TitleModel` and renders the shared
/// cinematic `TitleHeroView` (backdrop/logo, `RatingBadges`, meta row,
/// overview, Play/Resume + optimistic Wishlist toggle — tvOS port of the
/// web's `apps/web/src/components/TitleHero.tsx`), then a page body mirroring
/// `apps/web/src/pages/TitlePage.tsx`'s section order: hero → (series: season
/// strip, unchanged this task) → unmatched notice → Cast rail → More Like
/// This → Details. A season chip pushes a `SeasonRoute` onto `path`; see
/// `SeasonEpisodeView.swift` for the Task 4 episode list + per-episode
/// playback + next-episode (which also retires the season strip in favor of
/// inline tabs + grid).
struct TitlePage: View {
    let itemId: String
    let model: AppModel
    @Binding var path: NavigationPath
    /// Direct-play deep-link from a `TitleRoute(autoplay: true)` push (the
    /// billboard's **Play** — web `?play=1`). Presents the player once, for a
    /// movie only; see `autoplayIfNeeded`.
    var autoplay: Bool = false

    @State private var titleModel = TitleModel()
    @State private var imageLoader = ImageLoader()
    @State private var playbackTarget: PlaybackTarget?

    /// One-shot latch so the movie autoplay fires exactly once — not again
    /// when `detailView` re-appears after the player is dismissed (which
    /// `refreshAfterPlayback` triggers) or on any other re-render.
    @State private var didAutoplay = false

    var body: some View {
        Group {
            if let client = model.client {
                content(client: client)
                    .task { await titleModel.load(itemId: itemId, client: client) }
            } else {
                // Defensive only: TitlePage is only ever pushed from a
                // context where `model.client` is already non-nil (the same
                // invariant HomeView/PosterCard rely on) — see `select` in
                // HomeView and `selectSimilar` below.
                ProgressView()
            }
        }
        .fullScreenCover(item: $playbackTarget, onDismiss: refreshAfterPlayback) { target in
            PlayerScreen(
                itemId: itemId,
                fileId: target.fileId,
                title: target.title,
                client: target.client,
                baseURL: target.baseURL
            )
        }
    }

    @ViewBuilder
    private func content(client: OrbixClient) -> some View {
        switch titleModel.loadState {
        case .loading:
            ProgressView("Loading…")
                .font(.title3)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .notFound:
            notFoundView
        case .error(let message):
            errorView(message: message, client: client)
        case .loaded(let detail, let similar):
            detailView(detail, similar: similar, client: client)
                .onAppear { autoplayIfNeeded(detail, client: client) }
        }
    }

    /// Fires the direct-play deep-link once: only when `autoplay` was
    /// requested, only for a **movie** (web parity: movie → first file), and
    /// only when there's a playable file. Reuses the same `presentPlayer`
    /// path the hero's Play button uses. A series `autoplay` route is a
    /// no-op here (documented Phase-2 decision — it just shows the page).
    private func autoplayIfNeeded(_ detail: ItemDetail, client: OrbixClient) {
        guard autoplay, !didAutoplay, detail.kind == "movie",
              let fileId = detail.files?.first?.id else { return }
        didAutoplay = true
        presentPlayer(fileId: fileId, title: detail.title, client: client)
    }

    private func detailView(_ detail: ItemDetail, similar: [MediaCard], client: OrbixClient) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 56) {
                TitleHeroView(
                    detail: detail,
                    baseURL: model.baseURL,
                    imageLoader: imageLoader,
                    canPlay: canPlay(detail),
                    resumeAvailable: isSeries(detail) ? false : titleModel.resumeAvailable,
                    inWishlist: titleModel.inWishlist,
                    onPlay: { onHeroPlay(detail, client: client) },
                    onToggleWishlist: { Task { await titleModel.toggleWishlist(client: client) } }
                )

                if isSeries(detail) {
                    seasonStrip(detail)
                }

                unmatchedNotice(detail)

                if let cast = detail.cast, !cast.isEmpty {
                    castRail(cast)
                }

                if !similar.isEmpty {
                    moreLikeThisRail(similar)
                }

                detailsBlock(detail)
            }
            .padding(.bottom, 80)
        }
        .accessibilityIdentifier("titlePage_\(detail.id)")
    }

    // MARK: - Hero (TitleHeroView wiring)

    /// Web parity (`TitlePage.tsx` `canPlay`): movie → a playable file
    /// exists; series → at least one season is known. Drives both
    /// `TitleHeroView.canPlay` (dims/disables Play) and `onHeroPlay`'s guard.
    private func canPlay(_ detail: ItemDetail) -> Bool {
        isSeries(detail) ? !(detail.seasons ?? []).isEmpty : detail.files?.first != nil
    }

    /// Web parity (`TitlePage.tsx` `startPlayback`): a movie plays its first
    /// file directly through the existing `presentPlayer`/`fullScreenCover`
    /// plumbing. **Task-4 bridge:** a series has no inline first-episode
    /// playback yet, so the hero's Play instead pushes the first non-specials
    /// season via the existing `SeasonRoute` — the same destination a season
    /// chip in `seasonStrip` pushes. Task 4 replaces the season strip with
    /// inline tabs + a grid and wires true first-episode play here.
    private func onHeroPlay(_ detail: ItemDetail, client: OrbixClient) {
        if isSeries(detail) {
            guard let firstSeason = detail.seasons?.first(where: { $0.seasonNumber > 0 }) ?? detail.seasons?.first else { return }
            path.append(SeasonRoute(seriesId: itemId, seasonNumber: firstSeason.seasonNumber))
        } else if let fileId = detail.files?.first?.id {
            presentPlayer(fileId: fileId, title: detail.title, client: client)
        }
    }

    /// Presents the production player (`PlayerScreen`) full-screen — see
    /// `body`'s `.fullScreenCover(item: $playbackTarget)`. A defensive no-op
    /// if `model.baseURL` is somehow nil here; in practice it's always set
    /// alongside `client` (see `AppModel.configure`), which this method
    /// already requires a caller to have obtained (same invariant as
    /// `content(client:)`'s own guard).
    private func presentPlayer(fileId: String, title: String, client: OrbixClient) {
        guard let baseURL = model.baseURL else { return }
        playbackTarget = PlaybackTarget(fileId: fileId, title: title, client: client, baseURL: baseURL)
    }

    /// `.fullScreenCover` covers `TitlePage` rather than pushing away from
    /// it, so without an explicit refresh, the hero's Play/Resume label,
    /// wishlist membership, and "More Like This" rail would keep showing
    /// pre-playback state until the user navigated away and back. Re-fetching
    /// after the player is dismissed keeps them current.
    private func refreshAfterPlayback() {
        guard let client = model.client else { return }
        Task { await titleModel.load(itemId: itemId, client: client) }
    }

    /// Identifies one presentation of the production player — see
    /// `presentPlayer`/`body`'s `.fullScreenCover(item:)`. `id` is a fresh
    /// `UUID` per instance (not e.g. `fileId`) so tapping Play again after
    /// closing the player always starts a brand-new presentation (and thus
    /// a brand-new `PlaybackController`/play session) rather than SwiftUI
    /// treating it as the same identity.
    private struct PlaybackTarget: Identifiable {
        let id = UUID()
        let fileId: String
        let title: String
        let client: OrbixClient
        let baseURL: URL
    }

    // MARK: - Unmatched notice (web TitlePage.tsx lines 142-144)

    /// A `matchState` other than `"matched"`/`"manual"` means the scanner
    /// never found (or a human never confirmed) a TMDB/TVDB match — web
    /// shows a yellow inline notice and a "fix match" control; TV has no
    /// fix-match UI (admin-only, web-only per the brief), just the notice.
    @ViewBuilder
    private func unmatchedNotice(_ detail: ItemDetail) -> some View {
        if detail.matchState != "matched", detail.matchState != "manual" {
            Text("Metadata not matched yet — scan with a TMDB token to enrich.")
                .font(.callout)
                .foregroundStyle(OrbixColor.warning)
                .padding(.horizontal, 64)
                .accessibilityIdentifier("titlePageUnmatchedNotice")
        }
    }

    // MARK: - Cast (web TitlePage.tsx lines 146-161)

    private func castRail(_ cast: [ItemDetail.CastMember]) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Cast")
                .font(.title3.bold())
                .foregroundStyle(OrbixColor.text)
                .padding(.leading, 4)

            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 24) {
                    ForEach(Array(cast.enumerated()), id: \.offset) { index, member in
                        castCard(member, index: index)
                    }
                }
                .padding(.horizontal, 4)
                .padding(.vertical, 16)
            }
            .focusSection()
        }
        .padding(.horizontal, 64)
        .accessibilityIdentifier("titlePageCastRail")
    }

    /// `Button(action: {})` rather than a plain plate: on tvOS a
    /// `ScrollView(.horizontal)` only auto-scrolls to reveal off-screen
    /// content when something inside is focusable (unlike the web's
    /// non-interactive `<div>` cards) — matches `seasonChip`/`PosterCard`'s
    /// focusable-card convention. There's no cast-detail destination to
    /// navigate to, so the action is intentionally a no-op.
    private func castCard(_ member: ItemDetail.CastMember, index: Int) -> some View {
        Button {
            // No-op: no cast-detail page exists on TV; the card exists so
            // the rail is focus-navigable, matching web's read-only cards.
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                Text(member.name)
                    .font(.headline)
                    .foregroundStyle(OrbixColor.text)
                    .lineLimit(1)
                if let character = member.character, !character.isEmpty {
                    Text(character)
                        .font(.subheadline)
                        .foregroundStyle(OrbixColor.textDim)
                        .lineLimit(1)
                }
            }
            .frame(width: 200, alignment: .leading)
            .padding(16)
            .background(OrbixColor.surface, in: RoundedRectangle(cornerRadius: OrbixRadius.md, style: .continuous))
        }
        .buttonStyle(.card)
        .accessibilityIdentifier("castCard_\(index)")
    }

    // MARK: - Seasons (series — unchanged this task; Task 4 replaces this
    // strip with inline season tabs + an episode grid and retires
    // `SeasonRoute`)

    private func isSeries(_ detail: ItemDetail) -> Bool {
        detail.kind == "series"
    }

    private func seasonStrip(_ detail: ItemDetail) -> some View {
        let seasons = detail.seasons ?? []
        return VStack(alignment: .leading, spacing: 20) {
            Text("Seasons")
                .font(.title3.bold())
                .padding(.leading, 4)

            if seasons.isEmpty {
                Text("No seasons available yet")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.leading, 4)
                    .accessibilityIdentifier("titlePageNoSeasonsState")
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(spacing: 24) {
                        ForEach(seasons, id: \.seasonNumber) { season in
                            seasonChip(season)
                        }
                    }
                    .padding(.horizontal, 4)
                    .padding(.vertical, 16)
                }
                .focusSection()
            }
        }
        .padding(.horizontal, 64)
        .accessibilityIdentifier("titlePageSeasonStrip")
    }

    private func seasonChip(_ season: ItemDetail.SeasonSummary) -> some View {
        Button {
            path.append(SeasonRoute(seriesId: itemId, seasonNumber: season.seasonNumber))
        } label: {
            VStack(spacing: 8) {
                Text(seasonLabel(season))
                    .font(.headline)
                    .lineLimit(1)
                if let episodeCount = season.episodeCount {
                    Text("\(episodeCount) episode\(episodeCount == 1 ? "" : "s")")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(width: 200, height: 110)
            .background(.secondary.opacity(0.2), in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.card)
        .accessibilityIdentifier("seasonChip_\(season.seasonNumber)")
    }

    private func seasonLabel(_ season: ItemDetail.SeasonSummary) -> String {
        if let name = season.name, !name.isEmpty {
            return name
        }
        return "Season \(season.seasonNumber)"
    }

    // MARK: - More like this

    private func moreLikeThisRail(_ items: [MediaCard]) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("More Like This")
                .font(.title3.bold())
                .padding(.leading, 4)

            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 32) {
                    ForEach(items, id: \.id) { card in
                        PosterCard(card: card, baseURL: model.baseURL, imageLoader: imageLoader) {
                            selectSimilar(card)
                        }
                    }
                }
                .padding(.horizontal, 4)
                .padding(.vertical, 16)
            }
            .focusSection()
        }
        .padding(.horizontal, 64)
        .accessibilityIdentifier("titlePageMoreLikeThisRail")
    }

    /// Pushes another `TitlePage` onto the same shared stack `HomeView`
    /// owns — selecting a "More Like This" card drills further in exactly
    /// like selecting a home-rail card does, arbitrarily deep.
    private func selectSimilar(_ card: MediaCard) {
        path.append(TitleRoute(itemId: card.id))
    }

    // MARK: - Details (web TitlePage.tsx lines 167-179)

    @ViewBuilder
    private func detailsBlock(_ detail: ItemDetail) -> some View {
        if detail.director != nil || !(detail.genres ?? []).isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                if let director = detail.director {
                    detailLine(label: "Director", value: director.name)
                }
                if let genres = detail.genres, !genres.isEmpty {
                    detailLine(label: "Genres", value: genres.joined(separator: ", "))
                }
            }
            .padding(.horizontal, 64)
            .accessibilityIdentifier("titlePageDetails")
        }
    }

    private func detailLine(label: String, value: String) -> some View {
        (
            Text("\(label): ").foregroundStyle(OrbixColor.text)
                + Text(value).foregroundStyle(OrbixColor.textDim)
        )
        .font(.callout)
    }

    // MARK: - Loading / empty / error states

    private var notFoundView: some View {
        ContentUnavailableView(
            "Not available",
            systemImage: "eye.slash",
            description: Text("This title isn't available right now.")
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("titlePageNotFound")
    }

    private func errorView(message: String, client: OrbixClient) -> some View {
        ContentUnavailableView {
            Label("Couldn't load title", systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            Button("Retry") {
                Task { await titleModel.load(itemId: itemId, client: client) }
            }
            .accessibilityIdentifier("titlePageRetryButton")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("titlePageErrorState")
    }
}

/// Drives `TitlePage`: loads `GET /api/items/:id` and, best-effort,
/// `GET /api/items/:id/similar` + `GET /api/wishlist/ids`. A failed
/// `similar`/wishlist fetch degrades gracefully (empty "More Like This" rail;
/// hidden wishlist toggle) rather than failing the whole page — the main item
/// detail having loaded is what matters; a kids-blocked or missing item 404s
/// the detail fetch itself, which `loadState` surfaces as `.notFound` (see
/// `TitlePage.notFoundView`) rather than a crash.
@MainActor
@Observable
final class TitleModel {
    enum LoadState: Equatable {
        case loading
        case notFound
        case error(String)
        case loaded(ItemDetail, similar: [MediaCard])
    }

    private(set) var detail: ItemDetail?
    private(set) var similar: [MediaCard] = []
    private(set) var isLoading = false
    private(set) var loadError: String?
    private(set) var notFound = false

    /// Whether the Play button should read "Resume" — a movie only
    /// (a series doesn't render this page's Play button at all; per-episode
    /// resume lands in M3 Task 4), and only when there's a saved position
    /// short of "finished". Best-effort: a `getProgress` failure just leaves
    /// this `false` ("Play"), the same graceful-degradation `similar` gets.
    private(set) var resumeAvailable = false

    /// Wishlist membership for the hero's toggle — `nil` while unknown
    /// (still loading, or the `wishlistIds` fetch failed/400'd), matching web
    /// `inWishlist === undefined` (`TitleHero.tsx` line 112): `TitleHeroView`
    /// hides the toggle entirely rather than guessing. Reset to `nil` at the
    /// top of every `load` so a reload starts from "unknown" again, not
    /// stale membership from a previous item.
    private(set) var inWishlist: Bool?

    /// Same "first attempt has resolved one way or another" latch
    /// `HomeModel.hasLoaded` uses, so the single frame before `.task`
    /// starts the first `load` reads as `.loading`, not some other state.
    private(set) var hasLoaded = false

    /// The most recently `load`-ed item id, remembered so `toggleWishlist`
    /// (which the brief specifies as taking only a `client:`, no `itemId:`)
    /// has something to call `add/removeFromWishlist(itemId:)` with.
    private var loadedItemId: String?

    init() {}

    var loadState: LoadState {
        if let detail {
            return .loaded(detail, similar: similar)
        }
        if isLoading || !hasLoaded { return .loading }
        if notFound { return .notFound }
        return .error(loadError ?? "Something went wrong.")
    }

    /// Fetches the item detail (+ similar, + wishlist membership, all
    /// best-effort past the detail fetch). Safe to call again (e.g. the
    /// error state's Retry button, or `TitlePage.refreshAfterPlayback`) once
    /// the previous call has finished — mirrors `HomeModel.load`'s
    /// re-entrancy guard.
    func load(itemId: String, client: OrbixClient) async {
        guard !isLoading else { return }
        isLoading = true
        loadError = nil
        notFound = false
        resumeAvailable = false
        inWishlist = nil
        loadedItemId = itemId

        do {
            detail = try await client.itemDetail(id: itemId)
        } catch {
            if let orbixError = error as? OrbixError, case .http(404) = orbixError {
                notFound = true
            } else {
                loadError = "Couldn't load title: \(error)"
            }
            isLoading = false
            hasLoaded = true
            return
        }

        similar = (try? await client.similar(id: itemId)) ?? []

        // Resume-awareness only matters for a movie's single Play button —
        // a series doesn't render one here (Task 4 owns per-episode
        // play/resume) — and only when there's actually a file to play.
        if let detail, detail.kind != "series", detail.files?.first != nil,
           let progress = try? await client.getProgress(itemId: itemId, episodeId: nil) {
            resumeAvailable = progress.positionSec > 0 && !progress.finished
        }

        inWishlist = (try? await client.wishlistIds()).map { $0.contains(itemId) }

        isLoading = false
        hasLoaded = true
    }

    /// Web parity (`TitlePage.tsx` lines 111-113 → `useToggleWishlist`):
    /// optimistic flip, revert on failure. **Known live gap:** the NAS may
    /// run a server build without the wishlist device-auth fix, in which
    /// case `add/removeFromWishlist` 400s and this flips then reverts —
    /// that's the expected, graceful degradation this task's smoke checks
    /// for, not a bug to chase.
    func toggleWishlist(client: OrbixClient) async {
        guard let current = inWishlist, let itemId = loadedItemId else { return }
        inWishlist = !current
        do {
            if current {
                try await client.removeFromWishlist(itemId: itemId)
            } else {
                try await client.addToWishlist(itemId: itemId)
            }
        } catch {
            inWishlist = current
        }
    }
}

#Preview {
    TitlePage(itemId: "m1", model: AppModel(), path: .constant(NavigationPath()))
}
