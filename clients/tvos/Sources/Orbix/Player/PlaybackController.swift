import Foundation
import Observation
import OrbixKit

/// Coordinates one playback attempt for a single (itemId, fileId,
/// episodeId?) tuple: negotiates the resume position (`getProgress`) and
/// the stream (`playbackInfo(fileId:, .appleTV)`), exposes both to
/// `PlayerScreen`/`PlayerViewController`, and owns the *logic* of progress
/// reporting (what to send, and in what order) — never the AVFoundation
/// observers that trigger it. Those (the periodic time observer, the pause
/// notification, the ready-to-play KVO) live on
/// `PlayerViewController.Coordinator`, which calls into this type's
/// `reportProgress`/`teardown` methods; see that type's doc comment for why
/// the split is drawn there (in short: the Coordinator is the only thing
/// that owns an `AVPlayer` reference and has a guaranteed teardown hook
/// (`dismantleUIViewController`) — this type never touches `AVPlayer` at
/// all, which keeps it independently testable — see `PlaybackProgressTests`,
/// which exercises `getProgress`/`putProgress`/`stopPlayback` with no player
/// or UI involved).
///
/// One instance per playback attempt — `PlayerScreen` creates a fresh
/// `PlaybackController` each time the Play button is tapped, so
/// `playSessionId` never changes mid-instance.
@MainActor
@Observable
final class PlaybackController {
    enum LoadState: Equatable {
        case loading
        case error(String)
        case ready(streamURL: URL, resumeSeconds: Double)
    }

    let itemId: String
    let fileId: String
    let episodeId: String?

    private(set) var loadState: LoadState = .loading

    private let client: OrbixClient
    private let baseURL: URL
    private var playSessionId: String?

    /// Chains progress PUTs so a slow periodic report can never complete
    /// *after* (and clobber) a later one with a stale position — each new
    /// report `await`s the previous one before firing, so they reach the
    /// server in the order they were issued. `teardown`'s final report goes
    /// through this same chain, guaranteeing it's the last write.
    private var reportChain: Task<Void, Never>?

    init(itemId: String, fileId: String, episodeId: String? = nil, client: OrbixClient, baseURL: URL) {
        self.itemId = itemId
        self.fileId = fileId
        self.episodeId = episodeId
        self.client = client
        self.baseURL = baseURL
    }

    /// Negotiates playback: fetches the resume position, then the stream.
    /// A `getProgress` failure degrades to "no resume" (position 0) rather
    /// than failing the whole screen — a fresh play is always possible even
    /// when the watch-history read fails; a `playbackInfo` failure is the
    /// one that surfaces as `.error`, since there's genuinely nothing to
    /// play without it.
    func start() async {
        loadState = .loading

        let progress = try? await client.getProgress(itemId: itemId, episodeId: episodeId)

        do {
            let info = try await client.playbackInfo(fileId: fileId, capabilities: .appleTV)
            playSessionId = info.playSessionId

            guard let streamURL = URL(string: info.streamUrl, relativeTo: baseURL)?.absoluteURL else {
                loadState = .error("Couldn't resolve the stream URL.")
                return
            }

            let resumeSeconds: Double
            if let progress, progress.positionSec > 0, !progress.finished {
                resumeSeconds = Double(progress.positionSec)
            } else {
                resumeSeconds = 0
            }
            loadState = .ready(streamURL: streamURL, resumeSeconds: resumeSeconds)
        } catch {
            loadState = .error("Couldn't start playback: \(error)")
        }
    }

    /// Called by `PlayerViewController.Coordinator` roughly every 10s and on
    /// pause. Fire-and-forget from the caller's perspective — never makes
    /// the AVFoundation callback that triggered it wait on a network call.
    func reportProgress(positionSec: Double, durationSec: Double) {
        enqueueReport(positionSec: positionSec, durationSec: durationSec)
    }

    /// Called exactly once, from `PlayerViewController.Coordinator.teardown()`
    /// (itself called from `dismantleUIViewController`): waits for the final
    /// progress PUT to actually be issued, then stops the play session. Both
    /// steps are best-effort — `putProgress`'s failure is swallowed by
    /// `enqueueReport`, `stopPlayback`'s by `OrbixClient` itself (see its
    /// doc comment) — there's no one left to show an error to once the
    /// player screen is gone.
    func teardown(positionSec: Double, durationSec: Double) async {
        let finalReport = enqueueReport(positionSec: positionSec, durationSec: durationSec)
        await finalReport.value
        if let playSessionId {
            await client.stopPlayback(playSessionId: playSessionId)
        }
    }

    @discardableResult
    private func enqueueReport(positionSec: Double, durationSec: Double) -> Task<Void, Never> {
        guard let playSessionId else {
            // Negotiation hasn't completed (or failed) yet — nothing to
            // report against. Still routed through `reportChain` so a
            // caller awaiting the returned task (`teardown`) never hangs.
            let noop = Task {}
            reportChain = noop
            return noop
        }
        let previous = reportChain
        let client = client
        let itemId = itemId
        let episodeId = episodeId
        let task = Task {
            await previous?.value
            try? await client.putProgress(
                itemId: itemId,
                positionSec: positionSec,
                durationSec: durationSec,
                episodeId: episodeId,
                playSessionId: playSessionId
            )
        }
        reportChain = task
        return task
    }
}
