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

/// Body of `POST /api/playback/info`. `quality`/`audioMode` are omitted from
/// the wire when `nil` (Codable's synthesized `encode(to:)` uses
/// `encodeIfPresent` for `Optional` stored properties) so the server applies
/// its own defaults (`"source"` quality, `"standard"` audio mode) on initial
/// negotiation; a later re-negotiation passes the user's picked values.
public struct PlaybackInfoRequest: Codable, Sendable, Equatable {
    public var fileId: String
    public var capabilities: Capabilities
    public var audioTrackIndex: Int?
    public var quality: String?
    public var audioMode: String?

    public init(
        fileId: String,
        capabilities: Capabilities,
        audioTrackIndex: Int? = nil,
        quality: String? = nil,
        audioMode: String? = nil
    ) {
        self.fileId = fileId
        self.capabilities = capabilities
        self.audioTrackIndex = audioTrackIndex
        self.quality = quality
        self.audioMode = audioMode
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

/// One rung of the quality ladder `buildPlaybackQualities` (see
/// `packages/core/src/playback/quality.ts`) derives from a file's probed
/// dimensions/bitrate: the source resolution plus any downscale targets below
/// it (1080p/720p/480p). `width`/`height` are `nil` for the `"source"` rung
/// when the file's dimensions weren't probed; `bandwidth` is always a number.
public struct QualityOption: Codable, Sendable, Equatable {
    public var id: String
    public var label: String
    public var width: Int?
    public var height: Int?
    public var bandwidth: Int?

    public init(id: String, label: String, width: Int? = nil, height: Int? = nil, bandwidth: Int? = nil) {
        self.id = id
        self.label = label
        self.width = width
        self.height = height
        self.bandwidth = bandwidth
    }
}

/// One entry of the server's fixed `AUDIO_MODES` const (`apps/api/src/routes/
/// playback.ts`): `"standard"` (copy) or `"leveled"` (loudness-normalized,
/// forces at least a remux).
public struct AudioModeOption: Codable, Sendable, Equatable {
    public var id: String
    public var label: String

    public init(id: String, label: String) {
        self.id = id
        self.label = label
    }
}

/// Response of `POST /api/playback/info`. `quality`/`audioMode`/`qualities`/
/// `audioModes` are the quality/audio-leveling ladder (Phase 3 Task 1): the
/// quality/mode the server actually used for this session plus the full set
/// of choices, driving the player's Quality / Audio-leveling menu (mirrors
/// the web player's `PlaybackInfo` in `apps/web/src/components/Player.tsx`).
/// Modeled `Optional` per this file's decode-safety stance even though the
/// route currently always sends them.
public struct PlaybackInfo: Codable, Sendable, Equatable {
    public var playSessionId: String
    public var mode: String
    public var streamUrl: String
    public var container: String?
    public var videoCodec: String?
    public var quality: String?
    public var audioMode: String?
    public var qualities: [QualityOption]?
    public var audioModes: [AudioModeOption]?
    public var audioTracks: [AudioTrack]
    public var subtitleTracks: [SubtitleTrack]

    public init(
        playSessionId: String,
        mode: String,
        streamUrl: String,
        container: String? = nil,
        videoCodec: String? = nil,
        quality: String? = nil,
        audioMode: String? = nil,
        qualities: [QualityOption]? = nil,
        audioModes: [AudioModeOption]? = nil,
        audioTracks: [AudioTrack],
        subtitleTracks: [SubtitleTrack]
    ) {
        self.playSessionId = playSessionId
        self.mode = mode
        self.streamUrl = streamUrl
        self.container = container
        self.videoCodec = videoCodec
        self.quality = quality
        self.audioMode = audioMode
        self.qualities = qualities
        self.audioModes = audioModes
        self.audioTracks = audioTracks
        self.subtitleTracks = subtitleTracks
    }
}

// MARK: - Catalog

/// Decodes the common fields of a home-row / catalog item, per the shape
/// `GET /api/home/rows` sends (see `apps/api/src/routes/discovery.ts`'s
/// `rows` hydration step). Also doubles as the decode target for the
/// narrower `{id,title,year,posterPath,matchState}` shape shared by
/// `GET /libraries/:id/items`, `GET /wishlist`, `similar`, and `search` —
/// every field beyond `id`/`title` is `Optional`, so a card missing
/// `backdropPath`/`progress`/`resume`/`addedAt`/`matchState` on the wire
/// still decodes cleanly with those `nil`.
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
    /// The item's `addedAt` timestamp (ISO 8601 string), present on
    /// home-row cards (`discovery.ts`'s row hydration) and absent from the
    /// narrower catalog/wishlist/search shapes — drives the billboard/
    /// box-art "NEW" badge (Phase 2 Tasks 2/3).
    public var addedAt: String?
    /// The item's recognition state (`"matched"`, `"unmatched"`, `"manual"`,
    /// ...), present on the narrower catalog/wishlist/search/similar card
    /// shapes and absent from home-row cards.
    public var matchState: String?

    public init(
        id: String,
        title: String,
        year: Int? = nil,
        posterPath: String? = nil,
        backdropPath: String? = nil,
        progress: Progress? = nil,
        resume: Resume? = nil,
        addedAt: String? = nil,
        matchState: String? = nil
    ) {
        self.id = id
        self.title = title
        self.year = year
        self.posterPath = posterPath
        self.backdropPath = backdropPath
        self.progress = progress
        self.resume = resume
        self.addedAt = addedAt
        self.matchState = matchState
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
///
/// `tmdbScore`/`imdbRating`/`imdbVotes`/`rtRating`/`metacritic` (Phase 3
/// Task 1) are the ratings shown on the title hero (mirrors the web player's
/// `Ratings` in `apps/web/src/lib/types.ts`) — every title carries the keys
/// with explicit `null`s when unrated/unmatched, never an absent key,
/// per `catalog.ts`'s response block. `matchState` (`"matched"` /
/// `"unmatched"` / `"manual"`) is the same recognition-state string
/// `MediaCard` already models; `ItemDetail` gains its own copy here since
/// the route always sends it on the detail response too.
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
    public var tmdbScore: Double?
    public var imdbRating: Double?
    public var imdbVotes: Int?
    public var rtRating: Int?
    public var metacritic: Int?
    public var matchState: String?
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
        tmdbScore: Double? = nil,
        imdbRating: Double? = nil,
        imdbVotes: Int? = nil,
        rtRating: Int? = nil,
        metacritic: Int? = nil,
        matchState: String? = nil,
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
        self.tmdbScore = tmdbScore
        self.imdbRating = imdbRating
        self.imdbVotes = imdbVotes
        self.rtRating = rtRating
        self.metacritic = metacritic
        self.matchState = matchState
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
/// `backdropPath`/`progress`/`resume`/`addedAt` are simply absent on the
/// wire, which decode to `nil` since every one of those is already
/// `Optional` on `MediaCard`.
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
/// posterPath,matchState`) — `backdropPath`/`progress`/`resume`/`addedAt`
/// simply aren't on the wire here either, decoding to `nil` since all four
/// are already `Optional` on `MediaCard`. `usedEmbeddings` reports whether
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
/// title, runtime) but there's nothing to play, so `SeasonEpisodeListView`
/// disables that card rather than hiding it. `progress` reuses
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
public struct MenuItem: Codable, Sendable, Equatable {
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
public struct MenuResponse: Codable, Sendable, Equatable {
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

// MARK: - Wishlist (Phase 2 Task 1)

/// Response of `GET /api/wishlist/ids` (see
/// `apps/api/src/routes/wishlist.ts`): membership ids for the active
/// profile's saved titles, newest-first, filtered to only what the profile
/// can currently see (fail-safe: never leaks a kids-blocked id). `{ids: []}`
/// when the wishlist is empty.
public struct WishlistIdsResponse: Codable, Sendable, Equatable {
    public var ids: [String]

    public init(ids: [String]) {
        self.ids = ids
    }
}

// MARK: - TV (Phase 4)

/// One now/next programme slot (`apps/api/src/lib/tv-now-next.ts:3-6`'s
/// `TvNowNextSlot`): `title`/`start`/`stop` are always present when the slot
/// itself is non-null — the server never sends a partial slot, only a whole
/// slot or `null` for the whole `now`/`next` key.
public struct TvProgrammeSlot: Codable, Sendable, Equatable {
    public var title: String
    public var start: String
    public var stop: String

    public init(title: String, start: String, stop: String) {
        self.title = title
        self.start = start
        self.stop = stop
    }
}

/// Channel card shared by `/tv/home` rails, `/tv/guide` rows and (without
/// `now`/`next`) `/tv/favorites` — `toCard()` in `apps/api/src/routes/
/// tv-catalog.ts:56-68`. `now`/`next` are `Optional` for two different
/// reasons: on `/tv/home` and `/tv/guide` the server always sends the keys,
/// present-but-`null` when nothing airs (`tv-catalog.ts:165-171`'s `dec`);
/// on `/tv/favorites` the keys are **absent entirely** (`tv-catalog.ts:
/// 447-449`'s plain `toCard()`, no `dec`) — both cases decode to `nil` here
/// since Codable's synthesized `init(from:)` calls `decodeIfPresent` for
/// every `Optional` stored property.
public struct TvChannelCard: Codable, Sendable, Equatable {
    public var id: String
    public var number: Int
    public var name: String
    public var country: String?
    public var categories: [String]
    public var quality: String?
    /// Same-origin cached-image URL (`"/api/images/channel/x.png"`) or `nil`
    /// → UI monogram (mirrors the handler's doc comment on `TvChannelCard`).
    public var logo: String?
    public var healthy: Bool
    public var favorite: Bool
    public var now: TvProgrammeSlot?
    public var next: TvProgrammeSlot?

    public init(
        id: String,
        number: Int,
        name: String,
        country: String? = nil,
        categories: [String],
        quality: String? = nil,
        logo: String? = nil,
        healthy: Bool,
        favorite: Bool,
        now: TvProgrammeSlot? = nil,
        next: TvProgrammeSlot? = nil
    ) {
        self.id = id
        self.number = number
        self.name = name
        self.country = country
        self.categories = categories
        self.quality = quality
        self.logo = logo
        self.healthy = healthy
        self.favorite = favorite
        self.now = now
        self.next = next
    }
}

/// One `/tv/home` country rail (`tv-catalog.ts:132-137`).
public struct TvCountryRail: Codable, Sendable, Equatable {
    public var code: String
    public var channels: [TvChannelCard]

    public init(code: String, channels: [TvChannelCard]) {
        self.code = code
        self.channels = channels
    }
}

/// One `/tv/home` category rail (`tv-catalog.ts:148-153`).
public struct TvCategoryRail: Codable, Sendable, Equatable {
    public var id: String
    public var channels: [TvChannelCard]

    public init(id: String, channels: [TvChannelCard]) {
        self.id = id
        self.channels = channels
    }
}

/// Response of `GET /api/tv/home` (`tv-catalog.ts:74-173`): recents (latest
/// tuned, cap 20), favorites (position order), per-country and per-category
/// rails — every card decorated with `now`/`next` from one grouped
/// `loadNowNext` query.
public struct TvHome: Codable, Sendable, Equatable {
    public var recents: [TvChannelCard]
    public var favorites: [TvChannelCard]
    public var countries: [TvCountryRail]
    public var categories: [TvCategoryRail]

    public init(
        recents: [TvChannelCard],
        favorites: [TvChannelCard],
        countries: [TvCountryRail],
        categories: [TvCategoryRail]
    ) {
        self.recents = recents
        self.favorites = favorites
        self.countries = countries
        self.categories = categories
    }
}

/// Response of `GET /api/tv/guide` (`tv-catalog.ts:185-227`): an offset-paged
/// channel list, each card decorated with `now`/`next`. `offset`/`limit`
/// mirror the request's resolved paging (the route always echoes both, but
/// they're modeled `Optional` per this file's decode-safety stance).
public struct TvGuideResponse: Codable, Sendable, Equatable {
    public var total: Int
    public var offset: Int?
    public var limit: Int?
    public var channels: [TvChannelCard]

    public init(total: Int, offset: Int? = nil, limit: Int? = nil, channels: [TvChannelCard]) {
        self.total = total
        self.offset = offset
        self.limit = limit
        self.channels = channels
    }
}

/// One programme in a `TvGridChannel`'s time window (`loadProgrammeWindow` in
/// `apps/api/src/lib/tv-grid.ts:3-9`) — distinct from `TvProgrammeSlot`: the
/// grid shows every programme intersecting the window, not just now/next.
public struct TvGridProgramme: Codable, Sendable, Equatable {
    public var id: String
    public var title: String
    public var start: String
    public var stop: String
    public var category: String?

    public init(id: String, title: String, start: String, stop: String, category: String? = nil) {
        self.id = id
        self.title = title
        self.start = start
        self.stop = stop
        self.category = category
    }
}

/// One row of `/tv/grid`'s time×channel guide (`tv-catalog.ts:297-300`): the
/// same card fields as `TvChannelCard` **minus** `now`/`next` (the grid never
/// decorates rows with now/next — `loadProgrammeWindow` covers the whole
/// window instead) **plus** the channel's `programmes` in that window.
public struct TvGridChannel: Codable, Sendable, Equatable {
    public var id: String
    public var number: Int
    public var name: String
    public var country: String?
    public var categories: [String]
    public var quality: String?
    public var logo: String?
    public var healthy: Bool
    public var favorite: Bool
    public var programmes: [TvGridProgramme]

    public init(
        id: String,
        number: Int,
        name: String,
        country: String? = nil,
        categories: [String],
        quality: String? = nil,
        logo: String? = nil,
        healthy: Bool,
        favorite: Bool,
        programmes: [TvGridProgramme]
    ) {
        self.id = id
        self.number = number
        self.name = name
        self.country = country
        self.categories = categories
        self.quality = quality
        self.logo = logo
        self.healthy = healthy
        self.favorite = favorite
        self.programmes = programmes
    }
}

/// Response of `GET /api/tv/grid` (`tv-catalog.ts:243-302`): an offset-paged
/// channel list windowed to `[start, start + hours)`, each row carrying its
/// own `programmes` in that window rather than a now/next pair.
public struct TvGridResponse: Codable, Sendable, Equatable {
    public var start: String
    public var hours: Int
    public var total: Int
    public var offset: Int?
    public var limit: Int?
    public var channels: [TvGridChannel]

    public init(
        start: String,
        hours: Int,
        total: Int,
        offset: Int? = nil,
        limit: Int? = nil,
        channels: [TvGridChannel]
    ) {
        self.start = start
        self.hours = hours
        self.total = total
        self.offset = offset
        self.limit = limit
        self.channels = channels
    }
}

/// now/next pair returned by `GET /api/tv/channels/:id/play`
/// (`tv-play.ts:127`) — always present as a key, either slot may be `null`.
public struct TvNowNext: Codable, Sendable, Equatable {
    public var now: TvProgrammeSlot?
    public var next: TvProgrammeSlot?

    public init(now: TvProgrammeSlot? = nil, next: TvProgrammeSlot? = nil) {
        self.now = now
        self.next = next
    }
}

/// One ordered playable source from `GET /api/tv/channels/:id/play`
/// (`tv-play.ts:147-152`). `src` is a same-origin proxy URL
/// (`/api/tv/proxy/<streamId>/index.m3u8`); for a bearer-authenticated
/// request it carries a `?token=` suffix so the native player's subsequent
/// segment fetches (no headers) don't 401 (`tv-play.ts:133-135,149`) — a
/// cookie-authenticated request's `src` has no `?token=` at all
/// (`tv-play.test.ts:405-423`).
public struct TvPlaySource: Codable, Sendable, Equatable {
    public var streamId: String
    public var src: String
    public var quality: String?
    public var label: String?

    public init(streamId: String, src: String, quality: String? = nil, label: String? = nil) {
        self.streamId = streamId
        self.src = src
        self.quality = quality
        self.label = label
    }
}

/// The channel summary nested in `TvPlayResponse` (`tv-play.ts:138-145`) —
/// narrower than `TvChannelCard`/`TvChannelDetail` (no `categories`,
/// `healthy`, `favorite`, ...): only what the player chrome needs.
public struct TvPlayChannel: Codable, Sendable, Equatable {
    public var id: String
    public var number: Int
    public var name: String
    public var logo: String?
    public var country: String?
    public var quality: String?

    public init(
        id: String,
        number: Int,
        name: String,
        logo: String? = nil,
        country: String? = nil,
        quality: String? = nil
    ) {
        self.id = id
        self.number = number
        self.name = name
        self.logo = logo
        self.country = country
        self.quality = quality
    }
}

/// Response of `GET /api/tv/channels/:id/play` (`tv-play.ts:137-153`) — the
/// tune negotiation: channel summary, now/next, and up to 3 ordered proxied
/// sources (`MAX_SOURCES` in `tv-play.ts:19`).
public struct TvPlayResponse: Codable, Sendable, Equatable {
    public var channel: TvPlayChannel
    public var nowNext: TvNowNext
    public var sources: [TvPlaySource]

    public init(channel: TvPlayChannel, nowNext: TvNowNext, sources: [TvPlaySource]) {
        self.channel = channel
        self.nowNext = nowNext
        self.sources = sources
    }
}

/// One of a channel's upstream sources (`GET /api/tv/channels/:id`,
/// `tv-catalog.ts:355-362`), ordered by `priority` ascending. **`protocol`
/// is a Swift keyword**: the stored property is declared backticked
/// (`` `protocol` ``) — Codable's synthesized `CodingKeys` still map it to
/// the JSON key `"protocol"` correctly, so no custom `CodingKeys` is needed.
/// Stream URLs themselves are deliberately not exposed on this DTO —
/// playback always goes through the phase-2 proxy (see the handler's doc
/// comment on why `streams.map` omits `url`).
public struct TvStreamRef: Codable, Sendable, Equatable {
    public var id: String
    public var quality: String?
    public var label: String?
    public var `protocol`: String
    public var status: String
    public var priority: Int

    public init(
        id: String,
        quality: String? = nil,
        label: String? = nil,
        protocol: String,
        status: String,
        priority: Int
    ) {
        self.id = id
        self.quality = quality
        self.label = label
        self.protocol = `protocol`
        self.status = status
        self.priority = priority
    }
}

/// Response of `GET /api/tv/channels/:id` (`tv-catalog.ts:339-363`) — full
/// channel detail incl. its ordered `streams`. **404** `{error:"not_found"}`
/// when the channel is missing or hidden (surfaced as `OrbixError.http(404)`
/// by `perform`, same as any other 404).
public struct TvChannelDetail: Codable, Sendable, Equatable {
    public var id: String
    public var number: Int
    public var name: String
    public var rawName: String?
    public var country: String?
    public var languages: [String]
    public var categories: [String]
    public var website: String?
    public var epgId: String?
    public var quality: String?
    public var logo: String?
    public var healthy: Bool
    public var favorite: Bool
    public var streams: [TvStreamRef]

    public init(
        id: String,
        number: Int,
        name: String,
        rawName: String? = nil,
        country: String? = nil,
        languages: [String],
        categories: [String],
        website: String? = nil,
        epgId: String? = nil,
        quality: String? = nil,
        logo: String? = nil,
        healthy: Bool,
        favorite: Bool,
        streams: [TvStreamRef]
    ) {
        self.id = id
        self.number = number
        self.name = name
        self.rawName = rawName
        self.country = country
        self.languages = languages
        self.categories = categories
        self.website = website
        self.epgId = epgId
        self.quality = quality
        self.logo = logo
        self.healthy = healthy
        self.favorite = favorite
        self.streams = streams
    }
}

/// One entry of a channel's day schedule (`GET /api/tv/channels/:id/
/// programmes?day=`, `tv-catalog.ts:389-396`). **400** `{error:"invalid_day"}`
/// on a malformed `day`; **404** for a hidden/missing channel.
public struct TvProgramme: Codable, Sendable, Equatable {
    public var id: String
    public var start: String
    public var stop: String
    public var title: String
    public var description: String?
    public var category: String?

    public init(
        id: String,
        start: String,
        stop: String,
        title: String,
        description: String? = nil,
        category: String? = nil
    ) {
        self.id = id
        self.start = start
        self.stop = stop
        self.title = title
        self.description = description
        self.category = category
    }
}

/// Response of `GET /api/tv/channels/:id/programmes`: `{programmes: [...]}`
/// (`tv-catalog.ts:394-396`).
public struct TvProgrammesResponse: Codable, Sendable, Equatable {
    public var programmes: [TvProgramme]

    public init(programmes: [TvProgramme]) {
        self.programmes = programmes
    }
}

/// Response of `GET /api/tv/favorites` (`tv-catalog.ts:438-450`):
/// `{favorites: [...]}`, each card a **plain** `toCard()` with no `now`/
/// `next` keys at all (no `dec` decoration on this route) — decodes to `nil`
/// on `TvChannelCard.now`/`.next` the same way an explicit `null` would.
/// `{favorites: []}` when no profile is active.
public struct TvFavoritesResponse: Codable, Sendable, Equatable {
    public var favorites: [TvChannelCard]

    public init(favorites: [TvChannelCard]) {
        self.favorites = favorites
    }
}
