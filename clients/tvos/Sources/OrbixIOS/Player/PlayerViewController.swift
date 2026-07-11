import AVFoundation
import AVKit
import OrbixKit
import SwiftUI

struct PlayerViewController: UIViewControllerRepresentable {
    let player: AVPlayer
    let playbackController: PlaybackController
    let resumeSeconds: Double
    var videoTitle: String?

    func makeCoordinator() -> Coordinator {
        Coordinator(playbackController: playbackController)
    }

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let controller = AVPlayerViewController()
        controller.player = player
        controller.allowsPictureInPicturePlayback = true
        controller.entersFullScreenWhenPlaybackBegins = false
        controller.exitsFullScreenWhenPlaybackEnds = false
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

    @MainActor
    final class Coordinator {
        private let playbackController: PlaybackController
        private weak var attachedPlayer: AVPlayer?
        private var resumeSeconds: Double = 0
        private var didSeekToResume = false

        private var timeObserverToken: Any?
        private var rateObserverToken: NSObjectProtocol?
        private var statusObservation: NSKeyValueObservation?

        private static let progressReportInterval = CMTime(seconds: 10, preferredTimescale: 1)

        init(playbackController: PlaybackController) {
            self.playbackController = playbackController
        }

        func attach(to player: AVPlayer, resumeSeconds: Double) {
            guard attachedPlayer !== player else { return }
            detachObservers()

            attachedPlayer = player
            self.resumeSeconds = resumeSeconds
            didSeekToResume = false

            if let item = player.currentItem {
                statusObservation = item.observe(\.status, options: [.initial, .new]) { [weak self] _, _ in
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

        private func seekToResumeIfReady() {
            guard !didSeekToResume, let player = attachedPlayer, let item = player.currentItem, item.status == .readyToPlay else { return }
            didSeekToResume = true
            let targetSeconds = clampedResumeSeconds(for: item)
            guard targetSeconds > 0 else {
                player.play()
                return
            }
            let target = CMTime(seconds: targetSeconds, preferredTimescale: 600)
            item.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero) { _ in
                player.play()
            }
        }

        private func clampedResumeSeconds(for item: AVPlayerItem) -> Double {
            guard resumeSeconds > 0 else { return 0 }
            let durationSeconds = item.duration.seconds
            guard durationSeconds.isFinite, durationSeconds > 0 else { return resumeSeconds }
            guard resumeSeconds < durationSeconds - 5 else { return 0 }
            return max(0, resumeSeconds)
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

struct PlayerScreen: View {
    let itemId: String
    let fileId: String
    let episodeId: String?
    let title: String
    let client: OrbixClient
    let baseURL: URL

    @State private var controller: PlaybackController
    @State private var player: AVPlayer?
    @State private var showingTrackPanel = false
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
        ZStack(alignment: .topLeading) {
            Color.black.ignoresSafeArea()

            switch controller.loadState {
            case .loading:
                ProgressView("Loading")
                    .tint(.white)
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .error(let message):
                errorView(message: message)
            case .ready(let streamURL, let resumeSeconds, let tracks):
                if let player {
                    PlayerViewController(
                        player: player,
                        playbackController: controller,
                        resumeSeconds: resumeSeconds,
                        videoTitle: title
                    )
                    .ignoresSafeArea()
                } else {
                    Color.clear
                        .task(id: streamURL) { player = AVPlayer(url: streamURL) }
                }

                if showingTrackPanel {
                    trackPanel(tracks)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                        .zIndex(3)
                }
            }

            HStack(alignment: .top, spacing: 12) {
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.headline)
                        .frame(width: 38, height: 38)
                        .background(.black.opacity(0.6), in: Circle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(.white)
                .accessibilityLabel("Close Player")
                .accessibilityIdentifier("player-close-button")

                Text(title)
                    .font(.subheadline.bold())
                    .lineLimit(1)
                    .padding(.horizontal, 12)
                    .frame(height: 38)
                    .background(.black.opacity(0.58), in: Capsule())
                    .accessibilityIdentifier("player-title")

                Spacer(minLength: 0)

                if controller.currentTracks.hasTracks {
                    Button {
                        withAnimation(.easeInOut(duration: 0.18)) {
                            showingTrackPanel.toggle()
                        }
                    } label: {
                        Image(systemName: "captions.bubble")
                            .font(.headline)
                            .frame(width: 38, height: 38)
                            .background(.black.opacity(0.6), in: Circle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.white)
                    .accessibilityLabel("Audio and Subtitles")
                    .accessibilityIdentifier("player-track-button")
                }
            }
            .foregroundStyle(.white)
            .padding(.top, 18)
            .padding(.horizontal, 16)
            .zIndex(2)
        }
        .task { await controller.start() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("player-screen")
    }

    private func trackPanel(_ tracks: PlaybackController.TrackMetadata) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Text("Audio & Subtitles")
                    .font(.headline)
                    .accessibilityIdentifier("track-panel-title")

                Spacer()

                Button {
                    withAnimation(.easeInOut(duration: 0.18)) {
                        showingTrackPanel = false
                    }
                } label: {
                    Image(systemName: "xmark")
                        .font(.subheadline.bold())
                        .frame(width: 32, height: 32)
                        .background(.white.opacity(0.12), in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close Track Options")
                .accessibilityIdentifier("track-panel-close-button")
            }

            if !tracks.audioTracks.isEmpty {
                trackSection(
                    title: "Audio",
                    rows: tracks.audioTracks.map(Self.audioTrackTitle),
                    identifierPrefix: "audio-track"
                )
            }

            if !tracks.subtitleTracks.isEmpty {
                trackSection(
                    title: "Subtitles",
                    rows: tracks.subtitleTracks.map(Self.subtitleTrackTitle),
                    identifierPrefix: "subtitle-track"
                )
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.black.opacity(0.88), in: RoundedRectangle(cornerRadius: 10))
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .stroke(.white.opacity(0.14), lineWidth: 1)
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 16)
        .padding(.bottom, 34)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
    }

    private func trackSection(title: String, rows: [String], identifierPrefix: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.subheadline.bold())
                .foregroundStyle(.secondary)

            ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                Text(row)
                    .font(.callout.weight(.medium))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .frame(height: 38)
                    .background(.white.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
                    .accessibilityIdentifier("\(identifierPrefix)-\(index)")
            }
        }
    }

    private static func audioTrackTitle(_ track: AudioTrack) -> String {
        var parts: [String] = []
        parts.append(languageName(track.language))
        if let channels = track.channels, channels > 0 {
            parts.append(channels == 1 ? "Mono" : "\(channels)ch")
        }
        if let codec = track.codec, !codec.isEmpty {
            parts.append(codec.uppercased())
        }
        if track.selected {
            parts.append("Selected")
        }
        return parts.joined(separator: "  ")
    }

    private static func subtitleTrackTitle(_ track: SubtitleTrack) -> String {
        var parts = [languageName(track.language)]
        if let codec = track.codec, !codec.isEmpty {
            parts.append(codec.uppercased())
        }
        if !track.available {
            parts.append(track.reason?.isEmpty == false ? track.reason! : "Unavailable")
        }
        return parts.joined(separator: "  ")
    }

    private static func languageName(_ code: String?) -> String {
        guard let code, !code.isEmpty else { return "Unknown" }
        return Locale.current.localizedString(forLanguageCode: code) ?? code.uppercased()
    }

    private func errorView(message: String) -> some View {
        ContentUnavailableView {
            Label("Couldn't play title", systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            Button("Close") { dismiss() }
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
