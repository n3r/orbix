import Foundation

/// Actor-isolated HTTP client for the Orbix API. Every request is relative to
/// `baseURL`; `/health` is at the root (see `apps/api/src/routes/health.ts`),
/// everything else is under `api/...` (see `apps/api/src/app.ts`'s `{ prefix:
/// "/api" }` registration). When a token is set, requests attach
/// `Authorization: Bearer <token>` (see `apps/api/src/plugins/session.ts`).
public actor OrbixClient {
    private let baseURL: URL
    private var token: String?
    private let session: URLSession
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder
    private var unauthorizedHandler: (@MainActor @Sendable () -> Void)?

    public init(baseURL: URL, token: String? = nil, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
        self.encoder = JSONEncoder()
        self.decoder = JSONDecoder()
    }

    public func setToken(_ token: String?) {
        self.token = token
    }

    public func setUnauthorizedHandler(_ handler: (@MainActor @Sendable () -> Void)?) {
        unauthorizedHandler = handler
    }

    // MARK: - Health

    /// `GET /health` (root-level, no `/api` prefix, no auth required).
    public func serverReachable() async -> Bool {
        do {
            let (_, http) = try await perform(method: "GET", url: baseURL.appending(path: "health"))
            return http.statusCode == 200
        } catch {
            return false
        }
    }

    // MARK: - Pairing

    /// `POST /api/pair/initiate` — unauthenticated; the TV displays `code`
    /// while polling `pollToken` for approval.
    public func pairInitiate(name: String, platform: String = "tvos") async throws -> PairInitiateResponse {
        struct Body: Encodable {
            let name: String
            let platform: String
        }
        let data = try encodeBody(Body(name: name, platform: platform))
        return try await send(method: "POST", url: baseURL.appending(path: "api/pair/initiate"), body: data)
    }

    /// `GET /api/pair/poll?token=...` — unauthenticated; redeems once approved.
    public func pairPoll(pollToken: String) async throws -> PairPollResponse {
        let url = baseURL
            .appending(path: "api/pair/poll")
            .appending(queryItems: [URLQueryItem(name: "token", value: pollToken)])
        return try await send(method: "GET", url: url)
    }

    // MARK: - Profiles

    /// `GET /api/me/profile` — the session's (or this bearer device's)
    /// currently-active profile, or an all-null `MeProfile` if none is
    /// selected yet. `AppModel` uses `id != nil` to decide `.ready` vs
    /// `.needsProfile` once a token is resolved.
    public func meProfile() async throws -> MeProfile {
        try await send(method: "GET", url: baseURL.appending(path: "api/me/profile"))
    }

    /// `GET /api/profiles`.
    public func profiles() async throws -> [Profile] {
        try await send(method: "GET", url: baseURL.appending(path: "api/profiles"))
    }

    /// `POST /api/profiles/:id/select`. Locked profiles require a four-digit
    /// PIN; the server answers 403 for missing/invalid PINs.
    public func selectProfile(id: String, pin: String? = nil) async throws {
        struct Body: Encodable {
            let pin: String?
        }
        let data = try encodeBody(Body(pin: pin))
        do {
            _ = try await perform(
                method: "POST",
                url: baseURL.appending(path: "api/profiles/\(id)/select"),
                body: data
            )
        } catch {
            if let orbixError = error as? OrbixError, case .http(403) = orbixError {
                throw ProfileSelectionError.pinRequired
            }
            throw error
        }
    }

    // MARK: - Discovery

    /// `GET /api/home/rows`.
    public func homeRows() async throws -> HomeRows {
        try await send(method: "GET", url: baseURL.appending(path: "api/home/rows"))
    }

    /// `GET /api/me/menu` — active profile's enabled libraries/categories.
    public func menu() async throws -> [MenuLibrary] {
        let response: MenuResponse = try await send(method: "GET", url: baseURL.appending(path: "api/me/menu"))
        return response.items
    }

    /// `GET /api/libraries/:id/items?sort=&q=` — a profile-filtered library
    /// grid. The server accepts exactly `title`, `added`, and `year`.
    public func libraryItems(
        libraryId: String,
        sort: LibrarySort = .title,
        query: String? = nil
    ) async throws -> [MediaCard] {
        var queryItems = [URLQueryItem(name: "sort", value: sort.rawValue)]
        if let query = query?.trimmingCharacters(in: .whitespacesAndNewlines), !query.isEmpty {
            queryItems.append(URLQueryItem(name: "q", value: query))
        }
        return try await send(
            method: "GET",
            url: baseURL
                .appending(path: "api/libraries/\(libraryId)/items")
                .appending(queryItems: queryItems)
        )
    }

    /// `GET /api/search?q=<query>` (see `apps/api/src/routes/discovery.ts`'s
    /// `/search` route) → `{items: [...], usedEmbeddings: boolean}`,
    /// unwrapped to the bare array — same convention as `similar(id:)` —
    /// since no caller needs `usedEmbeddings` yet. `query` is percent-encoded
    /// by `URL.appending(queryItems:)`, so callers pass the raw typed text
    /// (spaces, punctuation, non-ASCII) verbatim; an empty string is still a
    /// well-formed request — the route treats "no residual text" as
    /// "sort by recency/title" rather than erroring — but `SearchModel`
    /// (the tvOS search screen) never actually calls this for an empty
    /// query, since a blank search box has nothing worth showing results for.
    public func search(query: String) async throws -> [MediaCard] {
        let url = baseURL
            .appending(path: "api/search")
            .appending(queryItems: [URLQueryItem(name: "q", value: query)])
        let response: SearchResponse = try await send(method: "GET", url: url)
        return response.items
    }

    // MARK: - Item detail

    /// `GET /api/items/:id` — full item detail (movie or series; see
    /// `ItemDetail`'s doc comment for the field-by-field shape). A
    /// kids-blocked or missing id 404s (`apps/api/src/routes/catalog.ts`);
    /// callers surface that as a graceful "not available" rather than a
    /// crash — see `TitleModel.load`.
    public func itemDetail(id: String) async throws -> ItemDetail {
        try await send(method: "GET", url: baseURL.appending(path: "api/items/\(id)"))
    }

    /// `GET /api/items/:id/similar` → `{items: [...]}` (see
    /// `apps/api/src/routes/similar.ts`); unwrapped to the bare array since
    /// nothing else on the envelope is needed. A kids-blocked or missing
    /// anchor id 404s, same as `itemDetail`.
    public func similar(id: String) async throws -> [MediaCard] {
        let response: SimilarResponse = try await send(
            method: "GET",
            url: baseURL.appending(path: "api/items/\(id)/similar")
        )
        return response.items
    }

    // MARK: - Wishlist

    /// `GET /api/wishlist` — active profile's saved titles, already
    /// kids-filtered server-side.
    public func wishlist() async throws -> [MediaCard] {
        try await send(method: "GET", url: baseURL.appending(path: "api/wishlist"))
    }

    /// `GET /api/wishlist/ids` — visible saved item ids for toggle state.
    public func wishlistIds() async throws -> [String] {
        let response: WishlistIdsResponse = try await send(
            method: "GET",
            url: baseURL.appending(path: "api/wishlist/ids")
        )
        return response.ids
    }

    /// `POST /api/wishlist/:itemId` — idempotent add.
    public func addToWishlist(itemId: String) async throws {
        _ = try await perform(method: "POST", url: baseURL.appending(path: "api/wishlist/\(itemId)"))
    }

    /// `DELETE /api/wishlist/:itemId` — idempotent remove.
    public func removeFromWishlist(itemId: String) async throws {
        _ = try await perform(method: "DELETE", url: baseURL.appending(path: "api/wishlist/\(itemId)"))
    }

    /// `GET /api/items/:id` → the ids of its playable files, "best copy
    /// first" per the server's `orderBy` (see
    /// `apps/api/src/routes/catalog.ts`). The M1 spike played `files[0]`;
    /// kept as a thin convenience over `itemDetail(id:)` for any caller that
    /// only wants file ids — `files` is `Optional` on `ItemDetail`, hence
    /// the `?? []`, not because this is expected to actually be missing.
    public func itemFileIds(id: String) async throws -> [String] {
        let detail = try await itemDetail(id: id)
        return detail.files?.map(\.id) ?? []
    }

    // MARK: - Episodes (series)

    /// `GET /api/items/:id/seasons/:n/episodes` (see
    /// `apps/api/src/routes/series.ts`) — one season's episode list, each
    /// carrying its owned `fileId` (`nil` when not in the library) and the
    /// active profile's per-episode progress. Unwrapped to the bare array
    /// since nothing else on the envelope is needed (same convention as
    /// `similar(id:)`). A series id that doesn't exist, or is kids-blocked
    /// (episodes inherit the series rating), 404s; an unknown season number
    /// does not — it decodes to an empty array (see `EpisodesResponse`'s
    /// doc comment).
    public func episodes(itemId: String, season: Int) async throws -> [Episode] {
        let response: EpisodesResponse = try await send(
            method: "GET",
            url: baseURL.appending(path: "api/items/\(itemId)/seasons/\(season)/episodes")
        )
        return response.episodes
    }

    // MARK: - Playback

    /// `POST /api/playback/info`.
    public func playbackInfo(
        fileId: String,
        capabilities: Capabilities,
        audioTrackIndex: Int? = nil
    ) async throws -> PlaybackInfo {
        let body = PlaybackInfoRequest(fileId: fileId, capabilities: capabilities, audioTrackIndex: audioTrackIndex)
        let data = try encodeBody(body)
        return try await send(method: "POST", url: baseURL.appending(path: "api/playback/info"), body: data)
    }

    // MARK: - Playback progress

    /// `GET /api/items/:id/progress` (+ `?episodeId=` for a series episode;
    /// see `apps/api/src/routes/playstate.ts`). A movie passes
    /// `episodeId: nil`, which omits the query param entirely — the
    /// route's own default for a missing key (`req.query.episodeId ?? ""`)
    /// is the same empty-string column value a movie's row uses.
    public func getProgress(itemId: String, episodeId: String? = nil) async throws -> ProgressState {
        var url = baseURL.appending(path: "api/items/\(itemId)/progress")
        if let episodeId, !episodeId.isEmpty {
            url = url.appending(queryItems: [URLQueryItem(name: "episodeId", value: episodeId)])
        }
        return try await send(method: "GET", url: url)
    }

    /// `PUT /api/items/:id/progress` (see `apps/api/src/routes/playstate.ts`):
    /// upserts the active profile's playback position. `positionSec`/
    /// `durationSec` are sent as-is — the route floors them for its `Int`
    /// columns, since a player reports fractional seconds — and
    /// `episodeId`/`playSessionId` are omitted from the wire entirely when
    /// `nil` (Codable's synthesized `encode(to:)` uses `encodeIfPresent`
    /// for `Optional` stored properties), which the route treats identically
    /// to an absent key.
    public func putProgress(
        itemId: String,
        positionSec: Double,
        durationSec: Double,
        episodeId: String? = nil,
        playSessionId: String? = nil
    ) async throws {
        struct Body: Encodable {
            let positionSec: Double
            let durationSec: Double
            let episodeId: String?
            let playSessionId: String?
        }
        let data = try encodeBody(
            Body(positionSec: positionSec, durationSec: durationSec, episodeId: episodeId, playSessionId: playSessionId)
        )
        _ = try await perform(method: "PUT", url: baseURL.appending(path: "api/items/\(itemId)/progress"), body: data)
    }

    /// `POST /api/playback/:playSessionId/stop` (see
    /// `apps/api/src/routes/playback.ts`) — idempotent early teardown of a
    /// play session. Best-effort by design (`async`, not `async throws`):
    /// called from the player's teardown path, where there's no one left to
    /// show a network error to (a `navigator.sendBeacon`-equivalent), so a
    /// failure here is swallowed rather than thrown.
    public func stopPlayback(playSessionId: String) async {
        _ = try? await perform(method: "POST", url: baseURL.appending(path: "api/playback/\(playSessionId)/stop"))
    }

    // MARK: - Request plumbing

    private func encodeBody<T: Encodable>(_ value: T) throws -> Data {
        do {
            return try encoder.encode(value)
        } catch {
            // There's no separate "encoding" case on OrbixError: failing to
            // serialize our own outgoing request is the same class of codec
            // failure as failing to parse the server's response.
            throw OrbixError.decoding(error)
        }
    }

    private func send<Response: Decodable>(method: String, url: URL, body: Data? = nil) async throws -> Response {
        let (data, _) = try await perform(method: method, url: url, body: body)
        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw OrbixError.decoding(error)
        }
    }

    @discardableResult
    private func perform(method: String, url: URL, body: Data? = nil) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw OrbixError.transport(error)
        }
        guard let http = response as? HTTPURLResponse else {
            throw OrbixError.transport(URLError(.badServerResponse))
        }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401, let unauthorizedHandler {
                await unauthorizedHandler()
            }
            throw OrbixError.http(http.statusCode)
        }
        return (data, http)
    }
}

/// Errors surfaced by `OrbixClient`.
///
/// `@unchecked Sendable`: the wrapped `Error` existential (from `URLSession`
/// transport failures or `JSONEncoder`/`JSONDecoder` codec failures) isn't
/// itself guaranteed to conform to `Sendable`, but it is only ever read for
/// diagnostics after being thrown — never mutated or shared — so moving it
/// across an actor boundary as part of a thrown `OrbixError` is safe.
public enum OrbixError: Error, @unchecked Sendable {
    case http(Int)
    case decoding(Error)
    case transport(Error)
}

public enum ProfileSelectionError: Error, Sendable, Equatable {
    case pinRequired
}
