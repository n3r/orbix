import AVFoundation
import Foundation
import XCTest
@testable import OrbixKit

/// SP2 M1 automated gate: for each `fileId:expectedMode` pair configured
/// via env, negotiates `playbackInfo` against a live Orbix server and
/// proves AVFoundation itself accepts the resulting HLS manifest — i.e.
/// this is the thing "does it play in the simulator/on hardware" ultimately
/// reduces to, made assertable outside manual UI driving.
///
/// Reads three env vars:
/// - `ORBIX_TEST_BASE_URL` — e.g. `http://127.0.0.1:2062`
/// - `ORBIX_TEST_TOKEN` — a device bearer token minted via the pairing API
/// - `ORBIX_TEST_FILE_IDS` — comma-separated `fileId:expectedMode` pairs,
///   e.g. `f_direct:direct,f_remux:remux,f_hevc:remux`
///
/// If any is unset, the test `XCTSkip`s (not fails), so a normal
/// `xcodebuild ... -scheme OrbixKit ... test` run (no env configured) still
/// passes — this file only actually exercises the network when the
/// controller's live-gate harness sets the env.
final class PlaybackReadinessTests: XCTestCase {
    private struct Fixture {
        let fileId: String
        let expectedMode: String
    }

    private enum FixtureParseError: Error, CustomStringConvertible {
        case malformed(String)

        var description: String {
            switch self {
            case .malformed(let raw):
                return "Malformed ORBIX_TEST_FILE_IDS entry (expected 'fileId:expectedMode'): \(raw)"
            }
        }
    }

    func testFixturesReachReadyToPlay() async throws {
        let env = ProcessInfo.processInfo.environment

        guard let baseURLString = env["ORBIX_TEST_BASE_URL"], !baseURLString.isEmpty else {
            throw XCTSkip("ORBIX_TEST_BASE_URL not set — skipping live playback-readiness gate")
        }
        guard let token = env["ORBIX_TEST_TOKEN"], !token.isEmpty else {
            throw XCTSkip("ORBIX_TEST_TOKEN not set — skipping live playback-readiness gate")
        }
        guard let rawFixtures = env["ORBIX_TEST_FILE_IDS"], !rawFixtures.isEmpty else {
            throw XCTSkip("ORBIX_TEST_FILE_IDS not set — skipping live playback-readiness gate")
        }
        guard let baseURL = URL(string: baseURLString) else {
            XCTFail("ORBIX_TEST_BASE_URL is not a valid URL: \(baseURLString)")
            return
        }

        let fixtures = try parseFixtures(rawFixtures)
        XCTAssertFalse(fixtures.isEmpty, "ORBIX_TEST_FILE_IDS parsed to zero fixtures: \(rawFixtures)")

        let client = OrbixClient(baseURL: baseURL, token: token)

        for fixture in fixtures {
            await verify(fixture: fixture, client: client, baseURL: baseURL)
        }
    }

    /// One fixture's full round trip: negotiate → assert mode → resolve
    /// the absolute stream URL → assert the resulting `AVPlayerItem`
    /// reaches `.readyToPlay`. Failures are reported via `XCTFail` rather
    /// than thrown, so one bad fixture doesn't abort the remaining ones —
    /// a single run reports the full fixture matrix, not just the first
    /// failure.
    private func verify(fixture: Fixture, client: OrbixClient, baseURL: URL) async {
        let info: PlaybackInfo
        do {
            info = try await client.playbackInfo(fileId: fixture.fileId, capabilities: .appleTV)
        } catch {
            XCTFail("fileId \(fixture.fileId): playbackInfo request failed: \(error)")
            return
        }

        XCTAssertEqual(
            info.mode,
            fixture.expectedMode,
            "fileId \(fixture.fileId): expected mode '\(fixture.expectedMode)', got '\(info.mode)'"
        )

        guard let streamURL = URL(string: info.streamUrl, relativeTo: baseURL)?.absoluteURL else {
            XCTFail("fileId \(fixture.fileId): could not resolve streamUrl '\(info.streamUrl)' against \(baseURL)")
            return
        }

        // AVURLAsset + AVPlayerItem, exactly what SpikeListView hands to
        // PlayerViewController — this is what actually proves Apple's HLS
        // stack accepts our playlist, not just that the HTTP request for
        // playbackInfo succeeded.
        let asset = AVURLAsset(url: streamURL)
        let item = AVPlayerItem(asset: asset)
        // AVPlayerItem.status only advances once the item is attached to an
        // AVPlayer that drives the asset load — exactly what AVPlayer(url:) does
        // inside SpikeListView. Without a player, status stays .unknown forever.
        let player = AVPlayer(playerItem: item)
        player.isMuted = true

        let status = await waitForTerminalStatus(of: item, timeout: 20)
        // Reference the player after the await so it isn't deallocated mid-wait.
        player.pause()
        switch status {
        case .readyToPlay:
            break
        case .failed:
            let errorDescription = item.error.map(String.init(describing:)) ?? "<nil>"
            let logDescription = item.errorLog().map(String.init(describing:)) ?? "<no error log>"
            XCTFail(
                """
                fileId \(fixture.fileId) (\(streamURL)): AVPlayerItem failed.
                error: \(errorDescription)
                errorLog: \(logDescription)
                """
            )
        case .unknown:
            XCTFail("fileId \(fixture.fileId) (\(streamURL)): AVPlayerItem did not become ready within 20s (status still .unknown)")
        @unknown default:
            XCTFail("fileId \(fixture.fileId) (\(streamURL)): unexpected AVPlayerItem.status \(status)")
        }
    }

    /// Polls `item.status` on a fixed cadence until it reaches a terminal
    /// state (`.readyToPlay` / `.failed`) or `timeout` elapses. Plain
    /// async/await polling rather than a KVO/continuation bridge — simpler
    /// to reason about under Swift 6 strict concurrency, and explicitly
    /// sanctioned as an equally valid approach by the M1 spec.
    private func waitForTerminalStatus(of item: AVPlayerItem, timeout: TimeInterval) async -> AVPlayerItem.Status {
        let pollInterval: UInt64 = 200_000_000 // 200ms
        let deadline = Date().addingTimeInterval(timeout)

        while Date() < deadline {
            let status = item.status
            if status == .readyToPlay || status == .failed {
                return status
            }
            try? await Task.sleep(nanoseconds: pollInterval)
        }
        return item.status
    }

    private func parseFixtures(_ raw: String) throws -> [Fixture] {
        try raw
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .map { pair in
                let parts = pair.split(separator: ":", maxSplits: 1)
                guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty else {
                    throw FixtureParseError.malformed(pair)
                }
                return Fixture(fileId: String(parts[0]), expectedMode: String(parts[1]))
            }
    }
}
