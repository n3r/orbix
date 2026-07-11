import AVFoundation
import OrbixKit
import SwiftUI

struct SeasonRoute: Hashable {
    let seriesId: String
    let seasonNumber: Int
}

struct SeasonEpisodeView: View {
    let seriesId: String
    let seasonNumber: Int
    let model: AppModel

    @State private var episodeModel = SeasonEpisodeModel()
    @State private var imageLoader = ImageLoader()
    @State private var playbackTarget: EpisodePlaybackTarget?
    @State private var presentedEpisode: Episode?
    @State private var reachedEnd = false

    var body: some View {
        Group {
            if let client = model.client {
                content(client: client)
                    .task { await episodeModel.load(seriesId: seriesId, season: seasonNumber, client: client) }
            } else {
                ProgressView()
            }
        }
        .background(OrbixScreenBackground())
        .navigationTitle("Season \(seasonNumber)")
        .navigationBarTitleDisplayMode(.inline)
        .fullScreenCover(item: $playbackTarget, onDismiss: handlePlayerDismiss) { target in
            PlayerScreen(
                itemId: seriesId,
                fileId: target.fileId,
                episodeId: target.episode.id,
                title: target.title,
                client: target.client,
                baseURL: target.baseURL
            )
        }
        .task(id: playbackTarget?.id) {
            guard playbackTarget != nil else { return }
            for await _ in NotificationCenter.default.notifications(named: AVPlayerItem.didPlayToEndTimeNotification) {
                reachedEnd = true
                playbackTarget = nil
                break
            }
        }
    }

    @ViewBuilder
    private func content(client: OrbixClient) -> some View {
        switch episodeModel.loadState {
        case .loading:
            ProgressView("Loading")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .notFound:
            ContentUnavailableView(
                "Not available",
                systemImage: "eye.slash",
                description: Text("This season isn't available right now.")
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .empty:
            ContentUnavailableView(
                "No episodes yet",
                systemImage: "tv",
                description: Text("This season doesn't have any episodes yet.")
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .error(let message):
            ContentUnavailableView {
                Label("Couldn't load episodes", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Retry") { Task { await episodeModel.load(seriesId: seriesId, season: seasonNumber, client: client) } }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .loaded(let episodes):
            episodeList(episodes, client: client)
        }
    }

    private func episodeList(_ episodes: [Episode], client: OrbixClient) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 7) {
                    OrbixEyebrow(text: "Episodes")
                    Text("Season \(seasonNumber)")
                        .font(.system(size: 31, weight: .black))
                        .foregroundStyle(.white)
                }
                .padding(.horizontal, 20)
                .padding(.top, 18)

                ForEach(episodes, id: \.id) { episode in
                    episodeRow(episode, client: client)
                        .padding(.horizontal, 20)
                }
            }
            .padding(.bottom, 126)
        }
        .scrollIndicators(.hidden)
    }

    private func episodeRow(_ episode: Episode, client: OrbixClient) -> some View {
        Button {
            guard let fileId = episode.fileId, let baseURL = model.baseURL else { return }
            presentPlayer(for: episode, fileId: fileId, client: client, baseURL: baseURL)
        } label: {
            VStack(alignment: .leading, spacing: 0) {
                ZStack {
                    RemoteImage(url: stillURL(episode), imageLoader: imageLoader) {
                        ImagePlaceholder(systemName: "tv")
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 190)

                    LinearGradient(
                        colors: [.clear, .black.opacity(0.72)],
                        startPoint: .center,
                        endPoint: .bottom
                    )

                    Image(systemName: "play.fill")
                        .font(.title2.weight(.bold))
                        .foregroundStyle(episode.fileId == nil ? Color.secondary : Color.white)
                        .frame(width: 58, height: 58)
                        .background(.black.opacity(0.58), in: Circle())

                    if let fraction = resumeFraction(episode) {
                        ResumeProgressBar(fraction: fraction)
                            .frame(maxHeight: .infinity, alignment: .bottom)
                    }
                }

                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text(episodeLabel(episode))
                            .font(.headline)
                            .lineLimit(2)

                        Spacer(minLength: 0)

                        if let runtime = Self.formattedRuntime(episode.runtimeSec) {
                            Text(runtime)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                        }
                    }

                    metadataLine(episode)

                    if let overview = episode.overview, !overview.isEmpty {
                        Text(overview)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .lineLimit(4)
                    }
                }
                .padding(14)
            }
            .contentShape(Rectangle())
            .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .opacity(episode.fileId == nil ? 0.48 : 1)
        }
        .buttonStyle(.plain)
        .disabled(episode.fileId == nil)
        .accessibilityIdentifier("episode-card-\(episode.id)")
    }

    @ViewBuilder
    private func metadataLine(_ episode: Episode) -> some View {
        let parts = episodeMetadataParts(episode)
        if !parts.isEmpty {
            Text(parts.joined(separator: "  •  "))
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
    }

    private func episodeMetadataParts(_ episode: Episode) -> [String] {
        var parts: [String] = []
        if let progress = episode.progress, progress.positionSec > 0, !progress.finished {
            parts.append("Resume at \(Self.formattedRuntime(progress.positionSec) ?? "0m")")
        }
        if let airDate = episode.airDate, !airDate.isEmpty {
            parts.append(airDate)
        }
        if episode.fileId == nil {
            parts.append("Not in library")
        }
        return parts
    }

    private func episodeDisplayTitle(_ episode: Episode) -> String {
        if let title = episode.title, !title.isEmpty { return title }
        return "Episode \(episode.episodeNumber)"
    }

    private func episodeLabel(_ episode: Episode) -> String {
        if let title = episode.title, !title.isEmpty {
            return "\(episode.episodeNumber). \(title)"
        }
        return episodeDisplayTitle(episode)
    }

    private func playerTitle(for episode: Episode) -> String {
        "S\(seasonNumber)E\(episode.episodeNumber) - \(episodeDisplayTitle(episode))"
    }

    private func resumeFraction(_ episode: Episode) -> Double? {
        guard let progress = episode.progress, progress.durationSec > 0, !progress.finished else { return nil }
        return min(1, max(0, Double(progress.positionSec) / Double(progress.durationSec)))
    }

    private func stillURL(_ episode: Episode) -> URL? {
        guard let stillPath = episode.stillPath, let baseURL = model.baseURL else { return nil }
        return baseURL.appending(path: "api/images/\(stillPath)")
    }

    private func presentPlayer(for episode: Episode, fileId: String, client: OrbixClient, baseURL: URL) {
        reachedEnd = false
        presentedEpisode = episode
        playbackTarget = EpisodePlaybackTarget(
            episode: episode,
            fileId: fileId,
            title: playerTitle(for: episode),
            client: client,
            baseURL: baseURL
        )
    }

    private static func formattedRuntime(_ seconds: Int?) -> String? {
        guard let seconds, seconds > 0 else { return nil }
        let hours = seconds / 3600
        let minutes = (seconds % 3600) / 60
        return hours > 0 ? "\(hours)h \(minutes)m" : "\(minutes)m"
    }

    private func handlePlayerDismiss() {
        let didReachEnd = reachedEnd
        let justWatched = presentedEpisode
        reachedEnd = false
        presentedEpisode = nil

        if didReachEnd, let justWatched,
           let client = model.client, let baseURL = model.baseURL,
           let next = episodeModel.episode(after: justWatched.episodeNumber),
           let fileId = next.fileId {
            presentPlayer(for: next, fileId: fileId, client: client, baseURL: baseURL)
        }

        guard let client = model.client else { return }
        Task { await episodeModel.load(seriesId: seriesId, season: seasonNumber, client: client) }
    }
}

@MainActor
@Observable
final class SeasonEpisodeModel {
    enum LoadState: Equatable {
        case loading
        case notFound
        case empty
        case error(String)
        case loaded([Episode])
    }

    private(set) var episodes: [Episode] = []
    private(set) var isLoading = false
    private(set) var loadError: String?
    private(set) var notFound = false
    private(set) var hasLoaded = false

    var loadState: LoadState {
        guard episodes.isEmpty else { return .loaded(episodes) }
        if isLoading || !hasLoaded { return .loading }
        if notFound { return .notFound }
        if let loadError { return .error(loadError) }
        return .empty
    }

    func load(seriesId: String, season: Int, client: OrbixClient) async {
        guard !isLoading else { return }
        isLoading = true
        loadError = nil
        notFound = false

        do {
            episodes = try await client.episodes(itemId: seriesId, season: season)
        } catch {
            if let orbixError = error as? OrbixError, case .http(404) = orbixError {
                notFound = true
            } else {
                loadError = "Couldn't load episodes: \(error)"
            }
        }

        isLoading = false
        hasLoaded = true
    }

    func episode(after episodeNumber: Int) -> Episode? {
        episodes.first { $0.episodeNumber == episodeNumber + 1 }
    }
}

private struct EpisodePlaybackTarget: Identifiable {
    let id = UUID()
    let episode: Episode
    let fileId: String
    let title: String
    let client: OrbixClient
    let baseURL: URL
}
