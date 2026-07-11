import OrbixKit
import SwiftUI

struct TitleRoute: Hashable {
    let itemId: String
    let resumeSeasonNumber: Int?
    let resumeEpisodeNumber: Int?
    let resumeEpisodeTitle: String?

    init(
        itemId: String,
        resumeSeasonNumber: Int? = nil,
        resumeEpisodeNumber: Int? = nil,
        resumeEpisodeTitle: String? = nil
    ) {
        self.itemId = itemId
        self.resumeSeasonNumber = resumeSeasonNumber
        self.resumeEpisodeNumber = resumeEpisodeNumber
        self.resumeEpisodeTitle = resumeEpisodeTitle
    }

    init(itemId: String, resume: MediaCard.Resume?) {
        self.init(
            itemId: itemId,
            resumeSeasonNumber: resume?.seasonNumber,
            resumeEpisodeNumber: resume?.episodeNumber,
            resumeEpisodeTitle: resume?.episodeTitle
        )
    }

    var resumeEpisodeLabel: String? {
        guard let resumeSeasonNumber, let resumeEpisodeNumber else { return nil }
        return "S\(resumeSeasonNumber)E\(resumeEpisodeNumber)"
    }
}

struct TitleDetailView: View {
    let itemId: String
    var preferredSeasonNumber: Int?
    var resumeEpisodeNumber: Int?
    var resumeEpisodeLabel: String?
    let model: AppModel
    @Binding var path: NavigationPath

    @State private var titleModel = TitleModel()
    @State private var imageLoader = ImageLoader()
    @State private var playbackTarget: PlaybackTarget?
    @State private var resolvingSeriesAction = false

    var body: some View {
        Group {
            if let client = model.client {
                content(client: client)
                    .task { await titleModel.load(itemId: itemId, client: client) }
            } else {
                ProgressView()
            }
        }
        .background(OrbixScreenBackground())
        .navigationBarTitleDisplayMode(.inline)
        .fullScreenCover(item: $playbackTarget, onDismiss: refreshAfterPlayback) { target in
            PlayerScreen(
                itemId: itemId,
                fileId: target.fileId,
                episodeId: target.episodeId,
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
            ProgressView("Loading")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .notFound:
            ContentUnavailableView(
                "Not available",
                systemImage: "eye.slash",
                description: Text("This title isn't available right now.")
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .error(let message):
            ContentUnavailableView {
                Label("Couldn't load title", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Retry") { Task { await titleModel.load(itemId: itemId, client: client) } }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .loaded(let detail, let similar):
            detailContent(detail, similar: similar, client: client)
        }
    }

    private func detailContent(_ detail: ItemDetail, similar: [MediaCard], client: OrbixClient) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                hero(detail, client: client)

                if let overview = detail.overview, !overview.isEmpty {
                    OrbixGlassPanel {
                        VStack(alignment: .leading, spacing: 8) {
                            OrbixEyebrow(text: "Overview", color: OrbixMobileStyle.teal)
                            Text(overview)
                                .font(.body)
                                .foregroundStyle(.white.opacity(0.9))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }

                infoBlock(detail)

                if detail.kind == "series" {
                    seasons(detail)
                }

                if !similar.isEmpty {
                    moreLikeThis(similar)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 14)
            .padding(.bottom, 126)
        }
    }

    private func hero(_ detail: ItemDetail, client: OrbixClient) -> some View {
        GeometryReader { geometry in
            ZStack(alignment: .bottomLeading) {
                RemoteImage(url: imageURL(detail.backdropPath ?? detail.posterPath), imageLoader: imageLoader) {
                    ImagePlaceholder(systemName: "film")
                }
                .frame(width: geometry.size.width, height: 342)

                LinearGradient(
                    colors: [.black.opacity(0.3), .black.opacity(0.76), .black.opacity(0.96)],
                    startPoint: .top,
                    endPoint: .bottom
                )

                VStack(alignment: .leading, spacing: 14) {
                    HStack(alignment: .bottom, spacing: 14) {
                        RemoteImage(url: imageURL(detail.posterPath), imageLoader: imageLoader) {
                            ImagePlaceholder(systemName: "film")
                        }
                        .frame(width: 104, height: 156)
                        .clipShape(RoundedRectangle(cornerRadius: 7))
                        .overlay {
                            RoundedRectangle(cornerRadius: 7).stroke(OrbixMobileStyle.stroke, lineWidth: 1)
                        }
                        .shadow(color: .black.opacity(0.42), radius: 16, y: 10)

                        VStack(alignment: .leading, spacing: 9) {
                            OrbixEyebrow(text: detail.kind == "series" ? "Series" : "Movie")
                            Text(detail.title)
                                .font(.system(size: 29, weight: .black))
                                .lineLimit(3)
                                .minimumScaleFactor(0.72)

                            metadataRow(detail)
                        }
                    }

                    if detail.kind == "series" {
                        seriesActionButton(detail)
                    } else {
                        playButton(detail, client: client)
                    }

                    wishlistButton(detail, client: client)
                }
                .padding(14)
            }
            .frame(width: geometry.size.width, height: 342)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay {
                RoundedRectangle(cornerRadius: 8).stroke(OrbixMobileStyle.stroke, lineWidth: 1)
            }
        }
        .frame(height: 342)
    }

    @ViewBuilder
    private func metadataRow(_ detail: ItemDetail) -> some View {
        let parts = metadataParts(detail)
        if !parts.isEmpty {
            Text(parts.joined(separator: "  •  "))
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func playButton(_ detail: ItemDetail, client: OrbixClient) -> some View {
        let fileId = detail.files?.first?.id
        return Button {
            if let fileId {
                presentPlayer(fileId: fileId, title: detail.title, client: client)
            }
        } label: {
            OrbixPrimaryActionLabel(
                title: titleModel.resumeAvailable ? "Resume" : "Play",
                systemImage: "play.fill"
            )
            .background(.white, in: Capsule())
            .foregroundStyle(.black)
        }
        .buttonStyle(.plain)
        .disabled(fileId == nil)
    }

    private func wishlistButton(_ detail: ItemDetail, client: OrbixClient) -> some View {
        Button {
            Task { await titleModel.toggleWishlist(itemId: detail.id, client: client) }
        } label: {
            Label(
                titleModel.isWishlisted ? "In My List" : "My List",
                systemImage: titleModel.isWishlisted ? "checkmark" : "plus"
            )
            .font(.subheadline.bold())
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(OrbixMobileStyle.panelStrong, in: Capsule())
            .overlay {
                Capsule().stroke(OrbixMobileStyle.stroke, lineWidth: 1)
            }
        }
        .buttonStyle(.plain)
        .foregroundStyle(.white)
        .disabled(titleModel.isUpdatingWishlist)
        .accessibilityIdentifier("wishlist-toggle-button")
    }

    private func seriesActionButton(_ detail: ItemDetail) -> some View {
        let seasonNumber = preferredSeason(in: detail)?.seasonNumber
        let title = resumeEpisodeLabel.map { "Continue \($0)" } ?? "Episodes"
        return Button {
            handleSeriesPrimaryAction(detail, seasonNumber: seasonNumber)
        } label: {
            HStack(spacing: 8) {
                Spacer(minLength: 0)
                if resolvingSeriesAction {
                    ProgressView()
                        .tint(.black)
                } else {
                    Image(systemName: resumeEpisodeLabel == nil ? "list.bullet" : "play.fill")
                }
                Text(title)
                Spacer(minLength: 0)
            }
            .font(.headline)
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .background(.white, in: Capsule())
        .foregroundStyle(.black)
        .disabled(seasonNumber == nil || resolvingSeriesAction)
        .accessibilityIdentifier("series-primary-action")
    }

    @ViewBuilder
    private func infoBlock(_ detail: ItemDetail) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            OrbixEyebrow(text: "Credits", color: OrbixMobileStyle.amber)
            if let director = detail.director {
                Text("Director: \(director.name)")
                    .font(.footnote)
                    .foregroundStyle(OrbixMobileStyle.secondaryText)
            }

            if let cast = detail.cast, !cast.isEmpty {
                Text("Cast: \(cast.prefix(5).map(\.name).joined(separator: ", "))")
                    .font(.footnote)
                    .foregroundStyle(OrbixMobileStyle.secondaryText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 2)
    }

    private func seasons(_ detail: ItemDetail) -> some View {
        let seasons = sortedSeasons(detail)
        let preferredSeasonNumber = preferredSeason(in: detail)?.seasonNumber
        return VStack(alignment: .leading, spacing: 12) {
            OrbixSectionHeader(title: "Episodes", detail: seasons.isEmpty ? nil : "\(seasons.count) seasons")

            if seasons.isEmpty {
                Text("No seasons available yet")
                    .font(.callout)
                    .foregroundStyle(OrbixMobileStyle.secondaryText)
            } else {
                if let preferredSeasonNumber {
                    Button {
                        path.append(SeasonRoute(seriesId: itemId, seasonNumber: preferredSeasonNumber))
                    } label: {
                        Label("Browse Episodes", systemImage: "list.bullet")
                            .font(.headline)
                            .frame(maxWidth: .infinity, minHeight: 48)
                            .background(OrbixMobileStyle.panelStrong, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.white)
                    .accessibilityIdentifier("browse-episodes-button")
                }

                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(spacing: 10) {
                        ForEach(seasons, id: \.seasonNumber) { season in
                            Button {
                                path.append(SeasonRoute(seriesId: itemId, seasonNumber: season.seasonNumber))
                            } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(season.name?.isEmpty == false ? season.name! : "Season \(season.seasonNumber)")
                                        .font(.subheadline.bold())
                                        .lineLimit(1)
                                    if let count = season.episodeCount {
                                        Text("\(count) episode\(count == 1 ? "" : "s")")
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                .frame(width: 150, height: 74, alignment: .leading)
                                .padding(.horizontal, 12)
                                .background(OrbixMobileStyle.panel, in: RoundedRectangle(cornerRadius: 8))
                                .overlay {
                                    if season.seasonNumber == preferredSeasonNumber {
                                        RoundedRectangle(cornerRadius: 8)
                                            .stroke(OrbixMobileStyle.red, lineWidth: 2)
                                    } else {
                                        RoundedRectangle(cornerRadius: 8)
                                            .stroke(OrbixMobileStyle.stroke, lineWidth: 1)
                                    }
                                }
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("season-chip-\(season.seasonNumber)")
                        }
                    }
                }
            }
        }
    }

    private func moreLikeThis(_ items: [MediaCard]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            OrbixSectionHeader(title: "More Like This", detail: "\(items.count)")

            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: 12) {
                    ForEach(items, id: \.id) { card in
                        PosterCard(card: card, baseURL: model.baseURL, imageLoader: imageLoader) {
                            path.append(TitleRoute(itemId: card.id, resume: card.resume))
                        }
                    }
                }
            }
        }
    }

    private func metadataParts(_ detail: ItemDetail) -> [String] {
        var parts: [String] = []
        if let year = detail.year { parts.append(String(year)) }
        if let rating = detail.rating, !rating.isEmpty { parts.append(rating) }
        if let runtime = Self.formattedRuntime(detail.runtimeSec) { parts.append(runtime) }
        if let genres = detail.genres, !genres.isEmpty { parts.append(genres.prefix(2).joined(separator: ", ")) }
        return parts
    }

    private static func formattedRuntime(_ seconds: Int?) -> String? {
        guard let seconds, seconds > 0 else { return nil }
        let hours = seconds / 3600
        let minutes = (seconds % 3600) / 60
        return hours > 0 ? "\(hours)h \(minutes)m" : "\(minutes)m"
    }

    private func imageURL(_ path: String?) -> URL? {
        guard let path, let baseURL = model.baseURL else { return nil }
        return baseURL.appending(path: "api/images/\(path)")
    }

    private func sortedSeasons(_ detail: ItemDetail) -> [ItemDetail.SeasonSummary] {
        (detail.seasons ?? []).sorted { $0.seasonNumber < $1.seasonNumber }
    }

    private func preferredSeason(in detail: ItemDetail) -> ItemDetail.SeasonSummary? {
        let seasons = sortedSeasons(detail)
        if let preferredSeasonNumber,
           let season = seasons.first(where: { $0.seasonNumber == preferredSeasonNumber }) {
            return season
        }
        return seasons.first
    }

    private func handleSeriesPrimaryAction(_ detail: ItemDetail, seasonNumber: Int?) {
        guard let seasonNumber else { return }
        guard let client = model.client else {
            path.append(SeasonRoute(seriesId: itemId, seasonNumber: seasonNumber))
            return
        }

        guard let resumeEpisodeNumber else {
            path.append(SeasonRoute(seriesId: itemId, seasonNumber: seasonNumber))
            return
        }

        Task { @MainActor in
            guard !resolvingSeriesAction else { return }
            resolvingSeriesAction = true
            defer { resolvingSeriesAction = false }

            do {
                let episodes = try await client.episodes(itemId: itemId, season: seasonNumber)
                guard let episode = episodes.first(where: { $0.episodeNumber == resumeEpisodeNumber }),
                      let fileId = episode.fileId,
                      let baseURL = model.baseURL else {
                    path.append(SeasonRoute(seriesId: itemId, seasonNumber: seasonNumber))
                    return
                }

                playbackTarget = PlaybackTarget(
                    fileId: fileId,
                    episodeId: episode.id,
                    title: playerTitle(seasonNumber: seasonNumber, episode: episode),
                    client: client,
                    baseURL: baseURL
                )
            } catch {
                path.append(SeasonRoute(seriesId: itemId, seasonNumber: seasonNumber))
            }
        }
    }

    private func playerTitle(seasonNumber: Int, episode: Episode) -> String {
        let episodeTitle = episode.title?.isEmpty == false ? episode.title! : "Episode \(episode.episodeNumber)"
        return "S\(seasonNumber)E\(episode.episodeNumber) - \(episodeTitle)"
    }

    private func presentPlayer(fileId: String, title: String, client: OrbixClient) {
        guard let baseURL = model.baseURL else { return }
        playbackTarget = PlaybackTarget(fileId: fileId, episodeId: nil, title: title, client: client, baseURL: baseURL)
    }

    private func refreshAfterPlayback() {
        guard let client = model.client else { return }
        Task { await titleModel.load(itemId: itemId, client: client) }
    }

    private struct PlaybackTarget: Identifiable {
        let id = UUID()
        let fileId: String
        let episodeId: String?
        let title: String
        let client: OrbixClient
        let baseURL: URL
    }
}

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
    private(set) var resumeAvailable = false
    private(set) var isWishlisted = false
    private(set) var isUpdatingWishlist = false
    private(set) var hasLoaded = false

    var loadState: LoadState {
        if let detail { return .loaded(detail, similar: similar) }
        if isLoading || !hasLoaded { return .loading }
        if notFound { return .notFound }
        return .error(loadError ?? "Something went wrong.")
    }

    func load(itemId: String, client: OrbixClient) async {
        guard !isLoading else { return }
        isLoading = true
        loadError = nil
        notFound = false
        resumeAvailable = false
        isWishlisted = false

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
        isWishlisted = ((try? await client.wishlistIds()) ?? []).contains(itemId)

        if let detail, detail.kind != "series", detail.files?.first != nil,
           let progress = try? await client.getProgress(itemId: itemId, episodeId: nil) {
            resumeAvailable = progress.positionSec > 0 && !progress.finished
        }

        isLoading = false
        hasLoaded = true
    }

    func toggleWishlist(itemId: String, client: OrbixClient) async {
        guard !isUpdatingWishlist else { return }
        isUpdatingWishlist = true
        let nextState = !isWishlisted
        do {
            if nextState {
                try await client.addToWishlist(itemId: itemId)
            } else {
                try await client.removeFromWishlist(itemId: itemId)
            }
            isWishlisted = nextState
        } catch {
            loadError = "Couldn't update My List: \(error)"
        }
        isUpdatingWishlist = false
    }
}
