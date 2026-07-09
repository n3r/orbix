import AVFoundation
import OrbixKit
import SwiftUI
import UIKit

/// Inline season **tabs** + **episode grid** rendered on a series' title page
/// (tvOS port of the web `apps/web/src/components/SeasonEpisodeList.tsx`) —
/// replaces the old pushed season destination. `TitlePage` embeds this
/// directly in its section stack (below the hero), so there is no separate
/// navigation push for a season any more.
///
/// A horizontal focus-section row of season chips (ascending, the selected
/// one accent-tinted) selects a season; the chosen season's episodes load
/// lazily via `GET /api/items/:id/seasons/:n/episodes` (`SeasonEpisodeModel`)
/// and render as a `LazyVGrid` of 16:9 cards — still art (or the big episode
/// number when absent), a per-episode accent `ProgressBarView` when in
/// progress, `"# Title"` + runtime, and a focus-driven play glyph. Episodes
/// not in the library (`fileId == nil`) render disabled/dimmed with a
/// "Not in library" line, same convention as the old list.
///
/// Selecting a playable episode plays it through the unmodified production
/// player (`PlayerScreen`), passing `episodeId` so progress is saved/read
/// per-episode. The hero's **Play** button drives `playFirstToken`: when it
/// bumps (and once the season's episodes are present), the first owned
/// episode of the selected season starts — see `playFirstOwnedIfNeeded`.
///
/// **Next-episode autoplay** (see `handlePlayerDismiss`) is ported verbatim
/// from the retired pushed season/episode list: rather than threading a
/// completion callback into `PlayerViewController`/`PlaybackController` (Task 3's
/// already-reviewed files), this view listens for
/// `AVPlayerItem.didPlayToEndTimeNotification` itself, only while its own
/// player cover is presented (`body`'s `.task(id:)`, keyed to the
/// presentation's identity so it's re-armed for each new episode and
/// cancelled — no leak — the instant the cover goes away or changes). On that
/// notification, it clears `playbackTarget` itself (the same effect as the
/// user backing out), which drives `PlayerViewController` through its normal
/// `dismantleUIViewController` → `PlaybackController.teardown()` path (final
/// progress PUT + `/stop`) exactly as a manual exit does — so advancing to
/// the next episode can never skip that teardown or leak an
/// `AVPlayer`/observer from the episode just finished. `onDismiss` then looks
/// at whether *this* dismissal was the end-of-item one (`reachedEnd`) versus
/// an early Menu-exit (`PlayerScreen`'s existing `.onExitCommand { dismiss() }`,
/// untouched) and only in the former case looks up `episodeNumber + 1` and,
/// if it exists and has a `fileId`, immediately presents it — a fresh
/// `PlaybackController`/play session per episode, same as tapping a card by
/// hand.
struct SeasonEpisodeListView: View {
    let seriesId: String
    let seasons: [ItemDetail.SeasonSummary]
    let model: AppModel
    /// Bumped by `TitlePage`'s hero **Play** (and its series `autoplay`
    /// branch): a change drives `playFirstOwnedIfNeeded`, which plays the
    /// first owned episode of the currently-selected season.
    let playFirstToken: Int

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

    /// The season whose episodes the grid currently shows — defaults to the
    /// first non-specials season (falling back to the first), the same rule
    /// `TitlePage` uses for the hero's series Play.
    @State private var selectedSeason: Int

    /// The `playFirstToken` value most recently acted on, so a single Play
    /// press fires exactly once even though `playFirstOwnedIfNeeded` is
    /// invoked from both the token change *and* the episodes-loaded
    /// completion (web `handledToken` ref).
    @State private var handledPlayToken = 0

    /// One 16:9 card per grid cell, fixed-width like `LibraryBrowseView`'s
    /// 2:3 grid so cells align cleanly and the still/number lockup keeps a
    /// consistent size across cards.
    private static let cardWidth: CGFloat = 360
    private static let cardHeight: CGFloat = 203 // 360 * 9/16
    private let gridColumns = [GridItem(.adaptive(minimum: cardWidth, maximum: cardWidth), spacing: 32)]

    init(seriesId: String, seasons: [ItemDetail.SeasonSummary], model: AppModel, playFirstToken: Int) {
        self.seriesId = seriesId
        self.seasons = seasons
        self.model = model
        self.playFirstToken = playFirstToken
        let ordered = seasons.sorted { $0.seasonNumber < $1.seasonNumber }
        let initial = ordered.first { $0.seasonNumber > 0 } ?? ordered.first
        _selectedSeason = State(initialValue: initial?.seasonNumber ?? 1)
    }

    private var orderedSeasons: [ItemDetail.SeasonSummary] {
        seasons.sorted { $0.seasonNumber < $1.seasonNumber }
    }

    var body: some View {
        Group {
            if orderedSeasons.isEmpty {
                // Nothing to render — matches the web `if (ordered.length === 0) return null`.
                EmptyView()
            } else if let client = model.client {
                sectionBody(client: client)
                    // Re-fires whenever the selected season changes: cancels
                    // the previous season's in-flight load (so a stale
                    // response can't clobber the new season) and loads the new
                    // one, then — only if not itself cancelled — checks a
                    // pending hero Play (the web `useEffect([playFirstToken,
                    // episodes])`'s episodes-loaded trigger).
                    .task(id: selectedSeason) {
                        await episodeModel.load(seriesId: seriesId, season: selectedSeason, client: client)
                        guard !Task.isCancelled else { return }
                        playFirstOwnedIfNeeded(token: playFirstToken)
                    }
            } else {
                // Defensive only: TitlePage only renders this for a series
                // once `model.client` is already non-nil (same invariant its
                // own `content(client:)` documents).
                EmptyView()
            }
        }
        // The hero Play's other trigger: a token bump plays the first owned
        // episode immediately when the season's episodes are already loaded
        // (the episodes-loaded case above covers a bump that arrives before
        // the load finishes).
        .onChange(of: playFirstToken) { _, newToken in
            playFirstOwnedIfNeeded(token: newToken)
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

    // MARK: - Section (heading + season tabs + episodes region)

    private func sectionBody(client: OrbixClient) -> some View {
        VStack(alignment: .leading, spacing: 24) {
            Text(L10n.t("title.episodesHeading"))
                .font(.title3.bold())
                .foregroundStyle(OrbixColor.text)
                .padding(.leading, 4)

            seasonTabs

            episodesRegion(client: client)
        }
        .padding(.horizontal, 64)
    }

    // MARK: - Season tabs (web `role=tablist`, lines 84-105)

    private var seasonTabs: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            LazyHStack(spacing: 16) {
                ForEach(orderedSeasons, id: \.seasonNumber) { season in
                    seasonTab(season)
                }
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 12)
        }
        .focusSection()
        .accessibilityIdentifier("seasonTabs_\(seriesId)")
    }

    private func seasonTab(_ season: ItemDetail.SeasonSummary) -> some View {
        let isSelected = season.seasonNumber == selectedSeason
        return Button {
            guard season.seasonNumber != selectedSeason else { return }
            // Clear the previous season's episodes synchronously so the
            // very next render shows the skeleton, not a stale grid, before
            // `.task(id: selectedSeason)` starts the new load.
            episodeModel.clearForSeasonSwitch()
            selectedSeason = season.seasonNumber
        } label: {
            Text(seasonLabel(season))
                .font(.system(size: 24, weight: isSelected ? .semibold : .regular))
        }
        .buttonStyle(SeasonTabChipStyle(isSelected: isSelected))
        .accessibilityIdentifier("seasonTab_\(season.seasonNumber)")
    }

    /// Web `seasonLabel` (lines 23-28): specials (season 0) → the season's
    /// name or "Specials"; otherwise the name unless it's a bare
    /// `^season ` prefix, in which case "Season N".
    private func seasonLabel(_ season: ItemDetail.SeasonSummary) -> String {
        if season.seasonNumber == 0 {
            return season.name ?? L10n.t("title.specials")
        }
        if let name = season.name, !name.isEmpty,
           name.range(of: "^season\\s", options: [.regularExpression, .caseInsensitive]) == nil {
            return name
        }
        return L10n.t("title.seasonNumber", season.seasonNumber)
    }

    // MARK: - Episodes region (grid / skeleton / empty / error)

    @ViewBuilder
    private func episodesRegion(client: OrbixClient) -> some View {
        switch episodeModel.loadState {
        case .loading:
            skeletonGrid
        case .notFound, .empty:
            noEpisodesView
        case .error(let message):
            errorView(message: message, client: client)
        case .loaded(let episodes):
            episodeGrid(episodes)
        }
    }

    private func episodeGrid(_ episodes: [Episode]) -> some View {
        LazyVGrid(columns: gridColumns, alignment: .leading, spacing: 40) {
            ForEach(episodes, id: \.id) { episode in
                episodeCard(episode)
            }
        }
        .focusSection()
        .accessibilityIdentifier("seasonEpisodeList_\(seriesId)_\(selectedSeason)")
    }

    private func episodeCard(_ episode: Episode) -> some View {
        let playable = episode.fileId != nil
        return Button {
            guard let fileId = episode.fileId, let client = model.client, let baseURL = model.baseURL else { return }
            presentPlayer(for: episode, fileId: fileId, client: client, baseURL: baseURL)
        } label: {
            EpisodeCardContent(
                episode: episode,
                stillURL: stillURL(episode),
                title: episodeLabel(episode),
                runtime: Self.formattedRuntime(episode.runtimeSec),
                playable: playable,
                progressFraction: progressFraction(episode),
                cardWidth: Self.cardWidth,
                cardHeight: Self.cardHeight,
                imageLoader: imageLoader
            )
        }
        .buttonStyle(EpisodeCardStyle())
        // Always rendered rather than hidden (same rationale as
        // TitlePage.playButton): a dimmed, disabled card communicates "not
        // in the library yet" instead of silently omitting the episode.
        // tvOS's focus engine skips a `disabled` control rather than parking
        // focus on it.
        .disabled(!playable)
        .opacity(playable ? 1 : 0.5)
        .accessibilityIdentifier("episodeRow_\(episode.id)")
    }

    // MARK: - Skeleton / empty / error

    /// 8 tiles, matching the web skeleton count (`Array.from({length: 8})`,
    /// lines 111-118). Same `SkeletonView` tile shape as
    /// `LibraryBrowseView.skeletonGrid`, sized to the 16:9 card.
    private var skeletonGrid: some View {
        LazyVGrid(columns: gridColumns, alignment: .leading, spacing: 40) {
            ForEach(0..<8, id: \.self) { _ in
                VStack(alignment: .leading, spacing: 10) {
                    SkeletonView(cornerRadius: OrbixRadius.sm)
                        .frame(width: Self.cardWidth, height: Self.cardHeight)
                    SkeletonView()
                        .frame(width: Self.cardWidth * 0.7, height: 16)
                }
            }
        }
        .allowsHitTesting(false)
        .accessibilityIdentifier("seasonEpisodeSkeleton")
    }

    /// Web `title:noEpisodes` (line 120): shown only when a season genuinely
    /// has no episodes, never while it's still loading (the skeleton covers
    /// that).
    private var noEpisodesView: some View {
        Text(L10n.t("title.noEpisodes"))
            .font(.callout)
            .foregroundStyle(OrbixColor.textDim)
            .padding(.vertical, 24)
            .padding(.leading, 4)
            .accessibilityIdentifier("seasonEpisodeEmptyState")
    }

    private func errorView(message: String, client: OrbixClient) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(message)
                .font(.callout)
                .foregroundStyle(OrbixColor.textDim)
            Button(L10n.t("common.actions.retry")) {
                Task { await episodeModel.load(seriesId: seriesId, season: selectedSeason, client: client) }
            }
            .accessibilityIdentifier("seasonEpisodeRetryButton")
        }
        .padding(.vertical, 24)
        .padding(.leading, 4)
        .accessibilityIdentifier("seasonEpisodeErrorState")
    }

    // MARK: - Episode display helpers

    /// `"Pilot"` when titled, `"Episode 3"` otherwise.
    private func episodeDisplayTitle(_ episode: Episode) -> String {
        if let title = episode.title, !title.isEmpty { return title }
        return L10n.t("title.episodeNumber", episode.episodeNumber)
    }

    /// `"3. Pilot"` when titled, `"Episode 3"` otherwise (web `"# Title"`,
    /// line 174).
    private func episodeLabel(_ episode: Episode) -> String {
        if let title = episode.title, !title.isEmpty {
            return "\(episode.episodeNumber). \(title)"
        }
        return episodeDisplayTitle(episode)
    }

    /// Shown via the player's `externalMetadata` (its `videoTitle` param) so
    /// tvOS's transport/info UI reads e.g. "S1E3 — Pilot" instead of just
    /// the bare episode title.
    private func playerTitle(for episode: Episode) -> String {
        "S\(selectedSeason)E\(episode.episodeNumber) — \(episodeDisplayTitle(episode))"
    }

    /// `3720` → `"1h 2m"`; `600` → `"10m"`; `nil`/non-positive → `nil`.
    private static func formattedRuntime(_ seconds: Int?) -> String? {
        guard let seconds, seconds > 0 else { return nil }
        let hours = seconds / 3600
        let minutes = (seconds % 3600) / 60
        return hours > 0 ? L10n.t("title.runtime.hm", hours, minutes) : L10n.t("title.runtime.m", minutes)
    }

    /// Web `pct` (lines 125-130): a finished episode fills the bar; otherwise
    /// `positionSec / durationSec` when the duration is positive, else 0.
    /// The caller draws the bar only when this is `> 0`.
    private func progressFraction(_ episode: Episode) -> Double {
        guard let progress = episode.progress else { return 0 }
        if progress.finished { return 1 }
        guard progress.durationSec > 0 else { return 0 }
        return min(1, max(0, Double(progress.positionSec) / Double(progress.durationSec)))
    }

    private func stillURL(_ episode: Episode) -> URL? {
        guard let stillPath = episode.stillPath, let baseURL = model.baseURL else { return nil }
        return baseURL.appending(path: "api/images/\(stillPath)")
    }

    // MARK: - Playback + next-episode

    /// Plays the first owned (`fileId != nil`) episode of the currently
    /// loaded season when a hero Play (`token`) is pending and unhandled —
    /// the web `playFirstToken`/`handledToken` effect (lines 62-75). No-op
    /// on a plain season switch (token still 0 or already handled) or when
    /// the season has no owned episode.
    private func playFirstOwnedIfNeeded(token: Int) {
        guard token > 0, token != handledPlayToken else { return }
        guard let first = episodeModel.episodes.first(where: { $0.fileId != nil }),
              let fileId = first.fileId,
              let client = model.client, let baseURL = model.baseURL else { return }
        handledPlayToken = token
        presentPlayer(for: first, fileId: fileId, client: client, baseURL: baseURL)
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

    /// Runs once the `.fullScreenCover`'s dismissal completes — whether
    /// that was the user backing out early (`PlayerScreen`'s own
    /// `.onExitCommand { dismiss() }`) or this view clearing
    /// `playbackTarget` itself after observing end-of-item (`body`'s
    /// `.task(id:)`). Only the latter (`reachedEnd == true`) looks up and
    /// presents `episodeNumber + 1`, and only when it exists *and* has a
    /// `fileId` — an unmatched next episode or the season finale simply
    /// leaves the user back on the episode grid, same as any other exit.
    /// Refreshes the episode list either way (best-effort, fire-and-forget)
    /// so the just-watched card's progress bar reflects the final progress
    /// report the player just issued — without blocking (or being blocked
    /// by) a possible auto-advance, which reads the still-in-memory episode
    /// list so the transition to the next episode isn't held up by a network
    /// round trip.
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
            Task { await episodeModel.load(seriesId: seriesId, season: selectedSeason, client: client) }
        }
    }
}

/// Drives `SeasonEpisodeListView`: loads
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

    /// The season `episodes` currently correspond to, so `load` can tell a
    /// season *switch* (clear the stale grid so the skeleton shows) from a
    /// same-season refresh (keep the grid, only refresh per-episode
    /// progress), and so a slow response for a season the user has since
    /// switched away from can't clobber the newer season's grid.
    private var loadedSeason: Int?

    init() {}

    var loadState: LoadState {
        guard episodes.isEmpty else { return .loaded(episodes) }
        if isLoading || !hasLoaded { return .loading }
        if notFound { return .notFound }
        if let loadError { return .error(loadError) }
        return .empty
    }

    /// Clears the grid immediately (called synchronously from a season-tab
    /// tap, before `selectedSeason` changes) so the switch shows the
    /// skeleton rather than a frame of the previous season's episodes.
    func clearForSeasonSwitch() {
        episodes = []
        hasLoaded = false
        isLoading = false
        loadError = nil
        notFound = false
    }

    /// Fetches one season's episode list. A season *switch* clears the
    /// previous season's episodes (so `loadState` reads `.loading` → the
    /// skeleton shows); a same-season refresh (post-playback) keeps them and
    /// just refreshes progress. Stale/cancelled responses (a season the user
    /// switched away from mid-flight) are discarded rather than written.
    func load(seriesId: String, season: Int, client: OrbixClient) async {
        if season != loadedSeason {
            episodes = []
            hasLoaded = false
        }
        loadedSeason = season
        isLoading = true
        loadError = nil
        notFound = false

        do {
            let fetched = try await client.episodes(itemId: seriesId, season: season)
            guard !Task.isCancelled, loadedSeason == season else { return }
            episodes = fetched
        } catch {
            guard !Task.isCancelled, loadedSeason == season else { return }
            if let orbixError = error as? OrbixError, case .http(404, _) = orbixError {
                notFound = true
            } else if let orbixError = error as? OrbixError, case .http(_, let code) = orbixError, let code {
                loadError = L10n.errorMessage(code)
            } else {
                loadError = L10n.t("errors.network")
            }
        }

        guard !Task.isCancelled, loadedSeason == season else { return }
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
/// episode — see `SeasonEpisodeListView.presentPlayer`/`body`'s
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

/// One episode's card content: still art (or the big episode number) on top
/// with a focus-driven play glyph + per-episode progress bar, then
/// `"# Title"` + runtime below (web lines 134-182). Reads `\.isFocused`
/// (forwarded by `EpisodeCardStyle`) to promote/scale and reveal the play
/// glyph, matching `BoxArtCard`/`SortChipStyle`'s custom focus treatment
/// rather than tvOS's default platter.
private struct EpisodeCardContent: View {
    let episode: Episode
    let stillURL: URL?
    let title: String
    let runtime: String?
    let playable: Bool
    let progressFraction: Double
    let cardWidth: CGFloat
    let cardHeight: CGFloat
    let imageLoader: ImageLoader

    @Environment(\.episodeCardFocused) private var isFocused

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            still
            titleBlock
        }
        .frame(width: cardWidth, alignment: .leading)
        .focusPromote(isFocused)
    }

    private var still: some View {
        ZStack(alignment: .bottom) {
            EpisodeStillArtwork(url: stillURL, episodeNumber: episode.episodeNumber, imageLoader: imageLoader)
                .frame(width: cardWidth, height: cardHeight)
                .overlay {
                    if playable, isFocused {
                        ZStack {
                            Color.black.opacity(0.35)
                            Image(systemName: "play.fill")
                                .font(.system(size: 44))
                                .foregroundStyle(.white)
                        }
                    }
                }

            if progressFraction > 0 {
                ProgressBarView(fraction: progressFraction)
            }
        }
        .frame(width: cardWidth, height: cardHeight)
        .clipShape(RoundedRectangle(cornerRadius: OrbixRadius.sm, style: .continuous))
    }

    private var titleBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(OrbixColor.text)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if let runtime {
                    Text(runtime)
                        .font(.caption)
                        .foregroundStyle(OrbixColor.textDim)
                }
            }
            if !playable {
                Text(L10n.t("title.notInLibrary"))
                    .font(.caption)
                    .italic()
                    .foregroundStyle(OrbixColor.textDim)
            }
        }
        .frame(width: cardWidth, alignment: .leading)
    }
}

/// Forwards a `SeasonEpisodeListView` episode button's focus state from
/// `EpisodeCardStyle` (which reads `\.isFocused` reliably in `makeBody`,
/// same precedent as `BoxArtCardStyle`/`SortChipStyle`) into its label's
/// subtree, so `EpisodeCardContent` can drive its play glyph + promote off
/// the button's own focus.
private struct EpisodeCardFocusedKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var episodeCardFocused: Bool {
        get { self[EpisodeCardFocusedKey.self] }
        set { self[EpisodeCardFocusedKey.self] = newValue }
    }
}

/// Disables tvOS's system focus platter behind the custom episode card
/// (same clash `BoxArtCardStyle` documents) and forwards focus into the
/// card content via `\.episodeCardFocused`.
private struct EpisodeCardStyle: ButtonStyle {
    @Environment(\.isFocused) private var isFocused

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .environment(\.episodeCardFocused, isFocused)
            .focusEffectDisabled()
    }
}

/// A season-tab chip's focus/selection styling — the same treatment as
/// `LibraryBrowseView`'s `SortChipStyle`: the system focus platter is
/// disabled (`.focusEffectDisabled()`) since the chip carries its own fill;
/// a focused chip goes fully white (fill + text) and scales up, an
/// unfocused-but-selected chip is tinted `OrbixColor.accent`, and an idle
/// chip sits on `OrbixColor.surface` with a thin `OrbixColor.surface2`
/// border (mirrors the web tab's accent underline for the active tab).
private struct SeasonTabChipStyle: ButtonStyle {
    let isSelected: Bool
    @Environment(\.isFocused) private var isFocused

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(isFocused ? Color.white : (isSelected ? Color.white : OrbixColor.textDim))
            .padding(.horizontal, 28)
            .padding(.vertical, 14)
            .background(background, in: RoundedRectangle(cornerRadius: OrbixRadius.sm, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: OrbixRadius.sm, style: .continuous)
                    .strokeBorder(OrbixColor.surface2, lineWidth: isSelected || isFocused ? 0 : 1)
            )
            .overlay(
                RoundedRectangle(cornerRadius: OrbixRadius.sm, style: .continuous)
                    .strokeBorder(Color.white, lineWidth: isFocused ? 3 : 0)
            )
            .scaleEffect(isFocused ? 1.06 : 1.0)
            .animation(.easeOut(duration: 0.15), value: isFocused)
            .focusEffectDisabled()
    }

    private var background: Color {
        isFocused ? Color.white.opacity(0.25) : (isSelected ? OrbixColor.accent : OrbixColor.surface)
    }
}

/// Episode still-frame art fetched via `ImageLoader`; the big episode number
/// as a placeholder when there's no still at all (web line 156), or a plain
/// surface fill while a real still loads. Mirrors `PosterCard`'s
/// `PosterArtwork` (own tiny loader-view per call site, same `.task(id:)`
/// reload-on-url-change behavior, different placeholder for the 16:9 still).
private struct EpisodeStillArtwork: View {
    let url: URL?
    let episodeNumber: Int
    let imageLoader: ImageLoader

    @State private var uiImage: UIImage?

    var body: some View {
        ZStack {
            Rectangle().fill(OrbixColor.surface2)
            if let uiImage {
                Image(uiImage: uiImage)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } else if url == nil {
                // No still at all → the big episode number (web line 156).
                Text("\(episodeNumber)")
                    .font(.system(size: 48, weight: .semibold))
                    .foregroundStyle(OrbixColor.textDim)
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

#Preview {
    SeasonEpisodeListView(
        seriesId: "s1",
        seasons: [
            ItemDetail.SeasonSummary(seasonNumber: 0, name: "Specials", episodeCount: 2),
            ItemDetail.SeasonSummary(seasonNumber: 1, name: "Season 1", episodeCount: 8),
            ItemDetail.SeasonSummary(seasonNumber: 2, name: "The Reckoning", episodeCount: 10),
        ],
        model: AppModel(),
        playFirstToken: 0
    )
    .padding(60)
    .background(OrbixColor.bg)
}
