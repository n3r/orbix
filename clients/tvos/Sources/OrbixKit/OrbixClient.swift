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
    public func pairInitiate(name: String) async throws -> PairInitiateResponse {
        struct Body: Encodable {
            let name: String
            let platform: String
        }
        let data = try encodeBody(Body(name: name, platform: "tvos"))
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

    /// `POST /api/profiles` — creates a new profile. `kind` is hardcoded to
    /// `"standard"` on the wire (see `apps/web/src/pages/ProfilesPage.tsx`'s
    /// `{name: newName, kind: "standard", language: newLanguage}` — parity
    /// with the web client, which never lets a user create a kids profile
    /// from this form). The route's `select` omits `avatar`/`maturityCap`
    /// entirely (see `apps/api/src/routes/profiles.ts`'s
    /// `select: { id: true, name: true, kind: true, language: true }`),
    /// which decode to `nil` on the shared `Profile` DTO since both are
    /// already `Optional` there.
    public func createProfile(name: String, language: String) async throws -> Profile {
        struct Body: Encodable {
            let name: String
            let kind: String
            let language: String
        }
        let data = try encodeBody(Body(name: name, kind: "standard", language: language))
        return try await send(method: "POST", url: baseURL.appending(path: "api/profiles"), body: data)
    }

    /// `PATCH /api/profiles/:id` body `{language}`. This branch's handler
    /// selects only `{id,name,kind,language}` in its response (`avatar`/
    /// `maturityCap`/`hasPin` decode to `nil` on the shared `Profile` DTO,
    /// same convention as `createProfile`); `origin/main`'s
    /// `serializeProfile` sends the full shape, which also decodes cleanly.
    /// The handler triggers `ensureMetadataLanguage` server-side — the
    /// catalog re-localization the web client relies on for language
    /// switches. **400** `{error:"invalid_profile"}` on a non-supported
    /// language; **404** `{error:"not_found"}` for an unknown id.
    public func updateProfile(id: String, language: String) async throws -> Profile {
        struct Body: Encodable {
            let language: String
        }
        let data = try encodeBody(Body(language: language))
        return try await send(method: "PATCH", url: baseURL.appending(path: "api/profiles/\(id)"), body: data)
    }

    /// `POST /api/profiles/:id/select` body `{}` or `{pin}`. `pin` is
    /// omitted from the wire when `nil` (Codable's synthesized
    /// `encodeIfPresent` for an `Optional` stored property), so the default
    /// `nil` still encodes to the same `{}` body this method sent before it
    /// gained this parameter. The response body is `{ profileId }`; callers
    /// only need success/failure, hence `Void` rather than a decoded type.
    /// **403** `{error:"pin_required"}` when the profile has a pin and the
    /// supplied pin is missing or wrong (same code both cases, both wires).
    public func selectProfile(id: String, pin: String? = nil) async throws {
        struct Body: Encodable {
            let pin: String?
        }
        let data = try encodeBody(Body(pin: pin))
        _ = try await perform(
            method: "POST",
            url: baseURL.appending(path: "api/profiles/\(id)/select"),
            body: data
        )
    }

    // MARK: - Menu

    /// `GET /api/me/menu` (see `apps/api/src/routes/menu.ts`) — the active
    /// profile's resolved nav categories, one per enabled library, in
    /// display order. Unwrapped to the bare array from the `{items: [...]}`
    /// envelope, same convention as `similar(id:)`/`search(query:)`.
    public func menu() async throws -> [MenuItem] {
        let response: MenuResponse = try await send(method: "GET", url: baseURL.appending(path: "api/me/menu"))
        return response.items
    }

    /// `GET /api/me/menu/config` (see `menu.ts:30-38`) — every library
    /// (unfiltered) plus the active profile's ordered enabled ids, for the
    /// menu editor screen.
    public func menuConfig() async throws -> MenuConfig {
        try await send(method: "GET", url: baseURL.appending(path: "api/me/menu/config"))
    }

    /// `PUT /api/me/menu` body `{libraryIds}` (see `menu.ts:40-77`) —
    /// replaces the active profile's ordered enabled libraries. Unwrapped to
    /// the bare array from the `{items: [...]}` envelope (reusing
    /// `MenuResponse`), same convention as `menu()`. The server rejects an
    /// empty array (**400** `{error:"empty"}` — zero entries would mean
    /// "show all", so an empty save can't represent "show nothing"),
    /// duplicate ids (`{error:"duplicate"}`), and unknown ids
    /// (`{error:"unknown_library"}`); no active profile is
    /// `{error:"no_active_profile"}`.
    public func saveMenu(libraryIds: [String]) async throws -> [MenuItem] {
        struct Body: Encodable {
            let libraryIds: [String]
        }
        let data = try encodeBody(Body(libraryIds: libraryIds))
        let response: MenuResponse = try await send(method: "PUT", url: baseURL.appending(path: "api/me/menu"), body: data)
        return response.items
    }

    // MARK: - Discovery

    /// `GET /api/home/rows`.
    public func homeRows() async throws -> HomeRows {
        try await send(method: "GET", url: baseURL.appending(path: "api/home/rows"))
    }

    /// `GET /api/search?q=<query>` (see `apps/api/src/routes/discovery.ts`'s
    /// `/search` route) → `{items: [...], usedEmbeddings: boolean}`. Returns
    /// the full envelope (Phase 2 Task 1) rather than unwrapping to the bare
    /// array, so callers can read `usedEmbeddings` — surfacing it in the UI
    /// is Task 6. `query` is percent-encoded by `URL.appending(queryItems:)`,
    /// so callers pass the raw typed text (spaces, punctuation, non-ASCII)
    /// verbatim; an empty string is still a well-formed request — the route
    /// treats "no residual text" as "sort by recency/title" rather than
    /// erroring — but `SearchModel` (the tvOS search screen) never actually
    /// calls this for an empty query, since a blank search box has nothing
    /// worth showing results for.
    public func search(query: String) async throws -> SearchResponse {
        let url = baseURL
            .appending(path: "api/search")
            .appending(queryItems: [URLQueryItem(name: "q", value: query)])
        return try await send(method: "GET", url: url)
    }

    // MARK: - Library browse

    /// `GET /api/libraries/:id/items?sort=&q=` (see
    /// `apps/api/src/routes/catalog.ts`) — a library's items as poster
    /// cards. Bare array, no envelope. `sort` is one of `title|added|year`
    /// (the server 400s anything else); `q` filters the base title
    /// case-insensitively and is omitted from the wire when nil/empty.
    public func libraryItems(id: String, sort: String = "title", q: String? = nil) async throws -> [MediaCard] {
        var queryItems = [URLQueryItem(name: "sort", value: sort)]
        if let q, !q.isEmpty { queryItems.append(URLQueryItem(name: "q", value: q)) }
        let url = baseURL.appending(path: "api/libraries/\(id)/items").appending(queryItems: queryItems)
        return try await send(method: "GET", url: url)
    }

    // MARK: - Wishlist

    /// `GET /api/wishlist` (see `apps/api/src/routes/wishlist.ts`) — the
    /// active profile's saved titles as poster cards, newest-first. Bare
    /// array.
    public func wishlist() async throws -> [MediaCard] {
        try await send(method: "GET", url: baseURL.appending(path: "api/wishlist"))
    }

    /// `GET /api/wishlist/ids` — membership ids for the title-page toggle
    /// (Phase 3). Unwrapped to the bare array from the `{ids: [...]}`
    /// envelope, same convention as `menu()`.
    public func wishlistIds() async throws -> [String] {
        let response: WishlistIdsResponse = try await send(method: "GET", url: baseURL.appending(path: "api/wishlist/ids"))
        return response.ids
    }

    /// `POST /api/wishlist/:itemId` — idempotent add (404s an
    /// unknown/kids-blocked id).
    public func addToWishlist(itemId: String) async throws {
        _ = try await perform(method: "POST", url: baseURL.appending(path: "api/wishlist/\(itemId)"))
    }

    /// `DELETE /api/wishlist/:itemId` — idempotent remove.
    public func removeFromWishlist(itemId: String) async throws {
        _ = try await perform(method: "DELETE", url: baseURL.appending(path: "api/wishlist/\(itemId)"))
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

    /// `POST /api/playback/info`. `quality`/`audioMode` are omitted from the wire
    /// when nil (initial negotiation) so the server picks its defaults; the
    /// player's Quality / Audio-leveling transport menu passes explicit values
    /// here via `PlaybackController.renegotiate` to switch mid-playback (each
    /// choice mints a fresh play session — see the web player's `renegotiate`
    /// in `apps/web/src/components/Player.tsx` for the equivalent flow).
    public func playbackInfo(
        fileId: String,
        capabilities: Capabilities,
        audioTrackIndex: Int? = nil,
        quality: String? = nil,
        audioMode: String? = nil
    ) async throws -> PlaybackInfo {
        let body = PlaybackInfoRequest(
            fileId: fileId, capabilities: capabilities,
            audioTrackIndex: audioTrackIndex, quality: quality, audioMode: audioMode
        )
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

    // MARK: - Live TV

    /// `GET /api/tv/home` (see `apps/api/src/routes/tv-catalog.ts:74-173`) —
    /// recents/favorites/country/category rails, each card decorated with
    /// now/next.
    public func tvHome() async throws -> TvHome {
        try await send(method: "GET", url: baseURL.appending(path: "api/tv/home"))
    }

    /// `GET /api/tv/guide` (see `tv-catalog.ts:185-227`) — an offset-paged
    /// channel list. Every query param is omitted from the wire when absent
    /// (`nil`/`false`/empty), matching the route's own optional-querystring
    /// handling; `favorites` is only ever sent as `"true"` (never `"false"`),
    /// same convention as the web client's guide query builder.
    public func tvGuide(
        country: String? = nil,
        category: String? = nil,
        favorites: Bool = false,
        q: String? = nil,
        offset: Int? = nil,
        limit: Int? = nil
    ) async throws -> TvGuideResponse {
        var queryItems: [URLQueryItem] = []
        if let country, !country.isEmpty { queryItems.append(URLQueryItem(name: "country", value: country)) }
        if let category, !category.isEmpty { queryItems.append(URLQueryItem(name: "category", value: category)) }
        if favorites { queryItems.append(URLQueryItem(name: "favorites", value: "true")) }
        if let q, !q.isEmpty { queryItems.append(URLQueryItem(name: "q", value: q)) }
        if let offset { queryItems.append(URLQueryItem(name: "offset", value: String(offset))) }
        if let limit { queryItems.append(URLQueryItem(name: "limit", value: String(limit))) }
        var url = baseURL.appending(path: "api/tv/guide")
        if !queryItems.isEmpty { url = url.appending(queryItems: queryItems) }
        return try await send(method: "GET", url: url)
    }

    /// `GET /api/tv/grid` (see `tv-catalog.ts:243-302`) — an offset-paged
    /// channel list windowed to `[start, start + hours)`, each row carrying
    /// its own `programmes` instead of now/next. `start` is an ISO-8601
    /// string (the route parses it with `new Date(...)`, 400ing on a
    /// malformed value); `hours` is clamped server-side
    /// (`GRID_HOURS_MIN`/`MAX`) but sent as-is here. Every other param
    /// follows `tvGuide`'s omit-when-nil/false/empty convention.
    public func tvGrid(
        start: String? = nil,
        hours: Int? = nil,
        country: String? = nil,
        category: String? = nil,
        favorites: Bool = false,
        q: String? = nil,
        offset: Int? = nil,
        limit: Int? = nil
    ) async throws -> TvGridResponse {
        var queryItems: [URLQueryItem] = []
        if let start, !start.isEmpty { queryItems.append(URLQueryItem(name: "start", value: start)) }
        if let hours { queryItems.append(URLQueryItem(name: "hours", value: String(hours))) }
        if let country, !country.isEmpty { queryItems.append(URLQueryItem(name: "country", value: country)) }
        if let category, !category.isEmpty { queryItems.append(URLQueryItem(name: "category", value: category)) }
        if favorites { queryItems.append(URLQueryItem(name: "favorites", value: "true")) }
        if let q, !q.isEmpty { queryItems.append(URLQueryItem(name: "q", value: q)) }
        if let offset { queryItems.append(URLQueryItem(name: "offset", value: String(offset))) }
        if let limit { queryItems.append(URLQueryItem(name: "limit", value: String(limit))) }
        var url = baseURL.appending(path: "api/tv/grid")
        if !queryItems.isEmpty { url = url.appending(queryItems: queryItems) }
        return try await send(method: "GET", url: url)
    }

    /// `GET /api/tv/channels/:id` (see `tv-catalog.ts:305-364`) — full
    /// channel detail incl. ordered `streams`. 404s on a missing/hidden
    /// channel (surfaced as `OrbixError.http(404, code:)`).
    public func tvChannel(id: String) async throws -> TvChannelDetail {
        try await send(method: "GET", url: baseURL.appending(path: "api/tv/channels/\(id)"))
    }

    /// `GET /api/tv/channels/:id/programmes?day=YYYY-MM-DD` (see
    /// `tv-catalog.ts:368-398`) — that (UTC) day's schedule, defaulting
    /// server-side to the current UTC day when `day` is omitted. Unwrapped
    /// to the bare array from the `{programmes: [...]}` envelope, same
    /// convention as `menu()`/`similar(id:)`.
    public func tvProgrammes(id: String, day: String? = nil) async throws -> [TvProgramme] {
        var url = baseURL.appending(path: "api/tv/channels/\(id)/programmes")
        if let day, !day.isEmpty { url = url.appending(queryItems: [URLQueryItem(name: "day", value: day)]) }
        let response: TvProgrammesResponse = try await send(method: "GET", url: url)
        return response.programmes
    }

    /// `GET /api/tv/channels/:id/play` (see `tv-play.ts:103-155`) — the tune
    /// negotiation: channel summary, now/next, and up to 3 ordered proxied
    /// sources. **409** `{error:"no_playable_stream"}` when the channel has
    /// no ordered stream; **404** when missing/hidden.
    public func tvChannelPlay(id: String) async throws -> TvPlayResponse {
        try await send(method: "GET", url: baseURL.appending(path: "api/tv/channels/\(id)/play"))
    }

    /// `GET /api/tv/favorites` (see `tv-catalog.ts:438-450`) — the active
    /// profile's favorite channels, position-ordered, **without** now/next
    /// (plain `toCard()`, no `dec`). Unwrapped to the bare array from the
    /// `{favorites: [...]}` envelope, same convention as `menu()`.
    /// `{favorites: []}` when no profile is active.
    public func tvFavorites() async throws -> [TvChannelCard] {
        let response: TvFavoritesResponse = try await send(method: "GET", url: baseURL.appending(path: "api/tv/favorites"))
        return response.favorites
    }

    /// `PUT /api/tv/favorites/:channelId` (add) or `DELETE` (remove) —
    /// idempotent per the handler (`tv-catalog.ts:403-435`); `DELETE`
    /// responds **204** with no body, which `perform` tolerates since it
    /// never attempts to decode the response data. Throws so the UI's
    /// optimistic favorite toggle can revert on failure (same shape as
    /// `addToWishlist`/`removeFromWishlist`).
    public func setTvFavorite(channelId: String, on: Bool) async throws {
        let url = baseURL.appending(path: "api/tv/favorites/\(channelId)")
        _ = try await perform(method: on ? "PUT" : "DELETE", url: url)
    }

    /// `POST /api/tv/events/:channelId` — fire-and-forget tune log (recents
    /// rail). Best-effort (`async`, not `throws`): the failure is swallowed,
    /// same as `stopPlayback` — a missed recents write must never disrupt
    /// tuning.
    public func postTvEvent(channelId: String) async {
        _ = try? await perform(method: "POST", url: baseURL.appending(path: "api/tv/events/\(channelId)"))
    }

    /// `POST /api/tv/streams/:streamId/health` (see `tv-play.ts:273-300`) —
    /// player health feedback; `code` is the failure reason on `ok == false`.
    /// Best-effort (`async`, not `throws`), same convention as `postTvEvent`.
    public func postTvStreamHealth(streamId: String, ok: Bool, code: String? = nil) async {
        struct Body: Encodable {
            let ok: Bool
            let code: String?
        }
        let data = try? encodeBody(Body(ok: ok, code: code))
        _ = try? await perform(
            method: "POST",
            url: baseURL.appending(path: "api/tv/streams/\(streamId)/health"),
            body: data
        )
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
            throw OrbixError.http(http.statusCode, code: OrbixError.apiCode(from: data))
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
    /// `code` is the machine-readable `{error: "<code>"}` body the API sends
    /// on most non-2xx responses (e.g. "pin_required", "no_active_profile"),
    /// or nil when the body has no such shape. Carried on the same case
    /// (rather than a new one) so the compiler forces every existing
    /// `case .http(N)` match site to acknowledge it — no silent misses.
    case http(Int, code: String?)
    case decoding(Error)
    case transport(Error)

    /// Extracts `{error: "<code>"}` from a non-2xx body. Public + pure so
    /// it's directly unit-testable (perform() itself is private actor API).
    public static func apiCode(from data: Data) -> String? {
        struct ErrorBody: Decodable { let error: String }
        return (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error
    }
}
