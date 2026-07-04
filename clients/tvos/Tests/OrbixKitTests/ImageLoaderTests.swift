import XCTest
@testable import OrbixKit

/// Covers the M3 Task 1 ImageLoader bounding: an injected `Fetcher` lets
/// this assert the in-flight-coalescing behavior (two concurrent misses for
/// the same URL share one network fetch) without a real network call. The
/// `NSCache`/prune bounding itself isn't separately unit-tested — both are
/// thin wrappers around well-understood system APIs (`NSCache.countLimit`,
/// `FileManager` directory listing + removal) where the coalescing logic is
/// the one piece of this actor with real (get-it-wrong-and-it-race-conditions)
/// behavior worth locking down.
final class ImageLoaderTests: XCTestCase {
    func testConcurrentMissesForSameURLCoalesceToOneFetch() async throws {
        // A fresh, never-seen-before URL per run: the disk cache persists
        // across test runs on the same machine (real Caches directory), so
        // a fixed literal URL would hit the disk-cache fast path (and
        // invoke the fetcher zero times) on any run after the first.
        let url = URL(string: "https://example.com/poster-\(UUID().uuidString).jpg")!
        let expectedBytes = Data("fake-poster-bytes".utf8)
        let counter = FetchCounter()

        let loader = ImageLoader(fetcher: { _ in
            await counter.increment()
            // Hold both callers' first checks (memory/disk/inFlight) inside
            // the fetch window, so the test actually exercises concurrent
            // misses rather than the second call arriving after the first
            // already completed and populated the memory cache.
            try await Task.sleep(nanoseconds: 50_000_000)
            return expectedBytes
        })

        async let first = loader.image(for: url)
        async let second = loader.image(for: url)
        let (firstResult, secondResult) = await (first, second)

        XCTAssertEqual(firstResult, expectedBytes)
        XCTAssertEqual(secondResult, expectedBytes)
        let fetchCount = await counter.count
        XCTAssertEqual(fetchCount, 1, "expected two concurrent misses to coalesce into exactly one fetch")
    }

    func testSubsequentCallAfterCompletionHitsCacheNotFetcher() async throws {
        // Once the first fetch has fully completed (and populated the
        // memory cache), a later call for the same URL must not re-invoke
        // the fetcher at all — this is the ordinary cache-hit path, as
        // distinct from the in-flight-coalescing path above.
        let url = URL(string: "https://example.com/poster-\(UUID().uuidString).jpg")!
        let expectedBytes = Data("fake-poster-bytes-2".utf8)
        let counter = FetchCounter()

        let loader = ImageLoader(fetcher: { _ in
            await counter.increment()
            return expectedBytes
        })

        let firstResult = await loader.image(for: url)
        let secondResult = await loader.image(for: url)

        XCTAssertEqual(firstResult, expectedBytes)
        XCTAssertEqual(secondResult, expectedBytes)
        let fetchCount = await counter.count
        XCTAssertEqual(fetchCount, 1, "expected a cache hit to avoid a second fetch")
    }
}

/// A tiny actor rather than a plain `var` so incrementing from the
/// `@Sendable` fetcher closure (invoked on whatever executor `Task` picks)
/// is race-free.
private actor FetchCounter {
    private(set) var count = 0

    func increment() {
        count += 1
    }
}
