import OrbixKit
import Observation
import SwiftUI

/// Lightweight live-TV controller — tvOS sibling of the web `LiveTvPlayer`'s
/// tune + failover logic (`apps/web/src/components/tv/LiveTvPlayer.tsx`),
/// **not** the VOD `PlaybackController`: no `/playback/info`, no progress PUTs,
/// no resume seek. It tunes a channel (logs the watch event, fetches the
/// ordered sources), drives the multi-source **failover ladder**, reports
/// per-source health, and tracks offline/exhaustion — and it **never touches
/// `AVPlayer`**. The `LiveTvPlayerView` coordinator observes the player and
/// calls `playbackFailed(code:)` / `playbackStarted()` back into here — deduped
/// to at most one `playbackFailed` per real failure (see the coordinator's
/// `reportFailure`), so this controller can assume every call it receives
/// (bar the watchdog, which is its own distinct failure source) represents a
/// genuinely new event and is safe to advance the ladder on unconditionally.
///
/// ## Failover ladder (AVPlayer-adapted)
/// hls.js's NETWORK-vs-MEDIA distinction has no AVPlayer analogue, so the web
/// ladder collapses to **one in-place reload per source, then advance** (the
/// same "retry-once-then-next" shape) plus a fast **dead-channel watchdog** so
/// a source that never produces a first frame fails over within ~8 s (spec
/// §13). Health is reported per source: `ok:false` on advance, `ok:true` once
/// after 30 s of stable playback.
///
/// ## Web→tvOS adaptations (documented deviations from the brief's code)
/// - `client`/`baseURL` are **optional** (mirroring `AppModel`'s optionals) so
///   the overlay's `#Preview` renders without a network — a nil client tunes
///   straight to `.offline`.
/// - `playGeneration` (below) is a new counter the player keys its
///   `AVPlayerItem` rebuild on. The web forces a fresh player via
///   `key={streamId:attempt}`; an **in-place reload** keeps the same
///   `streamURL` *and* `attempt`, so with those alone the reload would rebuild
///   nothing. Bumping `playGeneration` on every (re)emit of `.playing`
///   (tune / in-place reload / source advance) gives the player an unambiguous
///   "rebuild the item now" signal even for the same URL — the AVPlayer
///   equivalent of hls.js's imperative `startLoad()`.
/// - Toast copy matches the web English strings (`tv:player.reconnecting`,
///   `tv:player.tryingSource`).
@MainActor
@Observable
final class LiveTvController {
    enum LoadState: Equatable { case loading, playing(URL), offline }

    private(set) var channelId: String
    private(set) var play: TvPlayResponse?
    private(set) var sourceIndex = 0
    private(set) var loadState: LoadState = .loading
    /// Transient status line ("Reconnecting…", "Trying next source 2/3…")
    /// shown by the overlay.
    private(set) var toast: String?
    /// Bumped on offline-panel Retry → re-tune the same channel from source 0.
    /// Its rebuild-forcing role is subsumed by `playGeneration` (Retry →
    /// `tune` → a fresh `.playing` emit bumps the generation); kept as the
    /// public "re-tune count" the brief specifies.
    private(set) var attempt = 0
    /// Monotonic "(re)build the AVPlayerItem now" key — see the type's
    /// adaptation note. The player keys its item rebuild on this value.
    private(set) var playGeneration = 0

    private let client: OrbixClient?
    private let baseURL: URL?

    // Per-source ladder state.
    private var reloadedOnce = false
    private var reportedOk = false
    private var healthTask: Task<Void, Never>?
    private var watchdogTask: Task<Void, Never>?
    private var toastTask: Task<Void, Never>?

    private static let healthOkAfterNs: UInt64 = 30_000_000_000  // web HEALTH_OK_AFTER_MS
    private static let deadChannelWatchdogNs: UInt64 = 8_000_000_000 // ~ manifest policy timeout
    private static let toastNs: UInt64 = 4_000_000_000

    init(channelId: String, client: OrbixClient?, baseURL: URL?) {
        self.channelId = channelId
        self.client = client
        self.baseURL = baseURL
    }

    var currentSource: TvPlaySource? {
        guard let play, sourceIndex < play.sources.count else { return nil }
        return play.sources[sourceIndex]
    }

    /// The current source resolved against `baseURL`. `src` is already a
    /// same-origin `/api/tv/proxy/…` path (server-tokened for bearer clients).
    var streamURL: URL? {
        guard let src = currentSource?.src, let baseURL else { return nil }
        return URL(string: src, relativeTo: baseURL)?.absoluteURL
    }

    /// Tune a channel: log the event (fire-and-forget, not awaited — see
    /// below), fetch ordered sources, start from source 0. A 409/404/network,
    /// empty sources, or no client → offline.
    func tune(to id: String) async {
        cancelTimers()
        channelId = id
        play = nil
        sourceIndex = 0
        reloadedOnce = false
        reportedOk = false
        toast = nil
        loadState = .loading

        guard let client else { loadState = .offline; return }
        // Fire-and-forget: the watch-event log must not delay the zap. Spawned
        // as its own Task rather than `await`ed so `tvChannelPlay` below starts
        // immediately instead of serializing behind the log request.
        Task { await client.postTvEvent(channelId: id) }
        do {
            let p = try await client.tvChannelPlay(id: id)
            guard channelId == id else { return } // superseded by a newer tune
            guard !p.sources.isEmpty else { loadState = .offline; return }
            play = p
            emitPlaying()
            startWatchdog()
        } catch {
            guard channelId == id else { return }
            loadState = .offline
        }
    }

    /// Offline-panel Retry: re-tune from source 0 with a fresh attempt id.
    func retry() {
        attempt += 1
        Task { await tune(to: channelId) }
    }

    /// AVPlayer reported a fatal failure for the current source (item `.failed`,
    /// failed-to-play-to-end, or the watchdog). Web ladder → one in-place
    /// reload, then advance to the next source; every *advanced-past* source
    /// reports `ok:false`. The `LiveTvPlayerView.Coordinator` collapses the
    /// KVO `.failed` signal and the `AVPlayerItemFailedToPlayToEndTime`
    /// notification for one underlying error into a single call here (see its
    /// `reportFailure`), so this ladder logic runs at most once per real
    /// failure and never double-consumes the retry-once rung.
    func playbackFailed(code: String) {
        guard let play, let src = currentSource else { return }
        if !reloadedOnce {
            reloadedOnce = true
            // Cancel any in-flight 30 s health-ok timer and un-mark this
            // source as reported — a mid-flight reload means playback wasn't
            // actually stable, so the health clock must restart from the
            // *reconnected* start (mirrors the web's timer clear on reconnect)
            // rather than keep counting from the original, now-invalid start.
            healthTask?.cancel()
            healthTask = nil
            reportedOk = false
            showToast(L10n.t("tv.player.reconnecting"))
            emitPlaying()                          // rebuild the AVPlayerItem in place
            startWatchdog()
            return
        }
        Task { [client] in await client?.postTvStreamHealth(streamId: src.streamId, ok: false, code: code) }
        cancelTimers()
        let next = sourceIndex + 1
        if next < play.sources.count {
            sourceIndex = next
            reloadedOnce = false
            reportedOk = false
            showToast(L10n.t("tv.player.tryingSource", next + 1, play.sources.count))
            emitPlaying()
            startWatchdog()
        } else {
            loadState = .offline                   // overlay shows the offline panel
        }
    }

    /// AVPlayer produced a first frame / is playing: cancel the dead-channel
    /// watchdog and, once, schedule the 30 s "healthy" report for this source.
    func playbackStarted() {
        watchdogTask?.cancel()
        watchdogTask = nil
        guard !reportedOk, healthTask == nil, let src = currentSource else { return }
        healthTask = Task { [weak self, client] in
            try? await Task.sleep(nanoseconds: Self.healthOkAfterNs)
            guard let self, !Task.isCancelled else { return }
            self.reportedOk = true
            self.healthTask = nil
            await client?.postTvStreamHealth(streamId: src.streamId, ok: true)
        }
    }

    // MARK: - Private

    /// Emit `.playing` for the current `streamURL` and bump `playGeneration`
    /// so the player (re)builds its item — or `.offline` if there's no URL.
    private func emitPlaying() {
        if let url = streamURL {
            playGeneration += 1
            loadState = .playing(url)
        } else {
            loadState = .offline
        }
    }

    private func startWatchdog() {
        watchdogTask?.cancel()
        watchdogTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: Self.deadChannelWatchdogNs)
            guard let self, !Task.isCancelled else { return }
            self.watchdogTask = nil
            self.playbackFailed(code: "watchdog_no_first_frame")
        }
    }

    private func showToast(_ msg: String) {
        toast = msg
        toastTask?.cancel()
        toastTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: Self.toastNs)
            if !Task.isCancelled { self?.toast = nil }
        }
    }

    private func cancelTimers() {
        healthTask?.cancel()
        healthTask = nil
        watchdogTask?.cancel()
        watchdogTask = nil
    }

    // No `deinit` timer-cancel: a `deinit` on a Swift-6 `@MainActor` class is
    // nonisolated and may not touch the isolated task properties (the brief's
    // deinit is not Swift-6-legal here). It is unneeded anyway — every timer
    // Task captures `[weak self]` and no-ops once `self` deinits, so they
    // self-terminate without an explicit cancel.
}
