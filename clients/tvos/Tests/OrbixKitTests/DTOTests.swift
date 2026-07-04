import XCTest
@testable import OrbixKit

final class DTOTests: XCTestCase {
    func testDecodePlaybackInfoRemux() throws {
        let json = """
        {"playSessionId":"s1","mode":"remux","streamUrl":"/api/play/f1/master.m3u8?playSessionId=s1&token=orb_x",
         "container":"matroska,webm","videoCodec":"h264",
         "audioTracks":[{"index":0,"codec":"ac3","channels":6,"language":"ru","selected":true}],
         "subtitleTracks":[{"index":2,"codec":"subrip","language":"en","available":true},
                            {"index":3,"codec":"hdmv_pgs_subtitle","language":"ru","available":false,"reason":"image_based"}]}
        """.data(using: .utf8)!
        let info = try JSONDecoder().decode(PlaybackInfo.self, from: json)
        XCTAssertEqual(info.mode, "remux")
        XCTAssertTrue(info.streamUrl.contains("token=orb_x"))
        XCTAssertEqual(info.audioTracks.first?.channels, 6)
        XCTAssertEqual(info.subtitleTracks.filter { $0.available }.count, 1)
        XCTAssertEqual(info.subtitleTracks.first { !$0.available }?.reason, "image_based")
        XCTAssertEqual(info.container, "matroska,webm")
        XCTAssertEqual(info.videoCodec, "h264")
        XCTAssertEqual(info.playSessionId, "s1")
    }

    func testDecodePlaybackInfoDirectWithNullContainerAndEmptyTracks() throws {
        // A "direct" plan can still report null container/codec (unprobed
        // fields) and empty track arrays; every field but the required ones
        // must tolerate that.
        let json = """
        {"playSessionId":"s2","mode":"direct","streamUrl":"/api/play/f2/direct",
         "container":null,"videoCodec":null,"audioTracks":[],"subtitleTracks":[]}
        """.data(using: .utf8)!
        let info = try JSONDecoder().decode(PlaybackInfo.self, from: json)
        XCTAssertEqual(info.mode, "direct")
        XCTAssertNil(info.container)
        XCTAssertNil(info.videoCodec)
        XCTAssertTrue(info.audioTracks.isEmpty)
        XCTAssertTrue(info.subtitleTracks.isEmpty)
    }

    func testAppleCapabilityProfile() {
        XCTAssertEqual(Capabilities.appleTV.subtitleDelivery, "hls")
        XCTAssertTrue(Capabilities.appleTV.videoCodecs.contains("hevc"))
        XCTAssertEqual(Capabilities.appleTV.maxAudioChannels, 6)
        XCTAssertEqual(Capabilities.appleTV.containers, ["mp4"])
        XCTAssertEqual(Capabilities.appleTV.audioCodecs, ["aac", "ac3", "eac3", "flac"])
    }

    func testEncodeCapabilitiesRoundTrip() throws {
        // PlaybackInfoRequest.capabilities is what actually goes over the
        // wire to POST /api/playback/info, so the encode direction matters
        // too, not just decode.
        let data = try JSONEncoder().encode(Capabilities.appleTV)
        let decoded = try JSONDecoder().decode(Capabilities.self, from: data)
        XCTAssertEqual(decoded, Capabilities.appleTV)
    }

    func testDecodePairPollApproved() throws {
        let json = """
        {"status":"approved","deviceToken":"orb_abc123","deviceId":"dev_1"}
        """.data(using: .utf8)!
        let response = try JSONDecoder().decode(PairPollResponse.self, from: json)
        guard case let .approved(deviceToken, deviceId) = response else {
            return XCTFail("expected .approved, got \(response)")
        }
        XCTAssertEqual(deviceToken, "orb_abc123")
        XCTAssertEqual(deviceId, "dev_1")
    }

    func testDecodePairPollPending() throws {
        let json = """
        {"status":"pending"}
        """.data(using: .utf8)!
        let response = try JSONDecoder().decode(PairPollResponse.self, from: json)
        XCTAssertEqual(response, .pending)
    }

    func testDecodePairInitiateResponse() throws {
        let json = """
        {"code":"AB12CD","pollToken":"tok_xyz","expiresInSec":300}
        """.data(using: .utf8)!
        let response = try JSONDecoder().decode(PairInitiateResponse.self, from: json)
        XCTAssertEqual(response.code, "AB12CD")
        XCTAssertEqual(response.pollToken, "tok_xyz")
        XCTAssertEqual(response.expiresInSec, 300)
    }

    func testDecodeHomeRowsIgnoresAddedAt() throws {
        // The server's home-row cards carry `addedAt`, which MediaCard still
        // deliberately ignores (nothing in the app needs it yet); every
        // other field on this fixture — backdropPath, progress, resume:null
        // — is now modeled and must decode too (M3 Task 1).
        let json = """
        {"rows":[{"key":"continue-watching","title":"Continue Watching","items":[
          {"id":"m1","title":"Arrival","year":2016,"posterPath":"/p1.jpg",
           "backdropPath":"/b1.jpg","addedAt":"2026-01-01T00:00:00.000Z",
           "progress":{"positionSec":120,"durationSec":9000},"resume":null}
        ]}]}
        """.data(using: .utf8)!
        let rows = try JSONDecoder().decode(HomeRows.self, from: json)
        XCTAssertEqual(rows.rows.count, 1)
        XCTAssertEqual(rows.rows.first?.key, "continue-watching")
        let card = try XCTUnwrap(rows.rows.first?.items.first)
        XCTAssertEqual(card.id, "m1")
        XCTAssertEqual(card.year, 2016)
        XCTAssertEqual(card.posterPath, "/p1.jpg")
        XCTAssertEqual(card.backdropPath, "/b1.jpg")
        XCTAssertEqual(card.progress, MediaCard.Progress(positionSec: 120, durationSec: 9000))
        XCTAssertNil(card.resume)
    }

    func testDecodeHomeRowsItemWithProgressAndResume() throws {
        // A series continue-watching card: `progress` is the episode's
        // playback position; `resume` carries the season/episode/title the
        // server resolved from that state's `episodeId` (see `epById`/`ep`
        // in `apps/api/src/routes/discovery.ts`). `episodeTitle` can itself
        // be null (an episode with no title), so this fixture exercises
        // that too rather than always supplying one.
        let json = """
        {"rows":[{"key":"continue-watching","title":"Continue Watching","items":[
          {"id":"s1","title":"Some Series","year":2020,"posterPath":"/p2.jpg",
           "backdropPath":"/b2.jpg","addedAt":"2026-01-01T00:00:00.000Z",
           "progress":{"positionSec":300,"durationSec":1500},
           "resume":{"seasonNumber":1,"episodeNumber":3,"episodeTitle":null}}
        ]}]}
        """.data(using: .utf8)!
        let rows = try JSONDecoder().decode(HomeRows.self, from: json)
        let card = try XCTUnwrap(rows.rows.first?.items.first)
        XCTAssertEqual(card.backdropPath, "/b2.jpg")
        XCTAssertEqual(card.progress, MediaCard.Progress(positionSec: 300, durationSec: 1500))
        let resume = try XCTUnwrap(card.resume)
        XCTAssertEqual(resume.seasonNumber, 1)
        XCTAssertEqual(resume.episodeNumber, 3)
        XCTAssertNil(resume.episodeTitle)
    }

    func testDecodeProfile() throws {
        let json = """
        {"id":"p1","name":"Kids","avatar":null,"kind":"kids","maturityCap":8,"language":"en"}
        """.data(using: .utf8)!
        let profile = try JSONDecoder().decode(Profile.self, from: json)
        XCTAssertEqual(profile.id, "p1")
        XCTAssertEqual(profile.name, "Kids")
        XCTAssertEqual(profile.kind, "kids")
        XCTAssertEqual(profile.maturityCap, 8)
        XCTAssertEqual(profile.language, "en")
        XCTAssertNil(profile.avatar)
    }

    func testDecodeMeProfileWithActiveProfile() throws {
        let json = """
        {"id":"p1","name":"Alex","avatar":null,"kind":"kids","maturityCap":1,"language":"en"}
        """.data(using: .utf8)!
        let me = try JSONDecoder().decode(MeProfile.self, from: json)
        XCTAssertEqual(me.id, "p1")
        XCTAssertEqual(me.name, "Alex")
        XCTAssertEqual(me.kind, "kids")
        XCTAssertEqual(me.maturityCap, 1)
    }

    func testDecodeMeProfileAllNullWhenNoneSelected() throws {
        // The exact all-null shape apps/api/src/routes/profiles.ts sends
        // when no orbix_profile cookie / device activeProfileId is set —
        // must decode cleanly (not throw), with id == nil driving
        // AppModel's .needsProfile branch.
        let json = """
        {"id":null,"name":null,"avatar":null,"kind":null,"maturityCap":null}
        """.data(using: .utf8)!
        let me = try JSONDecoder().decode(MeProfile.self, from: json)
        XCTAssertNil(me.id)
        XCTAssertNil(me.name)
        XCTAssertNil(me.kind)
        XCTAssertNil(me.maturityCap)
    }
}
