import AVFoundation
import OrbixKit
import SwiftUI
import UIKit

/// A pushed season/episode-list destination on the shared `NavigationStack`
/// path `HomeView` owns (see `HomeView.path`, a `NavigationPath` precisely
/// so it can carry this alongside `TitleRoute`). Pushed by `TitlePage`'s
/// season chip (`TitlePage.seasonChip`).
struct SeasonRoute: Hashable {
    let seriesId: String
    let seasonNumber: Int
}

/// SP2 M3 Task 4 destination: one season's episode list for a series,
/// reached from `TitlePage`'s season strip. Loads
/// `GET /api/items/:id/seasons/:n/episodes` via `SeasonEpisodeModel` and
/// renders a focusable vertical list of episode rows — still art, title +
/// overview, runtime, and a resume bar when in progress. Selecting a row
/// with a `fileId` plays it through the unmodified Task 3 production player
/// (`PlayerScreen`), passing `episodeId` so progress is saved/read
/// per-episode rather than against the bare series id (the plumbing for
/// this — `PlaybackController`/`OrbixClient.putProgress`/`getProgress`
/// already accepting `episodeId` — was already in place from Task 3). Rows
/// with no `fileId` (the episode isn't in the library yet) are shown
/// disabled/greyed — tvOS's focus engine simply skips a `disabled` control,
/// same convention as `TitlePage.playButton`.
///
/// **Next-episode autoplay** (see `handlePlayerDismiss`): rather than
/// threading a completion callback into `PlayerViewController`/
/// `PlaybackController` (Task 3's already-reviewed files), this view
/// listens for `AVPlayerItem.didPlayToEndTimeNotification` itself, only
/// while its own player cover is presented (`body`'s `.task(id:)`, keyed to
/// the presentation's identity so it's re-armed for each new episode and
/// cancelled — no leak — the instant the cover goes away or changes). On
/// that notification, it clears `playbackTarget` itself (the same effect as
/// the user backing out), which drives `PlayerViewController` through its
/// normal `dismantleUIViewController` → `PlaybackController.teardown()`
/// path (final progress PUT + `/stop`) exactly as a manual exit does — so
/// advancing to the next episode can never skip that teardown or leak an
/// `AVPlayer`/observer from the episode just finished. `onDismiss` then
/// looks at whether *this* dismissal was the end-of-item one (`reachedEnd`)
/// versus an early Menu-exit (`PlayerScreen`'s existing
/// `.onExitCommand { dismiss() }`, untouched) and only in the former case
/// looks up `episodeNumber + 1` and, if it exists and has a `fileId`,
/// immediately presents it — a fresh `PlaybackController`/play session per
/// episode, same as tapping a row by hand. Zero changes to any Task 3 file:
/// the movie playback path (`TitlePage`'s own `fullScreenCover`) is
/// unaffected because it doesn't exist there.
struct SeasonEpisodeView: View {
    let seriesId: String
    let seasonNumber: Int
    let model: AppModel

    @State private var episodeModel = SeasonEpisodeModel()
    @State private var imageLoader = ImageLoader()
    @State private var playbackTarget: EpisodePlaybackTarget?

    /// The episode currently behind `playbackTarget`, captured separately
    /// from it: SwiftUI resets `$playbackTarget`'s wrapped value to `nil`
    /// as part of dismissing the `.fullScreenCover`, so by the time
    /// `onDismiss` runs there's nothing left to read off `playbackTarget`
    /// itself — this is `handlePlayerDismiss`'s own bookkeeping of "which
    /// episode just played," unaffected by that reset.
    @State private var presentedEpisode: Episode?

    /// Set by the end-of-item notification observed in `body`'s
    /// `.task(id:)` — `true` only when the just-dismissed presentation
    /// actually played to its end, as opposed to being backed out of early.
    /// Read and reset by `handlePlayerDismiss`.
    @State private var reachedEnd = false

    private static let stillWidth: CGFloat = 320
    private static let stillHeight: CGFloat = 180

    var body: some View {
        Group {
            if let client = model.client {
                content(client: client)
                    .task { await episodeModel.load(seriesId: seriesId, season: seasonNumber, client: client) }
            } else {
                // Defensive only: this view is only ever pushed from a
                // context where `model.client` is already non-nil (same
                // invariant TitlePage's own fallback documents).
                ProgressView()
            }
        }
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
        // Observes end-of-item while — and only while — a player is
        // presented (see the type doc comment's "Next-episode autoplay"
        // section). `.task(id:)` cancels the previous iteration and starts
        // a fresh one whenever `playbackTarget?.id` changes, including the
        // auto-advance case (a new target ⇒ a new id) and the plain-dismiss
        // case (⇒ nil, whose guard below exits immediately) — so this can
        // never keep listening past the presentation it belongs to.
        .task(id: playbackTarget?.id) {
            guard playbackTarget != nil else { return }
            for await _ in NotificationCenter.default.notifications(named: AVPlayerItem.didPlayToEndTimeNotification) {
                reachedEnd = true
                // Dismiss ourselves rather than waiting for the user to —
                // this is what actually triggers PlayerViewController's
                // teardown (dismantleUIViewController) and, via
                // onDismiss, the next-episode check below.
                playbackTarget = nil
                break
            }
        }
    }

    @ViewBuilder
    private func content(client: OrbixClient) -> some View {
        switch episodeModel.loadState {
        case .loading:
            ProgressView("Loading…")
                .font(.title3)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .notFound:
            notFoundView
        case .empty:
            emptyView
        case .error(let message):
            errorView(message: message, client: client)
        case .loaded(let episodes):
            episodeList(episodes, client: client)
        }
    }

    private func episodeList(_ episodes: [Episode], client: OrbixClient) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text(seasonHeading)
                    .font(.title2.bold())
                    .padding(.leading, 4)

                LazyVStack(alignment: .leading, spacing: 24) {
                    ForEach(episodes, id: \.id) { episode in
                        episodeRow(episode, client: client)
                    }
                }
            }
            .padding(.horizontal, 64)
            .padding(.vertical, 48)
        }
        .focusSection()
        .accessibilityIdentifier("seasonEpisodeList_\(seriesId)_\(seasonNumber)")
    }

    private var seasonHeading: String {
        String(localized: "Season \(seasonNumber)")
    }

    // MARK: - Episode row

    private func episodeRow(_ episode: Episode, client: OrbixClient) -> some View {
        let playable = episode.fileId != nil
        return Button {
            guard let fileId = episode.fileId, let baseURL = model.baseURL else { return }
            presentPlayer(for: episode, fileId: fileId, client: client, baseURL: baseURL)
        } label: {
            HStack(alignment: .top, spacing: 24) {
                EpisodeStillArtwork(url: stillURL(episode), imageLoader: imageLoader)
                    .frame(width: Self.stillWidth, height: Self.stillHeight)
                    .clipShape(RoundedRectangle(cornerRadius: 10))

                VStack(alignment: .leading, spacing: 6) {
                    Text(episodeLabel(episode))
                        .font(.headline)
                        .lineLimit(1)

                    if let overview = episode.overview, !overview.isEmpty {
                        Text(overview)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }

                    HStack(spacing: 12) {
                        if let runtime = Self.formattedRuntime(episode.runtimeSec) {
                            Text(runtime)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        if !playable {
                            Text("Not in library")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }

                    if let resumeFraction = resumeFraction(episode) {
                        EpisodeResumeBar(fraction: resumeFraction)
                            .frame(width: Self.stillWidth)
                            .accessibilityIdentifier("episodeResumeBar_\(episode.id)")
                    }
                }

                Spacer(minLength: 0)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.card)
        // Always rendered rather than hidden (same rationale as
        // TitlePage.playButton): a dimmed, disabled row communicates "not
        // in the library yet" instead of silently omitting the episode,
        // which would look like the season failed to load one. Not a
        // focus-stability concern: tvOS's focus engine skips a `disabled`
        // control rather than parking focus on it.
        .disabled(!playable)
        .opacity(playable ? 1 : 0.5)
        .accessibilityIdentifier("episodeRow_\(episode.id)")
    }

    /// `"Pilot"` when titled, `"Episode 3"` otherwise.
    private func episodeDisplayTitle(_ episode: Episode) -> String {
        if let title = episode.title, !title.isEmpty { return title }
        return String(localized: "Episode \(episode.episodeNumber)")
    }

    /// `"3. Pilot"` when titled, `"Episode 3"` otherwise.
    private func episodeLabel(_ episode: Episode) -> String {
        if let title = episode.title, !title.isEmpty {
            return "\(episode.episodeNumber). \(title)"
        }
        return episodeDisplayTitle(episode)
    }

    /// Shown via the player's `externalMetadata` (its `videoTitle` param) so
    /// tvOS's transport/info UI reads e.g. "S1E3 — Pilot" instead of just
    /// the bare episode title (`TitlePage.playButton`'s movie equivalent
    /// passes the item's own title; this is the per-episode analogue).
    private func playerTitle(for episode: Episode) -> String {
        "S\(seasonNumber)E\(episode.episodeNumber) — \(episodeDisplayTitle(episode))"
    }

    /// `3720` → `"1h 2m"`; `600` → `"10m"`; `nil`/non-positive → `nil`
    /// (mirrors `TitlePage.formattedRuntime`; kept as its own small copy
    /// rather than shared, same "small, self-contained" convention this
    /// codebase already uses for near-identical per-view helpers).
    private static func formattedRuntime(_ seconds: Int?) -> String? {
        guard let seconds, seconds > 0 else { return nil }
        let hours = seconds / 3600
        let minutes = (seconds % 3600) / 60
        return hours > 0 ? String(localized: "\(hours)h \(minutes)m") : String(localized: "\(minutes)m")
    }

    /// `positionSec / durationSec` clamped to `0...1`; `nil` (no bar drawn)
    /// when there's no `progress`, a non-positive `durationSec`, or the
    /// episode is already `finished` — a fully-watched episode doesn't get
    /// a resume bar, same Netflix-style convention `PosterCard.resumeFraction`
    /// documents for a movie/series card.
    private func resumeFraction(_ episode: Episode) -> Double? {
        guard let progress = episode.progress, progress.durationSec > 0, !progress.finished else { return nil }
        return min(1, max(0, Double(progress.positionSec) / Double(progress.durationSec)))
    }

    private func stillURL(_ episode: Episode) -> URL? {
        guard let stillPath = episode.stillPath, let baseURL = model.baseURL else { return nil }
        return baseURL.appending(path: "api/images/\(stillPath)")
    }

    // MARK: - Playback + next-episode

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

    /// Runs once the `.fullScreenCover`'s dismissal completes — whether
    /// that was the user backing out early (`PlayerScreen`'s own
    /// `.onExitCommand { dismiss() }`) or this view clearing
    /// `playbackTarget` itself after observing end-of-item (`body`'s
    /// `.task(id:)`). Only the latter (`reachedEnd == true`) looks up and
    /// presents `episodeNumber + 1`, and only when it exists *and* has a
    /// `fileId` — an unmatched next episode or the season finale simply
    /// leaves the user back on the episode list, same as any other exit.
    /// Refreshes the episode list either way (best-effort, fire-and-forget)
    /// so the just-watched row's resume bar reflects the final progress
    /// report the player just issued — same rationale as
    /// `TitlePage.refreshAfterPlayback` — without blocking (or being
    /// blocked by) a possible auto-advance, which reads the still-in-memory
    /// episode list so the transition to the next episode isn't held up by
    /// a network round trip.
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

        if let client = model.client {
            Task { await episodeModel.load(seriesId: seriesId, season: seasonNumber, client: client) }
        }
    }

    // MARK: - Loading / empty / error / not-found states

    private var emptyView: some View {
        ContentUnavailableView(
            "No episodes yet",
            systemImage: "tv",
            description: Text("This season doesn't have any episodes yet.")
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("seasonEpisodeEmptyState")
    }

    private var notFoundView: some View {
        ContentUnavailableView(
            "Not available",
            systemImage: "eye.slash",
            description: Text("This season isn't available right now.")
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("seasonEpisodeNotFound")
    }

    private func errorView(message: String, client: OrbixClient) -> some View {
        ContentUnavailableView {
            Label("Couldn't load episodes", systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            Button("Retry") {
                Task { await episodeModel.load(seriesId: seriesId, season: seasonNumber, client: client) }
            }
            .accessibilityIdentifier("seasonEpisodeRetryButton")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("seasonEpisodeErrorState")
    }
}

/// Drives `SeasonEpisodeView`: loads
/// `GET /api/items/:id/seasons/:n/episodes` and exposes the result as a
/// single `loadState`, mirroring `TitleModel`/`HomeModel`'s
/// loading/error/empty/loaded (+ here, `notFound`) shape so those states
/// can't drift out of sync the way separately-checked booleans would.
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

    /// Same "first attempt has resolved one way or another" latch
    /// `HomeModel.hasLoaded`/`TitleModel.hasLoaded` use.
    private(set) var hasLoaded = false

    init() {}

    var loadState: LoadState {
        guard episodes.isEmpty else { return .loaded(episodes) }
        if isLoading || !hasLoaded { return .loading }
        if notFound { return .notFound }
        if let loadError { return .error(loadError) }
        return .empty
    }

    /// Fetches one season's episode list. Safe to call again (e.g. the
    /// error state's Retry button, or the post-playback refresh) once the
    /// previous call has finished — a call arriving while one's already in
    /// flight is a no-op, mirroring `HomeModel.load`/`TitleModel.load`'s
    /// re-entrancy guard.
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

    /// The episode immediately after `episodeNumber` in the currently
    /// loaded season, if any — looked up by `episodeNumber` equality rather
    /// than array index, so a season with a gap (an episode missing from
    /// the library) doesn't skip past a real next episode.
    func episode(after episodeNumber: Int) -> Episode? {
        episodes.first { $0.episodeNumber == episodeNumber + 1 }
    }
}

/// Identifies one presentation of the production player for a specific
/// episode — see `SeasonEpisodeView.presentPlayer`/`body`'s
/// `.fullScreenCover(item:)`. `id` is a fresh `UUID` per instance (not e.g.
/// `episode.id`) so presenting the same or a different episode always
/// starts a brand-new presentation — and thus a brand-new
/// `PlaybackController`/play session — rather than SwiftUI treating it as
/// the same identity. Same convention as `TitlePage.PlaybackTarget`.
private struct EpisodePlaybackTarget: Identifiable {
    let id = UUID()
    let episode: Episode
    let fileId: String
    let title: String
    let client: OrbixClient
    let baseURL: URL
}

/// Episode still-frame art fetched via `ImageLoader`; a "tv" glyph
/// placeholder while loading or on a missing/failed still. Mirrors
/// `PosterCard`'s `PosterArtwork` (own tiny loader-view per call site, same
/// `.task(id:)` reload-on-url-change behavior, different placeholder glyph
/// and aspect).
private struct EpisodeStillArtwork: View {
    let url: URL?
    let imageLoader: ImageLoader

    @State private var uiImage: UIImage?

    var body: some View {
        ZStack {
            Rectangle().fill(.secondary.opacity(0.2))
            if let uiImage {
                Image(uiImage: uiImage)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } else {
                Image(systemName: "tv")
                    .font(.title)
                    .foregroundStyle(.secondary)
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

/// A thin bar under an episode row showing resume progress (`fraction` in
/// `0...1`) — same Netflix-style filled-vs-remaining convention as
/// `PosterCard`'s `ResumeProgressBar`, duplicated locally rather than
/// shared (both are small, self-contained, single-call-site view helpers).
private struct EpisodeResumeBar: View {
    let fraction: Double

    private static let barHeight: CGFloat = 5

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Rectangle().fill(.white.opacity(0.25))
                Rectangle()
                    .fill(.red)
                    .frame(width: geometry.size.width * fraction)
            }
        }
        .frame(height: Self.barHeight)
    }
}

#Preview {
    SeasonEpisodeView(seriesId: "s1", seasonNumber: 1, model: AppModel())
}
