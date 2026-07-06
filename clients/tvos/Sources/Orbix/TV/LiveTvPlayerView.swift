import AVFoundation
import OrbixKit
import SwiftUI
import UIKit

/// Bare live-TV player surface — a `UIViewControllerRepresentable` hosting a
/// plain `AVPlayer` + `AVPlayerLayer` (no `AVPlayerViewController` transport
/// UI; `LiveTvOverlay` owns all chrome). Deliberately **not** the VOD
/// `PlayerViewController`: no progress PUTs, no resume seek, no
/// `/playback/info`, no transport-bar menu.
///
/// It rebuilds the `AVPlayerItem` whenever `generation` changes — the tvOS
/// analogue of the web `LiveTvPlayer`'s `key={streamId:attempt}` remount, but
/// finer-grained: `LiveTvController.playGeneration` bumps on tune, on the
/// in-place reload, and on every source advance, so even a same-URL reload
/// gets a fresh item (the AVPlayer equivalent of hls.js `startLoad()`).
///
/// ## AVPlayer observation design
/// The controller never touches `AVPlayer`; this coordinator is the sole
/// bridge. Following the VOD `PlayerViewController.Coordinator` precedent, KVO
/// change handlers do no work themselves — they hop to the `@MainActor` and
/// re-read state from the coordinator's stored (weak) player/item refs, so
/// there is never a non-`Sendable` AVFoundation value crossing an actor
/// boundary. Signals wired to the controller:
/// - `AVPlayerItem.status == .failed` (KVO) → `reportFailure(code:)`.
/// - `AVPlayerItemFailedToPlayToEndTime` (Notification) → `reportFailure(code:)`.
/// - `AVPlayer.timeControlStatus == .playing` (KVO) → `playbackStarted()`.
///   `.playing` is AVPlayer's "actually rendering frames" signal — the most
///   reliable first-frame proxy — and `playbackStarted()` is idempotent
///   (cancels the watchdog; schedules the 30 s health-ok once), so repeated
///   `.playing` transitions are harmless.
///
/// `reportFailure` — not the two observers directly — is what calls
/// `controller.playbackFailed(code:)`, and it forwards **at most once per
/// `AVPlayerItem`** (see `failureReported`). AVPlayer can raise both the KVO
/// `.failed` status *and* the `AVPlayerItemFailedToPlayToEndTime` notification
/// for the same underlying error; without this guard the controller would see
/// two `playbackFailed` calls before the first one's in-place reload actually
/// rebuilds the item (the reload only takes effect on the *next*
/// `rebuildIfNeeded`, since `LiveTvController` mutates `@Observable` state that
/// SwiftUI re-renders asynchronously), so the second, stale call would find
/// `reloadedOnce` already `true` and immediately — and wrongly — advance past
/// a source that never actually failed twice, burning the "retry once" rung.
/// Deduping here (rather than with a generation counter on the controller) is
/// deliberate: `LiveTvController.emitPlaying()` bumps `playGeneration`
/// *synchronously* inside the first `playbackFailed` call, before the second,
/// already-in-flight signal is processed, so a "generation I last handled" flag
/// read from the controller would already see the bumped generation and treat
/// the stale second call as new. The dedup instead has to live where the two
/// duplicate signals actually originate — this coordinator, scoped to one
/// concrete `AVPlayerItem` instance — and is reset only when `rebuildIfNeeded`
/// wires up a genuinely new item.
/// Every observer is torn down in `dismantleUIViewController` (the one hook
/// guaranteed to fire) so no observer leaks the player graph.
struct LiveTvPlayerView: UIViewControllerRepresentable {
    let streamURL: URL
    /// `LiveTvController.playGeneration` — the item-rebuild key.
    let generation: Int
    let controller: LiveTvController

    func makeCoordinator() -> Coordinator {
        Coordinator(controller: controller)
    }

    func makeUIViewController(context: Context) -> LivePlayerViewController {
        let vc = LivePlayerViewController()
        context.coordinator.rebuildIfNeeded(player: vc.player, url: streamURL, generation: generation)
        return vc
    }

    func updateUIViewController(_ vc: LivePlayerViewController, context: Context) {
        context.coordinator.rebuildIfNeeded(player: vc.player, url: streamURL, generation: generation)
    }

    static func dismantleUIViewController(_ vc: LivePlayerViewController, coordinator: Coordinator) {
        coordinator.teardown()
    }

    /// Owns the KVO/Notification observers for the current item and reports
    /// first-frame/failure to the `LiveTvController`. `@MainActor` so its
    /// callbacks touch the (`@MainActor`) controller safely.
    @MainActor
    final class Coordinator {
        private let controller: LiveTvController
        private weak var observedPlayer: AVPlayer?
        private weak var observedItem: AVPlayerItem?
        private var currentGeneration: Int?

        private var statusObservation: NSKeyValueObservation?
        private var timeControlObservation: NSKeyValueObservation?
        private var failedToEndObserver: NSObjectProtocol?

        /// Set once `reportFailure` has forwarded a failure for the current
        /// item; reset to `false` on every new item in `rebuildIfNeeded`. See
        /// the type-level doc comment for why the dedup lives here and not on
        /// `LiveTvController`.
        private var failureReported = false

        init(controller: LiveTvController) {
            self.controller = controller
        }

        /// (Re)build the item for `url` when `generation` changes. Same-URL
        /// reloads (generation bumped, url unchanged) rebuild too — that's the
        /// in-place reload rung of the ladder.
        func rebuildIfNeeded(player: AVPlayer, url: URL, generation: Int) {
            guard currentGeneration != generation else { return }
            currentGeneration = generation
            detachObservers()
            failureReported = false

            let item = AVPlayerItem(url: url)
            observedPlayer = player
            observedItem = item

            statusObservation = item.observe(\.status, options: [.new]) { [weak self] _, _ in
                Task { @MainActor [weak self] in self?.handleItemStatus() }
            }
            timeControlObservation = player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
                Task { @MainActor [weak self] in self?.handleTimeControlStatus() }
            }
            failedToEndObserver = NotificationCenter.default.addObserver(
                forName: .AVPlayerItemFailedToPlayToEndTime,
                object: item,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor [weak self] in
                    self?.reportFailure(code: "failed_to_play_to_end")
                }
            }

            player.replaceCurrentItem(with: item)
            player.play()
        }

        func teardown() {
            detachObservers()
            observedPlayer?.replaceCurrentItem(with: nil)
            observedPlayer = nil
            observedItem = nil
        }

        private func handleItemStatus() {
            guard observedItem?.status == .failed else { return }
            reportFailure(code: "item_failed")
        }

        private func handleTimeControlStatus() {
            guard observedPlayer?.timeControlStatus == .playing else { return }
            controller.playbackStarted()
        }

        /// Forwards to `controller.playbackFailed(code:)` at most once per
        /// `AVPlayerItem` — see `failureReported`.
        private func reportFailure(code: String) {
            guard !failureReported else { return }
            failureReported = true
            controller.playbackFailed(code: code)
        }

        private func detachObservers() {
            statusObservation?.invalidate()
            statusObservation = nil
            timeControlObservation?.invalidate()
            timeControlObservation = nil
            if let failedToEndObserver {
                NotificationCenter.default.removeObserver(failedToEndObserver)
                self.failedToEndObserver = nil
            }
        }
    }
}

/// A `UIViewController` whose view is backed by an `AVPlayerLayer` (fills the
/// bounds, aspect-fit, black letterbox) hosting a long-lived `AVPlayer`. The
/// player never carries transport UI — the overlay draws all chrome on top.
final class LivePlayerViewController: UIViewController {
    /// One long-lived player for this presentation; the coordinator swaps its
    /// current item as the ladder advances. Live playback relies on AVPlayer's
    /// default live-edge behavior — there is no custom catch-up in v1.
    let player = AVPlayer()

    override func loadView() {
        let container = PlayerLayerView()
        container.backgroundColor = .black
        container.playerLayer.player = player
        container.playerLayer.videoGravity = .resizeAspect
        view = container
    }
}

/// `UIView` whose backing layer is an `AVPlayerLayer`, so it resizes with the
/// view automatically (no manual frame bookkeeping).
final class PlayerLayerView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}

#Preview("Live player surface (black in preview)") {
    LiveTvPlayerView(
        streamURL: URL(string: "http://preview.invalid/index.m3u8")!,
        generation: 1,
        controller: LiveTvController(channelId: "preview", client: nil, baseURL: nil)
    )
    .ignoresSafeArea()
}
