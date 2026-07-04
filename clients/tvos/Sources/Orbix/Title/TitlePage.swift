import OrbixKit
import SwiftUI
import UIKit

/// A pushed title/detail-page destination on the shared `NavigationStack`
/// path `HomeView` owns (see `HomeView.path`). A dedicated wrapper type
/// (rather than pushing a bare `String`) so `.navigationDestination(for:)`
/// can't collide with some unrelated `String`-valued destination a future
/// task pushes onto the same stack (e.g. a search query) — `TitleRoute` is
/// specifically "go to the title page for this item id."
struct TitleRoute: Hashable {
    let itemId: String
}

/// SP2 M3 title/detail page for a single item (movie or series), reached by
/// selecting a `PosterCard` from a `HomeView` rail (or from this page's own
/// "More Like This" rail, which pushes another `TitlePage` onto the same
/// stack — see `path`). Loads `GET /api/items/:id` (+ `/similar`, best
/// effort) via `TitleModel` and renders a full-bleed, dimmed backdrop with
/// title/logo, a year·rating·runtime·genres metadata row, the overview, and
/// either a **Play** button (movie) or a season strip (series — episode
/// lists land in M3 Task 4).
struct TitlePage: View {
    let itemId: String
    let model: AppModel
    @Binding var path: [TitleRoute]

    @State private var titleModel = TitleModel()
    @State private var imageLoader = ImageLoader()

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
            detailView(detail, similar: similar)
        }
    }

    private func detailView(_ detail: ItemDetail, similar: [MediaCard]) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 56) {
                hero(detail)

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

    private func hero(_ detail: ItemDetail) -> some View {
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
                    playButton(detail)
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

    /// Always rendered for a movie (never conditionally hidden) so the
    /// tvOS focus engine has a stable target — `disabled` (dimmed, not
    /// actionable) when there's no playable file rather than absent, which
    /// would silently change what's focusable on the page.
    @ViewBuilder
    private func playButton(_ detail: ItemDetail) -> some View {
        let fileId = detail.files?.first?.id
        Button {
            if let fileId { play(fileId: fileId) }
        } label: {
            Label("Play", systemImage: "play.fill")
                .font(.title3.bold())
                .padding(.horizontal, 8)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(fileId == nil)
        .accessibilityIdentifier("titlePagePlayButton")
    }

    /// TODO(M3 Task 3): present the production player — `getProgress` for a
    /// resume position, `playbackInfo(fileId:)`, `AVPlayerViewController`.
    /// The brief explicitly sanctions "Play" always (not "Play"/"Resume")
    /// for this task, deferring resume-awareness to Task 3, which owns
    /// progress/resume end-to-end — so this is a diagnostic no-op rather
    /// than a dead end with no feedback at all, mirroring the pre-Task-2
    /// placeholder `HomeView.select` used to be.
    private func play(fileId: String) {
        print("[TitlePage] Play tapped for fileId \(fileId) — production player lands in M3 Task 3")
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
            // TODO(M3 Task 4): navigate to a SeasonEpisodeView(seasonNumber:)
            // — episode lists + per-episode playback land there. A visible,
            // focusable season strip is this task's whole job for a series.
            print("[TitlePage] season \(season.seasonNumber) tapped — episode navigation lands in M3 Task 4")
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
    TitlePage(itemId: "m1", model: AppModel(), path: .constant([]))
}
