import AVFoundation
import Foundation
import XCTest
@testable import OrbixKit

/// SP2 M3 Task 3 integration gate: exercises `OrbixClient`'s
/// progress-reporting + stop methods against a live server — the piece
/// `PlaybackReadinessTests` (SP2 M1) doesn't cover, since that gate stops at
/// "the manifest is playable," not "progress round-trips." This drives an
/// `AVPlayer` to `.readyToPlay` (the same negotiation proof as that gate)
/// and then calls `putProgress`/`getProgress`/`stopPlayback` directly — no
/// `PlaybackController`/`PlayerViewController`/UI involved, since those are
/// exercised by the controller's live playback smoke (screenshot +
/// server-side progress-row verification), which this file does not
/// attempt to replace.
///
/// Reads the same three env vars as `PlaybackReadinessTests` (mirrors its
/// gating exactly):
/// - `ORBIX_TEST_BASE_URL` — e.g. `http://127.0.0.1:2062`
/// - `ORBIX_TEST_TOKEN` — a device bearer token minted via the pairing API
/// - `ORBIX_TEST_FILE_IDS` — comma-separated `fileId:expectedMode` pairs;
///   only the *first* fixture's `fileId` is used here — this test isn't
///   about per-mode coverage, `PlaybackReadinessTests` already owns that.
///
/// If any is unset, the test `XCTSkip`s (not fails), so a normal
/// `xcodebuild ... -scheme OrbixKit ... test` run stays green with no env
/// configured.
final class PlaybackProgressTests: XCTestCase {
    private enum FixtureParseError: Error, CustomStringConvertible {
        case malformed(String)

        var description: String {
            switch self {
            case .malformed(let raw):
                return "Malformed ORBIX_TEST_FILE_IDS entry (expected 'fileId:expectedMode'): \(raw)"
            }
        }
    }

    func testProgressAndStopRoundTrip() async throws {
        let env = ProcessInfo.processInfo.environment

        guard let baseURLString = env["ORBIX_TEST_BASE_URL"], !baseURLString.isEmpty else {
            throw XCTSkip("ORBIX_TEST_BASE_URL not set — skipping live playback-progress gate")
        }
        guard let token = env["ORBIX_TEST_TOKEN"], !token.isEmpty else {
            throw XCTSkip("ORBIX_TEST_TOKEN not set — skipping live playback-progress gate")
        }
        guard let rawFixtures = env["ORBIX_TEST_FILE_IDS"], !rawFixtures.isEmpty else {
            throw XCTSkip("ORBIX_TEST_FILE_IDS not set — skipping live playback-progress gate")
        }
        guard let baseURL = URL(string: baseURLString) else {
            XCTFail("ORBIX_TEST_BASE_URL is not a valid URL: \(baseURLString)")
            return
        }

        let fileId = try firstFileId(from: rawFixtures)
        let client = OrbixClient(baseURL: baseURL, token: token)

        // 1) Negotiate, and prove the manifest is actually playable (same
        // AVPlayer-driven readiness proof PlaybackReadinessTests uses) —
        // a progress report is only meaningful once we know the file plays.
        let info = try await client.playbackInfo(fileId: fileId, capabilities: .appleTV)
        guard let streamURL = URL(string: info.streamUrl, relativeTo: baseURL)?.absoluteURL else {
            XCTFail("fileId \(fileId): could not resolve streamUrl '\(info.streamUrl)' against \(baseURL)")
            return
        }

        let asset = AVURLAsset(url: streamURL)
        let item = AVPlayerItem(asset: asset)
        let player = AVPlayer(playerItem: item)
        player.isMuted = true
        let status = await waitForTerminalStatus(of: item, timeout: 20)
        player.pause()
        guard status == .readyToPlay else {
            let errorDescription = item.error.map(String.init(describing:)) ?? "<nil>"
            XCTFail("fileId \(fileId) (\(streamURL)): AVPlayerItem did not reach .readyToPlay (status \(status), error: \(errorDescription))")
            return
        }

        // 2) PUT a progress update directly via OrbixClient — no player
        // driving the position; this exercises the client method's wire
        // format against the real route, per the brief.
        //
        // Uses a synthetic, test-scoped itemId rather than the fixture's
        // *real* owning MediaItem (which this test has no way to look up
        // from a bare fileId, and deliberately doesn't try to):
        // `PlaybackState.mediaItemId` is a plain, unconstrained `String`
        // column (see packages/db/prisma/schema.prisma — no `@relation` to
        // MediaItem), so the server places no referential-integrity
        // requirement on it. Keying off a test-specific id instead of the
        // real item id also means this run can never clobber or pollute
        // another suite's/smoke's continue-watching state for that title.
        let itemId = "playback-progress-test-\(fileId)"
        let positionSec = 42.0
        let durationSec = 100.0

        try await client.putProgress(
            itemId: itemId,
            positionSec: positionSec,
            durationSec: durationSec,
            episodeId: nil,
            playSessionId: info.playSessionId
        )

        let progress = try await client.getProgress(itemId: itemId, episodeId: nil)
        XCTAssertEqual(progress.positionSec, 42, "expected the PUT position to read back (the server floors fractional seconds)")
        XCTAssertEqual(progress.durationSec, 100)
        XCTAssertFalse(progress.finished, "42/100 is well under the 90% isFinished threshold")

        // 3) stopPlayback is best-effort by design (`async`, not `async
        // throws` — see OrbixClient.stopPlayback's doc comment): simply
        // completing without hanging or crashing is the assertion here.
        await client.stopPlayback(playSessionId: info.playSessionId)
    }

    /// Parses the same `fileId:expectedMode,...` format
    /// `PlaybackReadinessTests` does, returning only the first entry's
    /// `fileId` (this test doesn't care about mode).
    private func firstFileId(from raw: String) throws -> String {
        guard let pair = raw
            .split(separator: ",")
            .map({ $0.trimmingCharacters(in: .whitespaces) })
            .first(where: { !$0.isEmpty })
        else {
            throw FixtureParseError.malformed(raw)
        }
        let parts = pair.split(separator: ":", maxSplits: 1)
        guard let fileId = parts.first, !fileId.isEmpty else {
            throw FixtureParseError.malformed(pair)
        }
        return String(fileId)
    }

    /// Same polling helper as `PlaybackReadinessTests` (plain async/await
    /// polling, deliberately not KVO/continuation-bridged — see that file's
    /// doc comment for why); duplicated rather than shared since both are
    /// small, self-contained test-only helpers and neither file imports the
    /// other.
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
}
