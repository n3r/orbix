import AVFoundation
import AVKit
import OrbixKit
import SwiftUI

/// `UIViewControllerRepresentable` wrapping a stock `AVPlayerViewController`
/// — the production player (SP2 M3 Task 3), expanding the M1 spike's thin
/// wrapper. Still never constructs the `AVPlayer` or negotiates playback
/// itself — `PlayerScreen` below does that (via `PlaybackController`) and
/// hands this view a ready-to-play `AVPlayer` plus the resume position;
/// this type only presents it and wires the concerns a real player needs a
/// long-lived owner for:
///
/// - Seeking to the resume position once the item reaches `.readyToPlay`,
///   then explicitly calling `player.play()` — Apple's canonical tvOS
///   pattern — rather than relying on `AVPlayerViewController`'s implicit
///   autostart-on-ready behavior.
/// - A ~10s periodic progress report (+ one whenever the player pauses) via
///   `PlaybackController.reportProgress`.
/// - Tearing every observer down in `dismantleUIViewController` — no leaked
///   `AVPlayer` time observer (the M2-review follow-up) — and reporting a
///   final progress update + stopping the play session via
///   `PlaybackController.teardown`.
///
/// Native audio/subtitle track pickers need no code here at all: they come
/// for free from the in-manifest HLS renditions the server embeds for this
/// capability profile (`Capabilities.appleTV.subtitleDelivery == "hls"`) —
/// `AVPlayerViewController`'s stock transport UI reads those directly off
/// the asset's `AVMediaSelectionGroup`s.
struct PlayerViewController: UIViewControllerRepresentable {
    let player: AVPlayer
    let playbackController: PlaybackController
    let resumeSeconds: Double

    /// Shown via `AVPlayerItem.externalMetadata` so tvOS's transport/info UI
    /// displays a real title instead of the raw stream URL.
    var videoTitle: String?

    func makeCoordinator() -> Coordinator {
        Coordinator(playbackController: playbackController)
    }

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let controller = AVPlayerViewController()
        controller.player = player
        applyExternalMetadata(to: controller)
        context.coordinator.attach(to: player, resumeSeconds: resumeSeconds)
        return controller
    }

    func updateUIViewController(_ uiViewController: AVPlayerViewController, context: Context) {
        if uiViewController.player !== player {
            uiViewController.player = player
            context.coordinator.attach(to: player, resumeSeconds: resumeSeconds)
        }
        applyExternalMetadata(to: uiViewController)
    }

    /// Runs when SwiftUI removes this representable from the hierarchy
    /// (the player screen is dismissed) — the one teardown hook that's
    /// guaranteed to fire, so it's where every observer registered in
    /// `Coordinator.attach` gets removed. Static (per the protocol
    /// requirement) — `coordinator` is everything it needs.
    static func dismantleUIViewController(_ uiViewController: AVPlayerViewController, coordinator: Coordinator) {
        coordinator.teardown()
    }

    private func applyExternalMetadata(to controller: AVPlayerViewController) {
        guard let videoTitle, let item = controller.player?.currentItem else { return }
        let titleItem = AVMutableMetadataItem()
        titleItem.identifier = .commonIdentifierTitle
        titleItem.extendedLanguageTag = "und"
        titleItem.value = videoTitle as NSString
        item.externalMetadata = [titleItem]
    }

    /// Owns every observer this player screen registers against the
    /// `AVPlayer`/`AVPlayerItem` it's attached to: the periodic time
    /// observer, the pause-detecting rate observer, and the ready-to-play
    /// KVO status observer — and removes all three in `teardown()` (called
    /// from the static `dismantleUIViewController` above). This is the one
    /// piece of SP2 M3 Task 3 that must not leak: `AVPlayer` retains a
    /// periodic time observer's closure until `removeTimeObserver` is
    /// called, so a forgotten teardown here would leak the observer and,
    /// via its captures, this whole object graph for the life of the app.
    ///
    /// Holds `attachedPlayer` **weak**: the SwiftUI-side `PlayerScreen` (via
    /// its `@State` player) and `AVPlayerViewController.player` are the real
    /// owners of the `AVPlayer`, not this Coordinator, so there's no strong
    /// Coordinator → Player edge for the player's own retained closures to
    /// complete a cycle through. Each observer closure below additionally
    /// captures `self` only `weak`, as defense in depth in case `teardown()`
    /// is ever skipped (e.g. process termination) rather than relying
    /// solely on the guaranteed-in-practice dismantle call.
    @MainActor
    final class Coordinator {
        private let playbackController: PlaybackController
        private weak var attachedPlayer: AVPlayer?
        private var resumeSeconds: Double = 0
        private var didSeekToResume = false

        private var timeObserverToken: Any?
        private var rateObserverToken: NSObjectProtocol?
        private var statusObservation: NSKeyValueObservation?

        /// The brief's "every 10s" progress-heartbeat cadence.
        private static let progressReportInterval = CMTime(seconds: 10, preferredTimescale: 1)

        init(playbackController: PlaybackController) {
            self.playbackController = playbackController
        }

        /// Registers every observer this player screen needs against
        /// `player`. A no-op if already attached to this exact instance —
        /// `updateUIViewController` calls this on every SwiftUI update, not
        /// just the first, and re-registering the same observers twice
        /// would double every progress report.
        func attach(to player: AVPlayer, resumeSeconds: Double) {
            guard attachedPlayer !== player else { return }
            detachObservers()

            attachedPlayer = player
            self.resumeSeconds = resumeSeconds
            didSeekToResume = false

            if let item = player.currentItem {
                statusObservation = item.observe(\.status, options: [.new]) { [weak self] _, _ in
                    Task { @MainActor [weak self] in
                        self?.seekToResumeIfReady()
                    }
                }
            }

            timeObserverToken = player.addPeriodicTimeObserver(
                forInterval: Self.progressReportInterval,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor [weak self] in
                    self?.reportCurrentProgress()
                }
            }

            // AVPlayer.rate also drops to 0 on end-of-item/buffering, not
            // only a user-initiated pause; reporting on any of those is
            // harmless (just an extra, roughly-accurate PUT) and keeps this
            // simple rather than trying to distinguish the reason.
            rateObserverToken = NotificationCenter.default.addObserver(
                forName: AVPlayer.rateDidChangeNotification,
                object: player,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor [weak self] in
                    self?.reportProgressIfPaused()
                }
            }
        }

        /// Called once from the static `dismantleUIViewController`: removes
        /// every observer registered in `attach`, then hands the
        /// last-known position/duration to `PlaybackController.teardown`
        /// (final progress report + `stopPlayback`). `dismantleUIViewController`
        /// isn't `async`, so this fires the teardown work in a detached
        /// `Task` rather than awaiting it — `PlaybackController.teardown`
        /// itself chains through its progress-report queue, so the final
        /// report is never skipped or raced by an earlier in-flight one.
        func teardown() {
            let player = attachedPlayer
            let positionSec = player?.currentItem?.currentTime().seconds ?? 0
            let durationSec = player?.currentItem?.duration.seconds ?? 0
            detachObservers()
            attachedPlayer = nil

            let controller = playbackController
            let safePosition = positionSec.isFinite ? max(0, positionSec) : 0
            let safeDuration = durationSec.isFinite ? max(0, durationSec) : 0
            Task {
                await controller.teardown(positionSec: safePosition, durationSec: safeDuration)
            }
        }

        private func detachObservers() {
            if let timeObserverToken {
                attachedPlayer?.removeTimeObserver(timeObserverToken)
                self.timeObserverToken = nil
            }
            if let rateObserverToken {
                NotificationCenter.default.removeObserver(rateObserverToken)
                self.rateObserverToken = nil
            }
            statusObservation?.invalidate()
            statusObservation = nil
        }

        /// Runs at most once per `attach` — guarded by `didSeekToResume`,
        /// which is set `true` before either branch below, so a later KVO
        /// callback (e.g. a subsequent `.status` change) short-circuits at
        /// the guard above rather than re-seeking or re-triggering `play()`.
        /// Seeks to the saved resume position if there is one, then
        /// explicitly calls `player.play()` — Apple's canonical tvOS
        /// pattern — instead of depending on `AVPlayerViewController`'s
        /// implicit autostart. The resume seek uses the completion-handler
        /// overload so `play()` fires only once the seek has actually
        /// landed, avoiding a brief flash of the pre-seek frame.
        private func seekToResumeIfReady() {
            guard !didSeekToResume, let player = attachedPlayer, let item = player.currentItem, item.status == .readyToPlay else { return }
            didSeekToResume = true
            guard resumeSeconds > 0 else {
                player.play()
                return
            }
            let target = CMTime(seconds: resumeSeconds, preferredTimescale: 600)
            item.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero) { _ in
                player.play()
            }
        }

        private func reportProgressIfPaused() {
            guard let player = attachedPlayer, player.rate == 0 else { return }
            reportCurrentProgress()
        }

        private func reportCurrentProgress() {
            guard let item = attachedPlayer?.currentItem else { return }
            let positionSec = item.currentTime().seconds
            let durationSec = item.duration.seconds
            guard positionSec.isFinite, durationSec.isFinite, durationSec > 0 else { return }
            playbackController.reportProgress(positionSec: positionSec, durationSec: durationSec)
        }
    }
}

/// Presented full-screen from `TitlePage`'s Play button (`.fullScreenCover`):
/// negotiates playback via `PlaybackController`, then hosts the production
/// `PlayerViewController` once ready. Owns the `AVPlayer` instance for the
/// lifetime of this screen — `PlayerViewController` never constructs or
/// owns the player itself, only presents whatever it's given (the same M1
/// design principle, now extended to cover progress/stop as well as
/// playback).
struct PlayerScreen: View {
    let itemId: String
    let fileId: String
    let episodeId: String?
    let title: String
    let client: OrbixClient
    let baseURL: URL

    @State private var controller: PlaybackController
    @State private var player: AVPlayer?
    @Environment(\.dismiss) private var dismiss

    init(
        itemId: String,
        fileId: String,
        episodeId: String? = nil,
        title: String,
        client: OrbixClient,
        baseURL: URL
    ) {
        self.itemId = itemId
        self.fileId = fileId
        self.episodeId = episodeId
        self.title = title
        self.client = client
        self.baseURL = baseURL
        _controller = State(
            initialValue: PlaybackController(
                itemId: itemId,
                fileId: fileId,
                episodeId: episodeId,
                client: client,
                baseURL: baseURL
            )
        )
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            switch controller.loadState {
            case .loading:
                ProgressView("Loading…")
                    .font(.title3)
                    .tint(.white)
                    .foregroundStyle(.white)
            case .error(let message):
                errorView(message: message)
            case .ready(let streamURL, let resumeSeconds):
                if let player {
                    PlayerViewController(
                        player: player,
                        playbackController: controller,
                        resumeSeconds: resumeSeconds,
                        videoTitle: title
                    )
                    .ignoresSafeArea()
                    // Belt-and-suspenders alongside the identical modifier
                    // on the outer `ZStack` below: once playback is ready,
                    // `AVPlayerViewController`'s own view is what actually
                    // holds focus, so if its responder chain ever consumes
                    // the Menu press before it reaches an ancestor's
                    // `onExitCommand`, this closer copy still catches it.
                    // `dismiss()` is idempotent, so having both is harmless.
                    .onExitCommand { dismiss() }
                } else {
                    // One-frame gap before the `.task(id:)` below constructs
                    // the player — deliberately not built inline in this
                    // `switch` (which re-evaluates on every body pass and
                    // would construct a fresh, throwaway `AVPlayer` each
                    // time).
                    Color.clear
                        .task(id: streamURL) { player = AVPlayer(url: streamURL) }
                }
            }
        }
        .task { await controller.start() }
        // tvOS's `.fullScreenCover` does not auto-dismiss on a Menu press,
        // and the embedded (non-modally-presented) `AVPlayerViewController`
        // has no presenting view controller of its own to dismiss — so
        // without this, Menu suspends the app with the cover still up:
        // `PlayerViewController.dismantleUIViewController` never runs, and
        // the final progress PUT + `/stop` in `Coordinator.teardown()` never
        // fire (silent data loss, plus a stuck player on return to the app).
        // Calling `dismiss()` here collapses the cover, which *does*
        // guarantee `dismantleUIViewController` → `teardown()` runs.
        .onExitCommand { dismiss() }
        .accessibilityIdentifier("playerScreen")
    }

    private func errorView(message: String) -> some View {
        ContentUnavailableView {
            Label("Couldn't play title", systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            Button("Close") { dismiss() }
                .accessibilityIdentifier("playerScreenCloseButton")
        }
        .foregroundStyle(.white)
        .accessibilityIdentifier("playerScreenErrorState")
    }
}
