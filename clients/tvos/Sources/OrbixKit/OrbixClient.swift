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

    /// `POST /api/profiles/:id/select`. The response body is `{ profileId }`;
    /// callers only need success/failure, hence `Void` rather than a decoded type.
    public func selectProfile(id: String) async throws {
        _ = try await perform(
            method: "POST",
            url: baseURL.appending(path: "api/profiles/\(id)/select"),
            body: Data("{}".utf8)
        )
    }

    // MARK: - Discovery

    /// `GET /api/home/rows`.
    public func homeRows() async throws -> HomeRows {
        try await send(method: "GET", url: baseURL.appending(path: "api/home/rows"))
    }

    // MARK: - Item detail

    /// `GET /api/items/:id` → the ids of its playable files, "best copy
    /// first" per the server's `orderBy` (see
    /// `apps/api/src/routes/catalog.ts`). The M1 spike plays `files[0]`.
    public func itemFileIds(id: String) async throws -> [String] {
        let detail: ItemDetail = try await send(method: "GET", url: baseURL.appending(path: "api/items/\(id)"))
        return detail.files.map(\.id)
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
