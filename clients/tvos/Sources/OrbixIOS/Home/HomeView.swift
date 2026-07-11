import OrbixKit
import SwiftUI

struct HomeView: View {
    let model: AppModel

    @State private var homeModel = HomeModel()
    @State private var imageLoader = ImageLoader()
    @State private var path = NavigationPath()
    @State private var playbackTarget: HomePlaybackTarget?
    @State private var resolvingHeroId: String?

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if let client = model.client {
                    content(client: client)
                        .task { await homeModel.load(client: client) }
                        .refreshable { await homeModel.reload(client: client) }
                } else {
                    ProgressView()
                }
            }
            .background(OrbixScreenBackground())
            .navigationDestination(for: TitleRoute.self) { route in
                TitleDetailView(
                    itemId: route.itemId,
                    preferredSeasonNumber: route.resumeSeasonNumber,
                    resumeEpisodeNumber: route.resumeEpisodeNumber,
                    resumeEpisodeLabel: route.resumeEpisodeLabel,
                    model: model,
                    path: $path
                )
            }
            .navigationDestination(for: SeasonRoute.self) { route in
                SeasonEpisodeView(seriesId: route.seriesId, seasonNumber: route.seasonNumber, model: model)
            }
            .toolbar(.hidden, for: .navigationBar)
            .fullScreenCover(item: $playbackTarget) { target in
                PlayerScreen(
                    itemId: target.itemId,
                    fileId: target.fileId,
                    title: target.title,
                    client: target.client,
                    baseURL: target.baseURL
                )
            }
        }
    }

    @ViewBuilder
    private func content(client: OrbixClient) -> some View {
        switch homeModel.loadState {
        case .loading:
            ProgressView("Loading")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .error(let message):
            ContentUnavailableView {
                Label("Couldn't load titles", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Retry") { Task { await homeModel.reload(client: client) } }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .empty:
            ContentUnavailableView(
                "No titles yet",
                systemImage: "film.stack",
                description: Text("Scan a library on the server to see titles here.")
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .loaded(let rows):
            homeContent(rows, client: client)
        }
    }

    private func homeContent(_ rows: [HomeRow], client: OrbixClient) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 22) {
                homeHeader(rows)

                if let hero = heroCard(from: rows) {
                    heroView(hero, client: client)
                }

                ForEach(rows.filter { !$0.items.isEmpty }, id: \.key) { row in
                    rail(row)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 18)
            .padding(.bottom, 136)
        }
        .scrollIndicators(.hidden)
    }

    private func homeHeader(_ rows: [HomeRow]) -> some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 7) {
                OrbixEyebrow(text: "Home")
                Text(model.activeProfile?.name.map { "For \($0)" } ?? "For tonight")
                    .font(.system(size: 30, weight: .semibold))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            Spacer()
            OrbixPill(text: "\(rows.reduce(0) { $0 + $1.items.count }) titles", systemImage: "film.stack")
                .padding(.top, 4)
        }
    }

    private func heroView(_ card: MediaCard, client: OrbixClient) -> some View {
        GeometryReader { geometry in
            let contentWidth = max(0, geometry.size.width - 28)
            let buttonWidth = max(0, (contentWidth - 12) / 2)

            ZStack(alignment: .bottomLeading) {
                OrbixMobileStyle.backgroundRaised

                RemoteImage(url: imageURL(card.backdropPath ?? card.posterPath), imageLoader: imageLoader) {
                    Color.clear
                }
                .frame(width: geometry.size.width, height: 228)
                .opacity(0.18)
                .blur(radius: 10)

                LinearGradient(
                    colors: [
                        .black.opacity(0.18),
                        OrbixMobileStyle.backgroundRaised.opacity(0.78),
                        .black.opacity(0.78),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )

                VStack(alignment: .leading, spacing: 12) {
                    HStack(alignment: .center, spacing: 14) {
                        RemoteImage(url: imageURL(card.posterPath), imageLoader: imageLoader) {
                            ImagePlaceholder(systemName: "film")
                        }
                        .frame(width: 86, height: 129)
                        .clipShape(RoundedRectangle(cornerRadius: 7))
                        .overlay {
                            RoundedRectangle(cornerRadius: 7)
                                .stroke(OrbixMobileStyle.stroke, lineWidth: 1)
                        }
                        .shadow(color: .black.opacity(0.34), radius: 12, y: 6)

                        VStack(alignment: .leading, spacing: 9) {
                            HStack(spacing: 8) {
                                OrbixPill(
                                    text: card.progress == nil ? "Spotlight" : "Continue",
                                    systemImage: card.progress == nil ? "sparkles" : "play.circle",
                                    selected: true
                                )
                                if let year = card.year {
                                    OrbixPill(text: String(year))
                                }
                            }

                            Text(card.title)
                                .font(.system(size: 28, weight: .semibold))
                                .foregroundStyle(.white)
                                .lineLimit(2)
                                .minimumScaleFactor(0.76)

                            Text(card.progress == nil ? "Featured from your library" : "Pick up where you left off")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(OrbixMobileStyle.secondaryText)
                                .lineLimit(2)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    HStack(spacing: 12) {
                        Button {
                            playHero(card, client: client)
                        } label: {
                            OrbixPrimaryActionLabel(
                                title: card.progress == nil ? "Play" : "Resume",
                                systemImage: "play.fill",
                                isLoading: resolvingHeroId == card.id
                            )
                            .frame(width: buttonWidth, height: 48)
                            .background(.white, in: Capsule())
                            .foregroundStyle(.black)
                        }
                        .buttonStyle(.plain)
                        .disabled(resolvingHeroId != nil)
                        .accessibilityIdentifier("hero-play-button")

                        Button {
                            path.append(TitleRoute(itemId: card.id, resume: card.resume))
                        } label: {
                            OrbixSecondaryActionLabel(title: "Details", systemImage: "info.circle")
                            .frame(width: buttonWidth, height: 48)
                            .background(OrbixMobileStyle.panelStrong, in: Capsule())
                            .foregroundStyle(.white)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("hero-info-button")
                    }
                }
                .frame(width: contentWidth, alignment: .leading)
                .padding(14)
            }
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay {
                RoundedRectangle(cornerRadius: 12)
                    .stroke(OrbixMobileStyle.stroke, lineWidth: 1)
            }
        }
        .frame(height: 228)
    }

    private func rail(_ row: HomeRow) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            OrbixSectionHeader(title: row.title, detail: "\(row.items.count)")

            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: 12) {
                    ForEach(row.items, id: \.id) { card in
                        if row.key == "continue" {
                            WidePosterCard(
                                card: card,
                                baseURL: model.baseURL,
                                imageLoader: imageLoader,
                                accessibilityIdentifier: "rail-\(row.key)-card-\(card.id)"
                            ) {
                                path.append(TitleRoute(itemId: card.id, resume: card.resume))
                            }
                        } else {
                            PosterCard(
                                card: card,
                                baseURL: model.baseURL,
                                imageLoader: imageLoader,
                                accessibilityIdentifier: "rail-\(row.key)-card-\(card.id)"
                            ) {
                                path.append(TitleRoute(itemId: card.id, resume: card.resume))
                            }
                        }
                    }
                }
                .padding(.bottom, 2)
            }
            .accessibilityIdentifier("rail-\(row.key)")
        }
    }

    private func heroCard(from rows: [HomeRow]) -> MediaCard? {
        rows.first(where: { $0.key != "continue" && !$0.items.isEmpty })?.items.first
            ?? rows.first(where: { !$0.items.isEmpty })?.items.first
    }

    private func playHero(_ card: MediaCard, client: OrbixClient) {
        guard resolvingHeroId == nil else { return }
        Task { @MainActor in
            resolvingHeroId = card.id
            defer { resolvingHeroId = nil }

            do {
                let detail = try await client.itemDetail(id: card.id)
                if detail.kind == "series" {
                    let seasonNumber = card.resume?.seasonNumber
                        ?? detail.seasons?.map(\.seasonNumber).sorted().first
                    if let seasonNumber {
                        path.append(SeasonRoute(seriesId: card.id, seasonNumber: seasonNumber))
                    } else {
                        path.append(TitleRoute(itemId: card.id, resume: card.resume))
                    }
                    return
                }

                guard let fileId = detail.files?.first?.id, let baseURL = model.baseURL else {
                    path.append(TitleRoute(itemId: card.id, resume: card.resume))
                    return
                }

                playbackTarget = HomePlaybackTarget(
                    itemId: card.id,
                    fileId: fileId,
                    title: detail.title,
                    client: client,
                    baseURL: baseURL
                )
            } catch {
                path.append(TitleRoute(itemId: card.id, resume: card.resume))
            }
        }
    }

    private func imageURL(_ path: String?) -> URL? {
        guard let path, let baseURL = model.baseURL else { return nil }
        return baseURL.appending(path: "api/images/\(path)")
    }
}

private struct HomePlaybackTarget: Identifiable {
    let id = UUID()
    let itemId: String
    let fileId: String
    let title: String
    let client: OrbixClient
    let baseURL: URL
}

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
    private(set) var hasLoaded = false

    var loadState: LoadState {
        guard rows.contains(where: { !$0.items.isEmpty }) else {
            if isLoading || !hasLoaded { return .loading }
            if let loadError { return .error(loadError) }
            return .empty
        }
        return .loaded(rows)
    }

    func load(client: OrbixClient) async {
        guard !hasLoaded else { return }
        await reload(client: client)
    }

    func reload(client: OrbixClient) async {
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
