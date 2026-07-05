import OrbixKit
import SwiftUI
import UIKit

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

/// SP2 M3 title/detail page for a single item (movie or series), reached by
/// selecting a `PosterCard` from a `HomeView` rail (or from this page's own
/// "More Like This" rail, which pushes another `TitlePage` onto the same
/// stack — see `path`). Loads `GET /api/items/:id` (+ `/similar`, best
/// effort) via `TitleModel` and renders a full-bleed, dimmed backdrop with
/// title/logo, a year·rating·runtime·genres metadata row, the overview, and
/// either a **Play** button (movie) or a season strip (series — a season
/// chip pushes a `SeasonRoute` onto `path`; see `SeasonEpisodeView.swift`
/// for the M3 Task 4 episode list + per-episode playback + next-episode).
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

    /// Fixed height of the hero backdrop; large enough to read as
    /// "full-bleed" on a 1080pt-tall tvOS screen while still leaving the
    /// season-strip/similar rails visibly peeking in before any scrolling.
    private static let heroHeight: CGFloat = 820

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
    /// path the on-page Play button uses. A series `autoplay` route is a
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
                hero(detail, client: client)

                if isSeries(detail) {
                    seasonStrip(detail)
                }

                if !similar.isEmpty {
                    moreLikeThisRail(similar)
                }
            }
            .padding(.bottom, 80)
        }
        .accessibilityIdentifier("titlePage_\(detail.id)")
    }

    // MARK: - Hero

    private func hero(_ detail: ItemDetail, client: OrbixClient) -> some View {
        ZStack(alignment: .bottomLeading) {
            BackdropImage(url: imageURL(path: detail.backdropPath), imageLoader: imageLoader)
                .frame(height: Self.heroHeight)
                .frame(maxWidth: .infinity)
                .overlay {
                    // Dims the backdrop so title/metadata/overview text
                    // stays legible over an arbitrary, potentially busy
                    // image — heavier toward the bottom, where the text sits.
                    LinearGradient(
                        colors: [.black.opacity(0.1), .black.opacity(0.55), .black.opacity(0.92)],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                }
                .clipped()

            VStack(alignment: .leading, spacing: 20) {
                titleOrLogo(detail)
                metadataRow(detail)
                overviewText(detail)
                if !isSeries(detail) {
                    playButton(detail, client: client)
                        .padding(.top, 8)
                }
            }
            .frame(maxWidth: 1200, alignment: .leading)
            .padding(.horizontal, 64)
            .padding(.bottom, 56)
        }
    }

    @ViewBuilder
    private func titleOrLogo(_ detail: ItemDetail) -> some View {
        if let url = imageURL(path: detail.logoPath) {
            LogoImage(url: url, imageLoader: imageLoader, fallbackTitle: detail.title)
        } else {
            Text(detail.title)
                .font(.system(size: 64, weight: .bold))
                .foregroundStyle(.white)
                .lineLimit(2)
                .shadow(color: .black.opacity(0.6), radius: 8, y: 2)
        }
    }

    @ViewBuilder
    private func metadataRow(_ detail: ItemDetail) -> some View {
        let parts = metadataParts(detail)
        if !parts.isEmpty {
            Text(parts.joined(separator: "   ·   "))
                .font(.callout.weight(.medium))
                .foregroundStyle(.white.opacity(0.8))
        }
    }

    private func metadataParts(_ detail: ItemDetail) -> [String] {
        var parts: [String] = []
        if let year = detail.year { parts.append(String(year)) }
        if let rating = detail.rating, !rating.isEmpty { parts.append(rating) }
        if let runtime = Self.formattedRuntime(detail.runtimeSec) { parts.append(runtime) }
        if let genres = detail.genres, !genres.isEmpty { parts.append(genres.joined(separator: ", ")) }
        return parts
    }

    /// `3720` → `"1h 2m"`; `600` → `"10m"`; `nil`/non-positive → `nil` (the
    /// metadata row simply omits runtime rather than showing "0m").
    private static func formattedRuntime(_ seconds: Int?) -> String? {
        guard let seconds, seconds > 0 else { return nil }
        let hours = seconds / 3600
        let minutes = (seconds % 3600) / 60
        return hours > 0 ? "\(hours)h \(minutes)m" : "\(minutes)m"
    }

    @ViewBuilder
    private func overviewText(_ detail: ItemDetail) -> some View {
        if let overview = detail.overview, !overview.isEmpty {
            Text(overview)
                .font(.title3)
                .foregroundStyle(.white.opacity(0.9))
                .lineLimit(3)
                .frame(maxWidth: 1000, alignment: .leading)
        }
    }

    /// Always rendered for a movie (never conditionally hidden): a dimmed,
    /// `disabled` Play button when there's no playable file communicates
    /// "this title has no file to play" rather than silently omitting the
    /// button, which would look like the page just failed to load one.
    /// (Not a focus-stability concern: tvOS's focus engine simply skips a
    /// `disabled` control rather than parking focus on it, so this is a
    /// visual-affordance choice, not one about what's focusable.)
    @ViewBuilder
    private func playButton(_ detail: ItemDetail, client: OrbixClient) -> some View {
        let fileId = detail.files?.first?.id
        Button {
            if let fileId { presentPlayer(fileId: fileId, title: detail.title, client: client) }
        } label: {
            Label(titleModel.resumeAvailable ? "Resume" : "Play", systemImage: "play.fill")
                .font(.title3.bold())
                .padding(.horizontal, 8)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(fileId == nil)
        .accessibilityIdentifier("titlePagePlayButton")
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
    /// it, so without an explicit refresh, the Play/Resume label and
    /// "More Like This" rail would keep showing pre-playback state until
    /// the user navigated away and back. Re-fetching after the player is
    /// dismissed keeps them current.
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

    // MARK: - Seasons (series)

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

    // MARK: - Images

    private func imageURL(path: String?) -> URL? {
        guard let path, let baseURL = model.baseURL else { return nil }
        return baseURL.appending(path: "api/images/\(path)")
    }
}

/// Drives `TitlePage`: loads `GET /api/items/:id` and, best-effort,
/// `GET /api/items/:id/similar`. A failed `similar` fetch degrades to an
/// empty "More Like This" rail rather than failing the whole page — the
/// main item detail having loaded is what matters; a kids-blocked or
/// missing item 404s the detail fetch itself, which `loadState` surfaces as
/// `.notFound` (see `TitlePage.notFoundView`) rather than a crash.
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

    /// Same "first attempt has resolved one way or another" latch
    /// `HomeModel.hasLoaded` uses, so the single frame before `.task`
    /// starts the first `load` reads as `.loading`, not some other state.
    private(set) var hasLoaded = false

    init() {}

    var loadState: LoadState {
        if let detail {
            return .loaded(detail, similar: similar)
        }
        if isLoading || !hasLoaded { return .loading }
        if notFound { return .notFound }
        return .error(loadError ?? "Something went wrong.")
    }

    /// Fetches the item detail (+ similar, best-effort). Safe to call again
    /// (e.g. the error state's Retry button) once the previous call has
    /// finished — mirrors `HomeModel.load`'s re-entrancy guard.
    func load(itemId: String, client: OrbixClient) async {
        guard !isLoading else { return }
        isLoading = true
        loadError = nil
        notFound = false
        resumeAvailable = false

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

        isLoading = false
        hasLoaded = true
    }
}

/// Full-bleed backdrop art fetched via `ImageLoader`; a plain dark fill
/// while loading or on a missing/failed backdrop — unlike `PosterCard`'s
/// placeholder glyph, there's no sensible icon for a backdrop, and the
/// gradient dimming overlay above it reads fine either way.
private struct BackdropImage: View {
    let url: URL?
    let imageLoader: ImageLoader

    @State private var uiImage: UIImage?

    var body: some View {
        ZStack {
            Color.black
            if let uiImage {
                Image(uiImage: uiImage)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            }
        }
        .clipped()
        .task(id: url) {
            uiImage = nil
            guard let url else { return }
            if let data = await imageLoader.image(for: url) {
                uiImage = UIImage(data: data)
            }
        }
    }
}

/// A title's logo art (transparent-background wordmark), fetched via
/// `ImageLoader`; falls back to the plain title `Text` (same styling
/// `TitlePage.titleOrLogo`'s no-logo branch uses) while loading or on a
/// missing/failed logo.
private struct LogoImage: View {
    let url: URL
    let imageLoader: ImageLoader
    let fallbackTitle: String

    @State private var uiImage: UIImage?

    var body: some View {
        Group {
            if let uiImage {
                Image(uiImage: uiImage)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(maxWidth: 800, maxHeight: 200, alignment: .leading)
            } else {
                Text(fallbackTitle)
                    .font(.system(size: 64, weight: .bold))
                    .foregroundStyle(.white)
                    .lineLimit(2)
                    .shadow(color: .black.opacity(0.6), radius: 8, y: 2)
            }
        }
        .task(id: url) {
            uiImage = nil
            if let data = await imageLoader.image(for: url) {
                uiImage = UIImage(data: data)
            }
        }
    }
}

#Preview {
    TitlePage(itemId: "m1", model: AppModel(), path: .constant(NavigationPath()))
}
