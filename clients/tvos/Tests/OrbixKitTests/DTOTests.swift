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

    // MARK: - Item detail (M3 Task 2)

    func testDecodeItemDetailMovie() throws {
        // A representative movie GET /api/items/:id response (see
        // apps/api/src/routes/catalog.ts): no "seasons" key at all (only
        // spread in for kind == "series"), a populated cast/director, and a
        // "best copy first" files array the title page's Play button reads
        // files[0] from.
        let json = """
        {"id":"m1","kind":"movie","title":"Arrival","year":2016,
         "overview":"A linguist works with the military to communicate with alien visitors.",
         "tagline":"Why are they here?","status":null,"runtimeSec":6600,"rating":"PG-13",
         "posterPath":"/p1.jpg","backdropPath":"/b1.jpg","logoPath":"/l1.png",
         "tmdbScore":7.9,"imdbRating":7.9,"imdbVotes":700000,"rtRating":94,"metacritic":81,
         "matchState":"matched",
         "genres":["Drama","Science Fiction"],
         "cast":[{"name":"Amy Adams","character":"Louise Banks"},
                 {"name":"Jeremy Renner","character":"Ian Donnelly"}],
         "director":{"name":"Denis Villeneuve"},
         "files":[{"id":"f1","path":"/data/Arrival.mkv","container":"matroska,webm",
                   "videoCodec":"h264","audioCodecs":["ac3"],"width":1920,"height":1080,
                   "durationSec":6600,"size":"8589934592"}]}
        """.data(using: .utf8)!
        let detail = try JSONDecoder().decode(ItemDetail.self, from: json)
        XCTAssertEqual(detail.id, "m1")
        XCTAssertEqual(detail.kind, "movie")
        XCTAssertEqual(detail.title, "Arrival")
        XCTAssertEqual(detail.year, 2016)
        XCTAssertEqual(detail.runtimeSec, 6600)
        XCTAssertEqual(detail.rating, "PG-13")
        XCTAssertEqual(detail.backdropPath, "/b1.jpg")
        XCTAssertEqual(detail.logoPath, "/l1.png")
        XCTAssertEqual(detail.genres, ["Drama", "Science Fiction"])
        XCTAssertEqual(detail.cast?.count, 2)
        XCTAssertEqual(detail.cast?.first?.name, "Amy Adams")
        XCTAssertEqual(detail.cast?.first?.character, "Louise Banks")
        XCTAssertEqual(detail.director?.name, "Denis Villeneuve")
        XCTAssertNil(detail.seasons)
        XCTAssertEqual(detail.files?.first?.id, "f1")
    }

    func testDecodeItemDetailSeries() throws {
        // A series response: "seasons" is present (only true for
        // kind == "series"); a null season name and a null director must
        // both decode to nil, not throw. "files" is an empty array here —
        // deliberately not asserted as "always empty for a series" (see
        // ItemDetail.files' doc comment: the underlying relation isn't
        // filtered by episode in the route, so this can't be assumed).
        let json = """
        {"id":"s1","kind":"series","title":"Some Series","year":2020,
         "overview":"A prestige drama.","tagline":null,"status":"Ended",
         "runtimeSec":null,"rating":"TV-14",
         "posterPath":"/p2.jpg","backdropPath":"/b2.jpg","logoPath":null,
         "tmdbScore":8.1,"imdbRating":null,"imdbVotes":null,"rtRating":null,"metacritic":null,
         "matchState":"matched",
         "genres":["Drama"],
         "seasons":[{"seasonNumber":1,"name":"Season 1","episodeCount":8,"posterPath":"/sp1.jpg"},
                    {"seasonNumber":2,"name":null,"episodeCount":6,"posterPath":null}],
         "cast":[{"name":"Actor One","character":"Role One"}],
         "director":null,
         "files":[]}
        """.data(using: .utf8)!
        let detail = try JSONDecoder().decode(ItemDetail.self, from: json)
        XCTAssertEqual(detail.kind, "series")
        XCTAssertNil(detail.runtimeSec)
        XCTAssertNil(detail.director)
        XCTAssertEqual(detail.seasons?.count, 2)
        XCTAssertEqual(detail.seasons?.first?.seasonNumber, 1)
        XCTAssertEqual(detail.seasons?.first?.name, "Season 1")
        XCTAssertEqual(detail.seasons?.first?.episodeCount, 8)
        XCTAssertNil(detail.seasons?.last?.name)
        XCTAssertEqual(detail.files, [])
    }

    func testDecodeItemDetailToleratesMissingOptionalFields() throws {
        // Only the three truly-required fields present — every other key
        // entirely absent (not even null). Must decode cleanly: this is
        // the "server can omit optional fields" contract ItemDetail's doc
        // comment claims, exercised for real rather than just asserted.
        let json = """
        {"id":"m2","kind":"movie","title":"Untitled Import"}
        """.data(using: .utf8)!
        let detail = try JSONDecoder().decode(ItemDetail.self, from: json)
        XCTAssertEqual(detail.id, "m2")
        XCTAssertEqual(detail.title, "Untitled Import")
        XCTAssertNil(detail.year)
        XCTAssertNil(detail.overview)
        XCTAssertNil(detail.rating)
        XCTAssertNil(detail.genres)
        XCTAssertNil(detail.cast)
        XCTAssertNil(detail.director)
        XCTAssertNil(detail.seasons)
        XCTAssertNil(detail.files)
    }

    // MARK: - Playback progress (M3 Task 3)

    func testDecodeProgressState() throws {
        let json = """
        {"positionSec":120,"durationSec":6600,"finished":false}
        """.data(using: .utf8)!
        let progress = try JSONDecoder().decode(ProgressState.self, from: json)
        XCTAssertEqual(progress.positionSec, 120)
        XCTAssertEqual(progress.durationSec, 6600)
        XCTAssertFalse(progress.finished)
    }

    func testDecodeProgressStateNoSavedRow() throws {
        // GET /items/:id/progress's shape when no PlaybackState row exists
        // yet (see apps/api/src/routes/playstate.ts): all zeros, not an
        // error — must decode identically to a real saved-progress row.
        let json = """
        {"positionSec":0,"durationSec":0,"finished":false}
        """.data(using: .utf8)!
        let progress = try JSONDecoder().decode(ProgressState.self, from: json)
        XCTAssertEqual(progress.positionSec, 0)
        XCTAssertEqual(progress.durationSec, 0)
        XCTAssertFalse(progress.finished)
    }

    func testDecodeProgressStateFinished() throws {
        let json = """
        {"positionSec":6500,"durationSec":6600,"finished":true}
        """.data(using: .utf8)!
        let progress = try JSONDecoder().decode(ProgressState.self, from: json)
        XCTAssertTrue(progress.finished)
    }

    func testDecodeSimilarResponse() throws {
        // GET /api/items/:id/similar's {items: [...]} envelope (see
        // apps/api/src/routes/similar.ts's `toCard`): a narrower shape than
        // a home-row MediaCard (no backdropPath/progress/resume/addedAt) —
        // all of which are Optional on MediaCard, so this must still decode
        // cleanly with those fields nil rather than throwing.
        let json = """
        {"items":[{"id":"m3","title":"Interstellar","year":2014,
                   "posterPath":"/p3.jpg","matchState":"matched"}]}
        """.data(using: .utf8)!
        let response = try JSONDecoder().decode(SimilarResponse.self, from: json)
        XCTAssertEqual(response.items.count, 1)
        let card = try XCTUnwrap(response.items.first)
        XCTAssertEqual(card.id, "m3")
        XCTAssertEqual(card.title, "Interstellar")
        XCTAssertEqual(card.year, 2014)
        XCTAssertEqual(card.posterPath, "/p3.jpg")
        XCTAssertNil(card.backdropPath)
        XCTAssertNil(card.progress)
        XCTAssertNil(card.resume)
    }

    // MARK: - Search (M3 Task 5)

    func testDecodeSearchResponse() throws {
        // A representative GET /api/search?q= response (see
        // apps/api/src/routes/discovery.ts's "/search" route): the
        // embeddings-ranking path, usedEmbeddings: true.
        let json = """
        {"items":[{"id":"m1","title":"Arrival","year":2016,
                   "posterPath":"/p1.jpg","matchState":"matched"}],
         "usedEmbeddings":true}
        """.data(using: .utf8)!
        let response = try JSONDecoder().decode(SearchResponse.self, from: json)
        XCTAssertEqual(response.items.count, 1)
        let card = try XCTUnwrap(response.items.first)
        XCTAssertEqual(card.id, "m1")
        XCTAssertEqual(card.title, "Arrival")
        XCTAssertEqual(card.year, 2016)
        XCTAssertEqual(card.posterPath, "/p1.jpg")
        XCTAssertNil(card.backdropPath)
        XCTAssertNil(card.progress)
        XCTAssertNil(card.resume)
        XCTAssertEqual(response.usedEmbeddings, true)
    }

    func testDecodeSearchResponseZeroCandidatesKeywordDegrade() throws {
        // The route's `candidates.length === 0` early return sends
        // {items: [], usedEmbeddings: false} rather than 404ing or omitting
        // the flag — must decode to an empty array, not throw.
        let json = """
        {"items":[],"usedEmbeddings":false}
        """.data(using: .utf8)!
        let response = try JSONDecoder().decode(SearchResponse.self, from: json)
        XCTAssertTrue(response.items.isEmpty)
        XCTAssertEqual(response.usedEmbeddings, false)
    }

    func testDecodeSearchResponseToleratesMissingUsedEmbeddings() throws {
        // Decode-safety parity with this file's other wrapper-response
        // tests: usedEmbeddings absent entirely (not even null) must still
        // decode cleanly, with the field nil rather than throwing.
        let json = """
        {"items":[{"id":"m2","title":"Interstellar","year":2014,
                   "posterPath":null,"matchState":"matched"}]}
        """.data(using: .utf8)!
        let response = try JSONDecoder().decode(SearchResponse.self, from: json)
        XCTAssertEqual(response.items.count, 1)
        XCTAssertEqual(response.items.first?.title, "Interstellar")
        XCTAssertNil(response.usedEmbeddings)
    }

    // MARK: - Episodes (M3 Task 4)

    func testDecodeEpisodesResponse() throws {
        // A representative GET /api/items/:id/seasons/:n/episodes response
        // (see apps/api/src/routes/series.ts): one in-progress episode with
        // a fileId + progress (reusing ProgressState's shape), one entirely
        // unmatched episode (no file yet, so fileId is null; every other
        // optional is also null).
        let json = """
        {"episodes":[
          {"id":"e1","episodeNumber":1,"title":"Pilot",
           "overview":"The one where it begins.","stillPath":"/e1.jpg",
           "runtimeSec":2700,"airDate":"2020-01-05T00:00:00.000Z",
           "fileId":"f1","progress":{"positionSec":300,"durationSec":2700,"finished":false}},
          {"id":"e2","episodeNumber":2,"title":null,"overview":null,
           "stillPath":null,"runtimeSec":null,"airDate":null,
           "fileId":null,"progress":null}
        ]}
        """.data(using: .utf8)!
        let response = try JSONDecoder().decode(EpisodesResponse.self, from: json)
        XCTAssertEqual(response.episodes.count, 2)

        let first = response.episodes[0]
        XCTAssertEqual(first.id, "e1")
        XCTAssertEqual(first.episodeNumber, 1)
        XCTAssertEqual(first.title, "Pilot")
        XCTAssertEqual(first.overview, "The one where it begins.")
        XCTAssertEqual(first.stillPath, "/e1.jpg")
        XCTAssertEqual(first.runtimeSec, 2700)
        XCTAssertEqual(first.airDate, "2020-01-05T00:00:00.000Z")
        XCTAssertEqual(first.fileId, "f1")
        XCTAssertEqual(first.progress, ProgressState(positionSec: 300, durationSec: 2700, finished: false))

        let second = response.episodes[1]
        XCTAssertEqual(second.id, "e2")
        XCTAssertEqual(second.episodeNumber, 2)
        XCTAssertNil(second.title)
        XCTAssertNil(second.overview)
        XCTAssertNil(second.stillPath)
        XCTAssertNil(second.runtimeSec)
        XCTAssertNil(second.airDate)
        XCTAssertNil(second.fileId)
        XCTAssertNil(second.progress)
    }

    func testDecodeEpisodesResponseEmptySeason() throws {
        // series.ts sends {episodes: []} for an unknown season rather than
        // 404ing — must decode cleanly to an empty array, not throw.
        let json = """
        {"episodes":[]}
        """.data(using: .utf8)!
        let response = try JSONDecoder().decode(EpisodesResponse.self, from: json)
        XCTAssertTrue(response.episodes.isEmpty)
    }

    func testDecodeEpisodeToleratesMissingOptionalFields() throws {
        // Only the two truly-required fields present — every other key
        // entirely absent (not even null). Decode-safety parity with
        // ItemDetail's equivalent test.
        let json = """
        {"episodes":[{"id":"e3","episodeNumber":3}]}
        """.data(using: .utf8)!
        let response = try JSONDecoder().decode(EpisodesResponse.self, from: json)
        let episode = try XCTUnwrap(response.episodes.first)
        XCTAssertEqual(episode.id, "e3")
        XCTAssertEqual(episode.episodeNumber, 3)
        XCTAssertNil(episode.title)
        XCTAssertNil(episode.overview)
        XCTAssertNil(episode.fileId)
        XCTAssertNil(episode.progress)
    }

    func testDecodeEpisodeProgressFinished() throws {
        // A fully-watched episode: finished:true must round-trip, and is
        // what SeasonEpisodeView's resume-bar logic uses to suppress the
        // bar for a completed episode (see resumeFraction(_:)).
        let json = """
        {"episodes":[{"id":"e4","episodeNumber":4,
          "progress":{"positionSec":2650,"durationSec":2700,"finished":true}}]}
        """.data(using: .utf8)!
        let response = try JSONDecoder().decode(EpisodesResponse.self, from: json)
        let episode = try XCTUnwrap(response.episodes.first)
        XCTAssertEqual(episode.progress?.finished, true)
    }

    // MARK: - Menu (Task 5)

    func testDecodeMenuResponseHappyPath() throws {
        // GET /api/me/menu's real shape (see apps/api/src/routes/menu.ts's
        // "/me/menu" handler + resolveProfileMenu in
        // packages/core/src/menu/resolve.ts): {items: [{libraryId, name}]},
        // one entry per enabled library in resolved order. Matches
        // apps/web/src/lib/types.ts's MenuItem exactly (no "kind" on the
        // wire).
        let json = """
        {"items":[{"libraryId":"lib-1","name":"Movies"},
                   {"libraryId":"lib-2","name":"TV Shows"}]}
        """.data(using: .utf8)!
        let response = try JSONDecoder().decode(MenuResponse.self, from: json)
        XCTAssertEqual(response.items.count, 2)
        XCTAssertEqual(response.items.first?.libraryId, "lib-1")
        XCTAssertEqual(response.items.first?.name, "Movies")
        XCTAssertEqual(response.items.last?.libraryId, "lib-2")
        XCTAssertEqual(response.items.last?.name, "TV Shows")
    }

    func testDecodeMenuResponseNoActiveProfileIsEmpty() throws {
        // menu.ts: "if (!profile) return reply.send({ items: [] })" — no
        // active profile must decode to an empty array, not throw.
        let json = """
        {"items":[]}
        """.data(using: .utf8)!
        let response = try JSONDecoder().decode(MenuResponse.self, from: json)
        XCTAssertTrue(response.items.isEmpty)
    }

    func testDecodeMenuItemWithNullName() throws {
        // Decode-safety parity with this file's other DTOs: name is
        // Optional (this file's convention is every non-key field tolerates
        // null/missing), even though resolveProfileMenu never actually nulls
        // it today — libraryId is the entry's key and is always present.
        let json = """
        {"libraryId":"lib-3","name":null}
        """.data(using: .utf8)!
        let item = try JSONDecoder().decode(MenuItem.self, from: json)
        XCTAssertEqual(item.libraryId, "lib-3")
        XCTAssertNil(item.name)
    }

    // MARK: - Create profile (Task 5)

    func testDecodeCreateProfileResponse() throws {
        // POST /api/profiles's real select shape (see
        // apps/api/src/routes/profiles.ts): {id, name, kind, language} only
        // — no avatar/maturityCap key at all (not even null), which must
        // still decode cleanly against the shared Profile DTO since both
        // are already Optional there.
        let json = """
        {"id":"p2","name":"New Profile","kind":"standard","language":"en"}
        """.data(using: .utf8)!
        let profile = try JSONDecoder().decode(Profile.self, from: json)
        XCTAssertEqual(profile.id, "p2")
        XCTAssertEqual(profile.name, "New Profile")
        XCTAssertEqual(profile.kind, "standard")
        XCTAssertEqual(profile.language, "en")
        XCTAssertNil(profile.avatar)
        XCTAssertNil(profile.maturityCap)
    }

    // MARK: - MeProfile kind/language (Task 5)

    func testDecodeMeProfileCarriesKindAndLanguage() throws {
        // MeProfile already models kind/language (see activeProfile's select
        // in apps/api/src/lib/catalog-filter.ts), but no existing test
        // actually asserted `language` decodes — this closes that gap.
        let json = """
        {"id":"p1","name":"Alex","avatar":null,"kind":"standard","maturityCap":null,"language":"es"}
        """.data(using: .utf8)!
        let me = try JSONDecoder().decode(MeProfile.self, from: json)
        XCTAssertEqual(me.kind, "standard")
        XCTAssertEqual(me.language, "es")
    }

    func testDecodeMeProfileAllNullOmitsLanguageKeyEntirely() throws {
        // profiles.ts's "no active profile" branch sends
        // {id:null,name:null,avatar:null,kind:null,maturityCap:null} —
        // notably the "language" key is omitted entirely (not even null).
        // Must still decode language as nil rather than throwing.
        let json = """
        {"id":null,"name":null,"avatar":null,"kind":null,"maturityCap":null}
        """.data(using: .utf8)!
        let me = try JSONDecoder().decode(MeProfile.self, from: json)
        XCTAssertNil(me.language)
    }

    // MARK: - Library items (Phase 2 Task 1) — GET /libraries/:id/items (bare array)

    func testDecodeLibraryItemsBareArray() throws {
        // apps/api/src/routes/catalog.ts:44-60 select: {id,title,year,posterPath,matchState}
        // (title localized). Bare array, no envelope. year/posterPath nullable;
        // an unmatched item carries matchState:"unmatched" and a null poster.
        let json = """
        [{"id":"m1","title":"Arrival","year":2016,"posterPath":"/p1.jpg","matchState":"matched"},
         {"id":"m2","title":"Untitled Import","year":null,"posterPath":null,"matchState":"unmatched"}]
        """.data(using: .utf8)!
        let items = try JSONDecoder().decode([MediaCard].self, from: json)
        XCTAssertEqual(items.count, 2)
        XCTAssertEqual(items[0].id, "m1")
        XCTAssertEqual(items[0].matchState, "matched")
        XCTAssertEqual(items[1].matchState, "unmatched")
        XCTAssertNil(items[1].year)
        XCTAssertNil(items[1].posterPath)
        // Fields not on this wire shape decode to nil, not throw.
        XCTAssertNil(items[0].backdropPath)
        XCTAssertNil(items[0].addedAt)
        XCTAssertNil(items[0].progress)
    }

    // MARK: - Wishlist (Phase 2 Task 1)

    func testDecodeWishlistItemsBareArray() throws {
        // apps/api/src/routes/wishlist.ts:38-44 — newest-first, {id,title,year,posterPath,matchState}.
        let json = """
        [{"id":"m2","title":"Beta","year":2020,"posterPath":"/p2.jpg","matchState":"matched"},
         {"id":"m1","title":"Alpha","year":2019,"posterPath":"/p1.jpg","matchState":"manual"}]
        """.data(using: .utf8)!
        let items = try JSONDecoder().decode([MediaCard].self, from: json)
        XCTAssertEqual(items.map(\.id), ["m2", "m1"])
        XCTAssertEqual(items.first?.matchState, "matched")
    }

    func testDecodeWishlistEmpty() throws {
        // wishlist.ts:18 returns [] when there are no entries.
        let items = try JSONDecoder().decode([MediaCard].self, from: Data("[]".utf8))
        XCTAssertTrue(items.isEmpty)
    }

    func testDecodeWishlistIdsResponse() throws {
        // wishlist.ts:67 → {ids:[...]}; :58 → {ids:[]} when empty.
        let json = """
        {"ids":["m2","m1"]}
        """.data(using: .utf8)!
        let response = try JSONDecoder().decode(WishlistIdsResponse.self, from: json)
        XCTAssertEqual(response.ids, ["m2", "m1"])
        let empty = try JSONDecoder().decode(WishlistIdsResponse.self, from: Data(#"{"ids":[]}"#.utf8))
        XCTAssertTrue(empty.ids.isEmpty)
    }

    // MARK: - MediaCard new fields (Phase 2 Task 1)

    func testDecodeHomeCardAddedAtNowModeled() throws {
        // discovery.ts:285 sends addedAt on every home-row card; it is now modeled
        // (needed by the billboard/box-art NEW badge — Task 2/3). matchState is
        // absent on home cards and must decode to nil.
        let json = """
        {"id":"m1","title":"Arrival","year":2016,"posterPath":"/p1.jpg",
         "backdropPath":"/b1.jpg","addedAt":"2026-07-01T00:00:00.000Z",
         "progress":null,"resume":null}
        """.data(using: .utf8)!
        let card = try JSONDecoder().decode(MediaCard.self, from: json)
        XCTAssertEqual(card.addedAt, "2026-07-01T00:00:00.000Z")
        XCTAssertEqual(card.backdropPath, "/b1.jpg")
        XCTAssertNil(card.matchState)
    }
}
