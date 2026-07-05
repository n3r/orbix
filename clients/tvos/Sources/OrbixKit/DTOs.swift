import Foundation

// MARK: - Capabilities

/// Client capability profile sent to the server on every playback
/// negotiation (`POST /api/playback/info`). Field-for-field mirror of
/// `ClientCapabilities` / `parseCapabilities` in
/// `apps/api/src/routes/playback.ts`.
public struct Capabilities: Codable, Sendable, Equatable {
    public var containers: [String]
    public var videoCodecs: [String]
    public var audioCodecs: [String]
    public var maxAudioChannels: Int
    public var hlsMultichannelAacBroken: Bool?
    public var subtitleDelivery: String?

    public init(
        containers: [String],
        videoCodecs: [String],
        audioCodecs: [String],
        maxAudioChannels: Int,
        hlsMultichannelAacBroken: Bool? = nil,
        subtitleDelivery: String? = nil
    ) {
        self.containers = containers
        self.videoCodecs = videoCodecs
        self.audioCodecs = audioCodecs
        self.maxAudioChannels = maxAudioChannels
        self.hlsMultichannelAacBroken = hlsMultichannelAacBroken
        self.subtitleDelivery = subtitleDelivery
    }

    /// The tvOS device capability profile (SP2 Global Constraints): fMP4/HLS
    /// via AVPlayer, H.264/HEVC video, up to 5.1 AAC/AC-3/E-AC-3/FLAC audio,
    /// subtitles delivered as HLS renditions rather than app-drawn sidecars.
    public static let appleTV = Capabilities(
        containers: ["mp4"],
        videoCodecs: ["h264", "hevc"],
        audioCodecs: ["aac", "ac3", "eac3", "flac"],
        maxAudioChannels: 6,
        subtitleDelivery: "hls"
    )
}

// MARK: - Playback negotiation

/// Body of `POST /api/playback/info`.
public struct PlaybackInfoRequest: Codable, Sendable, Equatable {
    public var fileId: String
    public var capabilities: Capabilities
    public var audioTrackIndex: Int?

    public init(fileId: String, capabilities: Capabilities, audioTrackIndex: Int? = nil) {
        self.fileId = fileId
        self.capabilities = capabilities
        self.audioTrackIndex = audioTrackIndex
    }
}

public struct AudioTrack: Codable, Sendable, Equatable {
    public var index: Int
    public var codec: String?
    public var channels: Int?
    public var language: String?
    public var selected: Bool

    public init(index: Int, codec: String? = nil, channels: Int? = nil, language: String? = nil, selected: Bool) {
        self.index = index
        self.codec = codec
        self.channels = channels
        self.language = language
        self.selected = selected
    }
}

public struct SubtitleTrack: Codable, Sendable, Equatable {
    public var index: Int
    public var codec: String?
    public var language: String?
    public var available: Bool
    public var reason: String?

    public init(index: Int, codec: String? = nil, language: String? = nil, available: Bool, reason: String? = nil) {
        self.index = index
        self.codec = codec
        self.language = language
        self.available = available
        self.reason = reason
    }
}

/// Response of `POST /api/playback/info`.
public struct PlaybackInfo: Codable, Sendable, Equatable {
    public var playSessionId: String
    public var mode: String
    public var streamUrl: String
    public var container: String?
    public var videoCodec: String?
    public var audioTracks: [AudioTrack]
    public var subtitleTracks: [SubtitleTrack]

    public init(
        playSessionId: String,
        mode: String,
        streamUrl: String,
        container: String? = nil,
        videoCodec: String? = nil,
        audioTracks: [AudioTrack],
        subtitleTracks: [SubtitleTrack]
    ) {
        self.playSessionId = playSessionId
        self.mode = mode
        self.streamUrl = streamUrl
        self.container = container
        self.videoCodec = videoCodec
        self.audioTracks = audioTracks
        self.subtitleTracks = subtitleTracks
    }
}

// MARK: - Catalog

/// Decodes the common fields of a home-row / catalog item, per the shape
/// `GET /api/home/rows` sends (see `apps/api/src/routes/discovery.ts`'s
/// `rows` hydration step). `addedAt` is the one field on the server's card
/// this type still doesn't model — simply ignored by Codable's synthesized
/// `init(from:)` — since nothing in the tvOS app needs it yet.
public struct MediaCard: Codable, Sendable, Equatable {
    /// A movie/series' resume position, as sent on a home-row card with an
    /// in-progress `PlaybackState` (`cw` in the server's row-hydration
    /// step). `durationSec` is expected `> 0` in practice, but nothing here
    /// enforces that — callers computing a fraction (e.g. `PosterCard`'s
    /// resume bar) must guard the divide themselves.
    public struct Progress: Codable, Sendable, Equatable {
        public var positionSec: Int
        public var durationSec: Int

        public init(positionSec: Int, durationSec: Int) {
            self.positionSec = positionSec
            self.durationSec = durationSec
        }
    }

    /// The season/episode a series' resume `Progress` belongs to, resolved
    /// server-side from the in-progress `PlaybackState.episodeId`. Absent
    /// (`nil`) for a movie card even when `progress` is present — the
    /// server only attaches `resume` when the continue-watching state's
    /// `episodeId` is non-empty (see `epById`/`ep` in `discovery.ts`).
    public struct Resume: Codable, Sendable, Equatable {
        public var seasonNumber: Int
        public var episodeNumber: Int
        public var episodeTitle: String?

        public init(seasonNumber: Int, episodeNumber: Int, episodeTitle: String? = nil) {
            self.seasonNumber = seasonNumber
            self.episodeNumber = episodeNumber
            self.episodeTitle = episodeTitle
        }
    }

    public var id: String
    public var title: String
    public var year: Int?
    public var posterPath: String?
    public var backdropPath: String?
    public var progress: Progress?
    public var resume: Resume?

    public init(
        id: String,
        title: String,
        year: Int? = nil,
        posterPath: String? = nil,
        backdropPath: String? = nil,
        progress: Progress? = nil,
        resume: Resume? = nil
    ) {
        self.id = id
        self.title = title
        self.year = year
        self.posterPath = posterPath
        self.backdropPath = backdropPath
        self.progress = progress
        self.resume = resume
    }
}

public struct HomeRow: Codable, Sendable, Equatable {
    public var key: String
    public var title: String
    public var items: [MediaCard]

    public init(key: String, title: String, items: [MediaCard]) {
        self.key = key
        self.title = title
        self.items = items
    }
}

/// Response of `GET /api/home/rows`.
public struct HomeRows: Codable, Sendable, Equatable {
    public var rows: [HomeRow]

    public init(rows: [HomeRow]) {
        self.rows = rows
    }
}

// MARK: - Item detail

/// Decode target for `GET /api/items/:id` (see `apps/api/src/routes/catalog.ts`),
/// the M3 title/detail page's primary data source. Every field beyond
/// `id`/`kind`/`title` is `Optional`: some because the server can send an
/// explicit `null` (a movie missing a rating, an unmatched title with no
/// resolved genres, ...), `seasons` because the key is only present at all
/// when `kind == "series"` (the route spreads it in conditionally —
/// `...(item.kind === "series" ? {seasons: [...]} : {})`), and the rest
/// defensively even though the route currently always sends them (as an
/// array, at worst empty) — Codable's synthesized `init(from:)` calls
/// `decodeIfPresent` for every `Optional` stored property, so a missing key
/// and an explicit `null` both decode to `nil` without throwing, which keeps
/// this type decode-safe against a server that omits or nulls out more than
/// it does today.
public struct ItemDetail: Codable, Sendable, Equatable {
    public struct FileRef: Codable, Sendable, Equatable {
        public var id: String

        public init(id: String) {
            self.id = id
        }
    }

    /// One `credits` row with `department == "cast"`, as the route maps it:
    /// `{name: person.name, character: role}` (see `catalog.ts`'s
    /// `item.credits.filter(...).map(...)`, top 15). Note the wire field is
    /// `character` — the role *name* (e.g. "Woody"), not a generic
    /// credit shape — the route already drops `department`/`order` before
    /// serializing, so there's nothing else to decode here. `character` is
    /// `NOT NULL` in the DB (`Credit.role: String`), but modeled `Optional`
    /// here anyway per this type's general decode-safety stance.
    public struct CastMember: Codable, Sendable, Equatable {
        public var name: String
        public var character: String?

        public init(name: String, character: String? = nil) {
            self.name = name
            self.character = character
        }
    }

    /// The credited `department == "crew"`, `role == "Director"` row, if any
    /// (`{name: person.name}` — see `catalog.ts`'s `directorCredit`).
    public struct Director: Codable, Sendable, Equatable {
        public var name: String

        public init(name: String) {
            self.name = name
        }
    }

    /// One entry of a series' `seasons` array (only present when
    /// `kind == "series"`). `episodeCount` is the season's `_count.episodes`
    /// from the route's Prisma select, not something derived client-side.
    public struct SeasonSummary: Codable, Sendable, Equatable {
        public var seasonNumber: Int
        public var name: String?
        public var episodeCount: Int?
        public var posterPath: String?

        public init(seasonNumber: Int, name: String? = nil, episodeCount: Int? = nil, posterPath: String? = nil) {
            self.seasonNumber = seasonNumber
            self.name = name
            self.episodeCount = episodeCount
            self.posterPath = posterPath
        }
    }

    public var id: String
    public var kind: String
    public var title: String
    public var year: Int?
    public var overview: String?
    public var posterPath: String?
    public var backdropPath: String?
    public var logoPath: String?
    public var runtimeSec: Int?
    public var rating: String?
    public var genres: [String]?
    public var cast: [CastMember]?
    public var director: Director?
    /// Series only (see the type doc comment); `nil` for a movie.
    public var seasons: [SeasonSummary]?
    /// A movie's playable files, "best copy first" per the server's
    /// `orderBy` (height/bitrate desc) — the title page's Play button uses
    /// `files?.first?.id`. **Do not assume this is empty/absent for a
    /// series**: `MediaFile.mediaItemId` is shared by a series' episode
    /// files too (the route's `files` relation isn't filtered by episode),
    /// so a series' `files` can be non-empty but is not a sensible Play
    /// target — branch on `kind` instead, not on whether `files` is empty.
    public var files: [FileRef]?

    public init(
        id: String,
        kind: String,
        title: String,
        year: Int? = nil,
        overview: String? = nil,
        posterPath: String? = nil,
        backdropPath: String? = nil,
        logoPath: String? = nil,
        runtimeSec: Int? = nil,
        rating: String? = nil,
        genres: [String]? = nil,
        cast: [CastMember]? = nil,
        director: Director? = nil,
        seasons: [SeasonSummary]? = nil,
        files: [FileRef]? = nil
    ) {
        self.id = id
        self.kind = kind
        self.title = title
        self.year = year
        self.overview = overview
        self.posterPath = posterPath
        self.backdropPath = backdropPath
        self.logoPath = logoPath
        self.runtimeSec = runtimeSec
        self.rating = rating
        self.genres = genres
        self.cast = cast
        self.director = director
        self.seasons = seasons
        self.files = files
    }
}

// MARK: - Playback progress

/// Response of `GET /api/items/:id/progress` (see
/// `apps/api/src/routes/playstate.ts`) — the active profile's saved
/// playback position for this item (or, with `?episodeId=`, one of its
/// episodes) — or all-zero/`finished: false` when no `PlaybackState` row
/// exists yet (the route sends that shape rather than 404ing, so "no saved
/// progress" and "an actual zero-second save" are indistinguishable on the
/// wire; nothing needs to tell them apart — both correctly mean "don't
/// offer Resume").
public struct ProgressState: Codable, Sendable, Equatable {
    public var positionSec: Int
    public var durationSec: Int
    public var finished: Bool

    public init(positionSec: Int, durationSec: Int, finished: Bool) {
        self.positionSec = positionSec
        self.durationSec = durationSec
        self.finished = finished
    }
}

/// Response of `GET /api/items/:id/similar` (see
/// `apps/api/src/routes/similar.ts`): `{items: [...]}`, each entry a subset
/// of `MediaCard`'s fields (`id,title,year,posterPath,matchState`) —
/// `matchState` isn't modeled (nothing needs it yet), and
/// `backdropPath`/`progress`/`resume` are simply absent on the wire, which
/// decode to `nil` since every one of those is already `Optional` on
/// `MediaCard`.
public struct SimilarResponse: Codable, Sendable, Equatable {
    public var items: [MediaCard]

    public init(items: [MediaCard]) {
        self.items = items
    }
}

// MARK: - Search

/// Response of `GET /api/search?q=` (see `apps/api/src/routes/discovery.ts`'s
/// `/search` route): `{items: [...], usedEmbeddings: boolean}`. `items`
/// shares `SimilarResponse`'s narrow per-card shape (`id,title,year,
/// posterPath,matchState`; `matchState` unmodeled, same rationale as
/// `SimilarResponse`'s doc comment — `backdropPath`/`progress`/`resume`
/// simply aren't on the wire here either, decoding to `nil` since all three
/// are already `Optional` on `MediaCard`). `usedEmbeddings` reports whether
/// the route's vector-similarity ranking actually fired for this query
/// versus its keyword-degrade fallback (`EmbedderUnavailable`, no
/// embeddings backfilled yet, a non-finite query vector, ...) — modeled
/// `Optional` per this file's general decode-safety stance even though
/// every branch of the route currently sends it (including the
/// zero-candidates early return); nothing in the app surfaces it today, but
/// it decodes rather than being dropped so a future "was this a semantic
/// match" affordance doesn't need a DTO change.
public struct SearchResponse: Codable, Sendable, Equatable {
    public var items: [MediaCard]
    public var usedEmbeddings: Bool?

    public init(items: [MediaCard], usedEmbeddings: Bool? = nil) {
        self.items = items
        self.usedEmbeddings = usedEmbeddings
    }
}

// MARK: - Episodes (series)

/// One entry of `GET /api/items/:id/seasons/:n/episodes`'s `episodes` array
/// (see `apps/api/src/routes/series.ts`), the M3 Task 4 season/episode
/// page's data source. `fileId` is the episode's single owned `MediaFile`
/// id (the route's `files: {select: {id: true}, take: 1}`) or `nil` when
/// the episode isn't in the library yet — the row still renders (still art,
/// title, runtime) but there's nothing to play, so `SeasonEpisodeView`
/// disables that row rather than hiding it. `progress` reuses
/// `ProgressState` rather than a bespoke nested type: the route's
/// per-episode progress hydration (`progressByEpisode`/`states` in
/// series.ts) reads the same `PlaybackState` row `GET .../progress` does,
/// just keyed by `episodeId` instead of a bare item id, and sends the exact
/// same `{positionSec,durationSec,finished}` shape — there's no reason to
/// model it twice. Every field but `id`/`episodeNumber` is `Optional` for
/// the same decode-safety reasons as `ItemDetail` (a missing key and an
/// explicit `null` both decode to `nil` without throwing).
public struct Episode: Codable, Sendable, Equatable {
    public var id: String
    public var episodeNumber: Int
    public var title: String?
    public var overview: String?
    public var stillPath: String?
    public var runtimeSec: Int?
    public var airDate: String?
    public var fileId: String?
    public var progress: ProgressState?

    public init(
        id: String,
        episodeNumber: Int,
        title: String? = nil,
        overview: String? = nil,
        stillPath: String? = nil,
        runtimeSec: Int? = nil,
        airDate: String? = nil,
        fileId: String? = nil,
        progress: ProgressState? = nil
    ) {
        self.id = id
        self.episodeNumber = episodeNumber
        self.title = title
        self.overview = overview
        self.stillPath = stillPath
        self.runtimeSec = runtimeSec
        self.airDate = airDate
        self.fileId = fileId
        self.progress = progress
    }
}

/// Response of `GET /api/items/:id/seasons/:n/episodes`. An unknown season
/// number decodes to the same shape with an empty `episodes` array — the
/// route sends `{episodes: []}` rather than 404ing (see series.ts's
/// `if (!season) return reply.send({episodes: []})`).
public struct EpisodesResponse: Codable, Sendable, Equatable {
    public var episodes: [Episode]

    public init(episodes: [Episode]) {
        self.episodes = episodes
    }
}

// MARK: - Pairing

/// Response of `POST /api/pair/initiate`.
public struct PairInitiateResponse: Codable, Sendable, Equatable {
    public var code: String
    public var pollToken: String
    public var expiresInSec: Int

    public init(code: String, pollToken: String, expiresInSec: Int) {
        self.code = code
        self.pollToken = pollToken
        self.expiresInSec = expiresInSec
    }
}

/// Response of `GET /api/pair/poll`: either still pending, or approved with
/// the device's new bearer token + id. Custom `init(from:)` switches on the
/// `status` discriminator (see `PairingStore.redeem` in
/// `apps/api/src/lib/pairing.ts`).
public enum PairPollResponse: Decodable, Sendable, Equatable {
    case pending
    case approved(deviceToken: String, deviceId: String)

    private enum CodingKeys: String, CodingKey {
        case status, deviceToken, deviceId
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let status = try container.decode(String.self, forKey: .status)
        if status == "approved" {
            self = .approved(
                deviceToken: try container.decode(String.self, forKey: .deviceToken),
                deviceId: try container.decode(String.self, forKey: .deviceId)
            )
        } else {
            self = .pending
        }
    }
}

// MARK: - Profiles

/// A profile as returned by `GET /api/profiles` (and the non-null case of
/// `GET /api/me/profile`).
public struct Profile: Codable, Sendable, Equatable {
    public var id: String
    public var name: String
    public var avatar: String?
    public var kind: String?
    public var maturityCap: Int?
    public var language: String?

    public init(
        id: String,
        name: String,
        avatar: String? = nil,
        kind: String? = nil,
        maturityCap: Int? = nil,
        language: String? = nil
    ) {
        self.id = id
        self.name = name
        self.avatar = avatar
        self.kind = kind
        self.maturityCap = maturityCap
        self.language = language
    }
}

// MARK: - Menu

/// One catalog category in the profile's nav, one per enabled library (see
/// `resolveProfileMenu` in `packages/core/src/menu/resolve.ts`, consumed by
/// `apps/api/src/routes/menu.ts`'s `/me/menu` handler). Mirrors
/// `apps/web/src/lib/types.ts`'s `MenuItem` exactly: no `kind` on the wire.
/// `libraryId` is this entry's key (always present — it's the library's
/// `cuid`); `name` is modeled `Optional` per this file's decode-safety
/// stance even though `resolveProfileMenu` never actually nulls it today
/// (`Library.name` is `NOT NULL`).
public struct MenuItem: Decodable, Sendable, Equatable {
    public var libraryId: String
    public var name: String?

    public init(libraryId: String, name: String? = nil) {
        self.libraryId = libraryId
        self.name = name
    }
}

/// Response of `GET /api/me/menu`: `{items: [...]}`. When no profile is
/// active yet, `menu.ts` sends `{items: []}` rather than erroring (see its
/// `if (!profile) return reply.send({ items: [] })`), which decodes to an
/// empty array here, not a decode failure.
public struct MenuResponse: Decodable, Sendable, Equatable {
    public var items: [MenuItem]

    public init(items: [MenuItem]) {
        self.items = items
    }
}

/// Response of `GET /api/me/profile`: this session's (or bearer device's)
/// currently-active profile. Unlike `Profile`, every field — including
/// `id`/`name` — is optional: when no profile has been selected yet, the
/// server responds `{id: null, name: null, avatar: null, kind: null,
/// maturityCap: null}` rather than 404ing (see
/// `apps/api/src/routes/profiles.ts`'s `/me/profile` handler), so `id ==
/// nil` is the drives-`.needsProfile` case `AppModel` checks for, not a
/// decode failure.
public struct MeProfile: Codable, Sendable, Equatable {
    public var id: String?
    public var name: String?
    public var avatar: String?
    public var kind: String?
    public var maturityCap: Int?
    public var language: String?

    public init(
        id: String? = nil,
        name: String? = nil,
        avatar: String? = nil,
        kind: String? = nil,
        maturityCap: Int? = nil,
        language: String? = nil
    ) {
        self.id = id
        self.name = name
        self.avatar = avatar
        self.kind = kind
        self.maturityCap = maturityCap
        self.language = language
    }
}
