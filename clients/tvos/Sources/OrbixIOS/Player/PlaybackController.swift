import Foundation
import Observation
import OrbixKit

@MainActor
@Observable
final class PlaybackController {
    struct TrackMetadata: Equatable {
        var audioTracks: [AudioTrack]
        var subtitleTracks: [SubtitleTrack]

        var hasTracks: Bool {
            !audioTracks.isEmpty || !subtitleTracks.isEmpty
        }
    }

    enum LoadState: Equatable {
        case loading
        case error(String)
        case ready(streamURL: URL, resumeSeconds: Double, tracks: TrackMetadata)
    }

    let itemId: String
    let fileId: String
    let episodeId: String?

    private(set) var loadState: LoadState = .loading

    private let client: OrbixClient
    private let baseURL: URL
    private var playSessionId: String?
    private var reportChain: Task<Void, Never>?

    var currentTracks: TrackMetadata {
        if case .ready(_, _, let tracks) = loadState {
            return tracks
        }
        return TrackMetadata(audioTracks: [], subtitleTracks: [])
    }

    init(itemId: String, fileId: String, episodeId: String? = nil, client: OrbixClient, baseURL: URL) {
        self.itemId = itemId
        self.fileId = fileId
        self.episodeId = episodeId
        self.client = client
        self.baseURL = baseURL
    }

    func start() async {
        loadState = .loading

        let progress = try? await client.getProgress(itemId: itemId, episodeId: episodeId)

        do {
            let info = try await client.playbackInfo(fileId: fileId, capabilities: .appleMobile)
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
            loadState = .ready(
                streamURL: streamURL,
                resumeSeconds: resumeSeconds,
                tracks: TrackMetadata(audioTracks: info.audioTracks, subtitleTracks: info.subtitleTracks)
            )
        } catch {
            loadState = .error("Couldn't start playback: \(error)")
        }
    }

    func reportProgress(positionSec: Double, durationSec: Double) {
        enqueueReport(positionSec: positionSec, durationSec: durationSec)
    }

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
