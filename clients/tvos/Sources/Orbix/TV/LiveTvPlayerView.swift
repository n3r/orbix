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
/// - `AVPlayerItem.status == .failed` (KVO) → `playbackFailed(code:)`.
/// - `AVPlayerItemFailedToPlayToEndTime` (Notification) → `playbackFailed`.
/// - `AVPlayer.timeControlStatus == .playing` (KVO) → `playbackStarted()`.
///   `.playing` is AVPlayer's "actually rendering frames" signal — the most
///   reliable first-frame proxy — and `playbackStarted()` is idempotent
///   (cancels the watchdog; schedules the 30 s health-ok once), so repeated
///   `.playing` transitions are harmless.
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
                    self?.controller.playbackFailed(code: "failed_to_play_to_end")
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
            controller.playbackFailed(code: "item_failed")
        }

        private func handleTimeControlStatus() {
            guard observedPlayer?.timeControlStatus == .playing else { return }
            controller.playbackStarted()
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
