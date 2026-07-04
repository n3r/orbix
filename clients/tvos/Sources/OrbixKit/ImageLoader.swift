import Foundation
import CryptoKit

/// Loads and caches poster/backdrop images from the Orbix API. Callers build
/// the absolute URL as `baseURL/api/images/<posterPath>` — a public,
/// unauthenticated route (see `apps/api/src/routes/images.ts`) — this actor
/// just fetches + caches whatever URL it's handed.
///
/// Bounded on both tiers (the M2-review follow-up, "ImageLoader →
/// NSCache/LRU + in-flight coalescing before M3 catalog browse"): the
/// memory tier is an `NSCache` with a `countLimit`, so it evicts under
/// memory pressure and never grows unbounded across a long browsing
/// session's worth of posters/backdrops/avatars; the disk tier keeps
/// everything ever fetched but best-effort prunes back to
/// `diskCacheFileLimit` entries (oldest-by-modification-date first) after
/// every write, rather than growing forever across app runs.
public actor ImageLoader {
    /// A single network fetch: given a URL, return its bytes or throw.
    /// Production uses a `URLSession`-backed default (see `init`); tests
    /// inject a fake here to assert in-flight coalescing without a real
    /// network call.
    public typealias Fetcher = @Sendable (URL) async throws -> Data

    /// tvOS home rails realistically show a few dozen posters on screen at
    /// once plus whatever's been scrolled past this session — 200 in-memory
    /// entries covers that generously without holding an unbounded number
    /// of decoded image `Data` blobs across a long-lived browsing session.
    private static let memoryCountLimit = 200

    /// Simple file-count cap for the disk tier — "best-effort", not a
    /// precise byte budget (see the type doc comment).
    private static let diskCacheFileLimit = 500

    private let memoryCache = NSCache<NSURL, NSData>()
    private let fileManager: FileManager
    private let cacheDirectory: URL
    private let fetcher: Fetcher

    /// In-flight fetch tasks keyed by URL. `image(for:)` checks this after
    /// the memory/disk checks miss and before starting a new fetch, so N
    /// concurrent misses for the same URL share the one `Task` already
    /// underway instead of firing N redundant network requests — actor
    /// isolation makes the check-then-set atomic (see `image(for:)`'s doc
    /// comment for why this is race-free despite the `await` in the middle).
    private var inFlight: [URL: Task<Data?, Never>] = [:]

    public init(session: URLSession = .shared, fileManager: FileManager = .default, fetcher: Fetcher? = nil) {
        self.fileManager = fileManager
        let caches = fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        let directory = caches.appendingPathComponent("dev.orbix.tvos.images", isDirectory: true)
        try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        self.cacheDirectory = directory
        self.memoryCache.countLimit = Self.memoryCountLimit

        if let fetcher {
            self.fetcher = fetcher
        } else {
            // Capture `session` (the parameter, not `self.session` — there
            // is no such stored property) so this closure doesn't need to
            // capture `self` before initialization completes.
            self.fetcher = { url in
                var request = URLRequest(url: url)
                request.httpMethod = "GET"
                let (data, response) = try await session.data(for: request)
                guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                    throw URLError(.badServerResponse)
                }
                return data
            }
        }
    }

    /// Returns the image bytes for `url`: in-memory cache, then on-disk
    /// cache, then a coalesced network fetch (cached back to both on
    /// success). `nil` on any failure (offline, 404, ...) — callers fall
    /// back to a placeholder.
    ///
    /// Race-freedom of the coalescing: everything from the memory-cache
    /// check through registering this call's `Task` in `inFlight` runs with
    /// no `await` in between, so it executes atomically as far as other
    /// callers on this same actor are concerned (Swift actors only yield to
    /// other queued work at a suspension point). A second concurrent miss
    /// for the same `url` therefore always finds either nothing yet (and
    /// becomes the one that creates the `Task`) or the first call's
    /// already-registered `Task` (and just awaits its result) — never a
    /// window where both proceed to fetch independently.
    public func image(for url: URL) async -> Data? {
        let key = url as NSURL
        if let cached = memoryCache.object(forKey: key) {
            return cached as Data
        }

        let diskURL = diskCacheURL(for: url)
        if let data = try? Data(contentsOf: diskURL) {
            memoryCache.setObject(data as NSData, forKey: key)
            return data
        }

        if let existing = inFlight[url] {
            return await existing.value
        }

        let fetcher = self.fetcher
        let task = Task<Data?, Never> {
            try? await fetcher(url)
        }
        inFlight[url] = task

        let data = await task.value
        inFlight[url] = nil

        guard let data else { return nil }
        memoryCache.setObject(data as NSData, forKey: key)
        try? data.write(to: diskURL, options: .atomic)
        pruneDiskCacheIfNeeded()
        return data
    }

    /// Best-effort prune: once the disk cache holds more than
    /// `diskCacheFileLimit` entries, delete the oldest (by modification
    /// date) until back at the cap. Any failure (can't list the directory,
    /// can't read an entry's dates, can't delete) is swallowed — a skipped
    /// prune just means the cache stays a little larger than the cap until
    /// the next successful one; it must never block or fail a fetch.
    private func pruneDiskCacheIfNeeded() {
        guard let entries = try? fileManager.contentsOfDirectory(
            at: cacheDirectory,
            includingPropertiesForKeys: [.contentModificationDateKey]
        ) else { return }
        guard entries.count > Self.diskCacheFileLimit else { return }

        let withDates: [(url: URL, date: Date)] = entries.map { entryURL in
            let date = (try? entryURL.resourceValues(forKeys: [.contentModificationDateKey]))?
                .contentModificationDate ?? .distantPast
            return (entryURL, date)
        }
        let overage = withDates.count - Self.diskCacheFileLimit
        let oldestFirst = withDates.sorted { $0.date < $1.date }
        for entry in oldestFirst.prefix(overage) {
            try? fileManager.removeItem(at: entry.url)
        }
    }

    /// A stable, filesystem-safe cache filename derived from the URL.
    private func diskCacheURL(for url: URL) -> URL {
        let digest = SHA256.hash(data: Data(url.absoluteString.utf8))
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        return cacheDirectory.appendingPathComponent(hex)
    }
}
