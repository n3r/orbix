import XCTest
@testable import OrbixKit

/// Exercises the pure `/api/home/rows` → Top Shelf mapping (`buildTopShelfContent`)
/// and the deep-link helpers, all in OrbixKit with no TVServices/extension
/// process involved — the extension itself is just a thin TVServices bridge
/// over this logic (`OrbixTopShelf/TopShelfContentProvider`).
final class TopShelfContentTests: XCTestCase {
    private let baseURL = URL(string: "http://192.168.1.10:8080")!

    private func home(_ rows: [HomeRow]) -> HomeRows { HomeRows(rows: rows) }

    func testContinueThenRecommendedSections() {
        let content = buildTopShelfContent(
            from: home([
                HomeRow(key: "continue", title: "Continue Watching", items: [
                    MediaCard(id: "a", title: "Arrival", year: 2016, posterPath: "p/a.jpg",
                              progress: .init(positionSec: 300, durationSec: 600)),
                ]),
                HomeRow(key: "tonight", title: "Pick something for tonight", items: [
                    MediaCard(id: "b", title: "Dune", year: 2021, posterPath: "p/b.jpg"),
                ]),
            ]),
            baseURL: baseURL
        )

        XCTAssertEqual(content.sections.map(\.kind), [.continueWatching, .recommended])

        let cw = content.sections[0].items[0]
        XCTAssertEqual(cw.id, "a")
        XCTAssertEqual(cw.title, "Arrival")
        XCTAssertEqual(cw.posterURL, baseURL.appending(path: "api/images/p/a.jpg"))
        XCTAssertEqual(cw.displayURL, URL(string: "orbix://item/a"))
        XCTAssertEqual(cw.playbackProgress, 0.5)

        // A fresh recommendation carries no resume fraction.
        XCTAssertNil(content.sections[1].items[0].playbackProgress)
    }

    func testRecommendedFallsBackToHiddenGems() {
        let content = buildTopShelfContent(
            from: home([
                HomeRow(key: "continue", title: "Continue Watching", items: [MediaCard(id: "a", title: "Arrival")]),
                HomeRow(key: "hiddenGems", title: "Hidden gems", items: [MediaCard(id: "g", title: "Gem")]),
            ]),
            baseURL: baseURL
        )
        XCTAssertEqual(content.sections.map(\.kind), [.continueWatching, .recommended])
        XCTAssertEqual(content.sections[1].items.map(\.id), ["g"])
    }

    func testNoContinueRowStillShowsRecommended() {
        let content = buildTopShelfContent(
            from: home([HomeRow(key: "tonight", title: "Tonight", items: [MediaCard(id: "b", title: "Dune")])]),
            baseURL: baseURL
        )
        XCTAssertEqual(content.sections.map(\.kind), [.recommended])
    }

    func testEmptyRowsProduceNoSections() {
        XCTAssertTrue(buildTopShelfContent(from: home([]), baseURL: baseURL).sections.isEmpty)
    }

    func testItemsAreCappedPerSection() {
        let many = (0..<30).map { MediaCard(id: "\($0)", title: "T\($0)") }
        let content = buildTopShelfContent(
            from: home([HomeRow(key: "continue", title: "CW", items: many)]),
            baseURL: baseURL,
            maxItemsPerSection: 12
        )
        XCTAssertEqual(content.sections[0].items.count, 12)
    }

    func testMissingPosterYieldsNilPosterURL() {
        let content = buildTopShelfContent(
            from: home([HomeRow(key: "continue", title: "CW", items: [MediaCard(id: "a", title: "Arrival", posterPath: nil)])]),
            baseURL: baseURL
        )
        XCTAssertNil(content.sections[0].items[0].posterURL)
    }

    func testZeroDurationProgressIsIgnored() {
        let content = buildTopShelfContent(
            from: home([HomeRow(key: "continue", title: "CW", items: [
                MediaCard(id: "a", title: "Arrival", progress: .init(positionSec: 10, durationSec: 0)),
            ])]),
            baseURL: baseURL
        )
        XCTAssertNil(content.sections[0].items[0].playbackProgress)
    }

    func testDeepLinkRoundTrips() {
        let url = orbixItemDeepLink(itemId: "clx123")
        XCTAssertEqual(url.absoluteString, "orbix://item/clx123")
        XCTAssertEqual(orbixItemId(from: url), "clx123")
    }

    func testDeepLinkRejectsForeignURLs() {
        XCTAssertNil(orbixItemId(from: URL(string: "https://example.com/item/x")!))
        XCTAssertNil(orbixItemId(from: URL(string: "orbix://other/x")!))
        XCTAssertNil(orbixItemId(from: URL(string: "orbix://item")!))
    }
}
