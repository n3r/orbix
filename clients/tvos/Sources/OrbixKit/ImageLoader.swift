import Foundation
import CryptoKit

/// Loads and caches poster/backdrop images from the Orbix API. Callers build
/// the absolute URL as `baseURL/api/images/<posterPath>` — a public,
/// unauthenticated route (see `apps/api/src/routes/images.ts`) — this actor
/// just fetches + caches whatever URL it's handed.
public actor ImageLoader {
    private var memoryCache: [URL: Data] = [:]
    private let session: URLSession
    private let fileManager: FileManager
    private let cacheDirectory: URL

    public init(session: URLSession = .shared, fileManager: FileManager = .default) {
        self.session = session
        self.fileManager = fileManager
        let caches = fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        let directory = caches.appendingPathComponent("dev.orbix.tvos.images", isDirectory: true)
        try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        self.cacheDirectory = directory
    }

    /// Returns the image bytes for `url`: in-memory cache, then on-disk
    /// cache, then a network fetch (cached back to both on success). `nil`
    /// on any failure (offline, 404, ...) — callers fall back to a placeholder.
    public func image(for url: URL) async -> Data? {
        if let cached = memoryCache[url] {
            return cached
        }

        let diskURL = diskCacheURL(for: url)
        if let data = try? Data(contentsOf: diskURL) {
            memoryCache[url] = data
            return data
        }

        guard let data = try? await fetch(url) else { return nil }
        memoryCache[url] = data
        try? data.write(to: diskURL, options: .atomic)
        return data
    }

    private func fetch(_ url: URL) async throws -> Data {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return data
    }

    /// A stable, filesystem-safe cache filename derived from the URL.
    private func diskCacheURL(for url: URL) -> URL {
        let digest = SHA256.hash(data: Data(url.absoluteString.utf8))
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        return cacheDirectory.appendingPathComponent(hex)
    }
}
