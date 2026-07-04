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

/// Decodes the common fields of a home-row / catalog item. The server's rows
/// include several other fields (backdropPath, addedAt, progress, resume,
/// ...) that are simply ignored by Codable's synthesized `init(from:)`.
public struct MediaCard: Codable, Sendable, Equatable {
    public var id: String
    public var title: String
    public var year: Int?
    public var posterPath: String?

    public init(id: String, title: String, year: Int? = nil, posterPath: String? = nil) {
        self.id = id
        self.title = title
        self.year = year
        self.posterPath = posterPath
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

/// Minimal decode target for `GET /api/items/:id`. The M1 playback spike
/// only needs the ids of the item's playable files — `files[0]` is "best
/// copy first" per the server's `orderBy` (height/bitrate desc, see
/// `apps/api/src/routes/catalog.ts`) — so every other field on the full
/// item-detail response (title, seasons, cast, ratings, ...) is simply
/// ignored by Codable's synthesized `init(from:)`.
public struct ItemDetail: Codable, Sendable, Equatable {
    public struct FileRef: Codable, Sendable, Equatable {
        public var id: String

        public init(id: String) {
            self.id = id
        }
    }

    public var files: [FileRef]

    public init(files: [FileRef]) {
        self.files = files
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
