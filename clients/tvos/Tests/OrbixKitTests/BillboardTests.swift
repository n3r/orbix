import XCTest
@testable import OrbixKit

final class BillboardTests: XCTestCase {
    private func card(_ id: String, backdrop: String? = nil, addedAt: String? = nil) -> MediaCard {
        MediaCard(id: id, title: id, backdropPath: backdrop, addedAt: addedAt)
    }
    private func row(_ key: String, _ items: [MediaCard]) -> HomeRow {
        HomeRow(key: key, title: key, items: items)
    }

    // MARK: pickBillboard

    func testPicksBackdropCardOfFirstNonContinueRow() {
        let rows = [
            row("continue", [card("cw1", backdrop: "/cw.jpg")]),
            row("hiddenGems", [card("h1"), card("h2", backdrop: "/h2.jpg"), card("h3", backdrop: "/h3.jpg")]),
        ]
        // seed 0 → first backdrop-bearing candidate of the first non-continue row.
        XCTAssertEqual(pickBillboard(rows: rows, seed: 0)?.id, "h2")
        // seed rotates deterministically within that row's candidates ([h2,h3]).
        XCTAssertEqual(pickBillboard(rows: rows, seed: 1)?.id, "h3")
        XCTAssertEqual(pickBillboard(rows: rows, seed: 2)?.id, "h2")
        // abs(seed) so a negative seed never traps (matches web Math.abs(seed)).
        XCTAssertEqual(pickBillboard(rows: rows, seed: -1)?.id, "h3")
    }

    func testSkipsContinueRowEvenWhenItHasBackdrops() {
        let rows = [
            row("continue", [card("cw1", backdrop: "/cw.jpg")]),
            row("tonight", [card("t1", backdrop: "/t1.jpg")]),
        ]
        XCTAssertEqual(pickBillboard(rows: rows, seed: 0)?.id, "t1")
    }

    func testFallsBackToFirstBackdropInAnyRowWhenFirstDiscoveryRowHasNone() {
        // First non-continue row has NO backdrop cards → scan all rows for the
        // first backdrop-bearing card (continue row included, per web step 2).
        let rows = [
            row("continue", [card("cw1", backdrop: "/cw.jpg")]),
            row("hiddenGems", [card("h1"), card("h2")]),
        ]
        XCTAssertEqual(pickBillboard(rows: rows, seed: 0)?.id, "cw1")
    }

    func testFallsBackToFirstCardOfFirstNonEmptyRowWhenNoBackdropsAnywhere() {
        let rows = [row("continue", []), row("hiddenGems", [card("h1"), card("h2")])]
        XCTAssertEqual(pickBillboard(rows: rows, seed: 0)?.id, "h1")
    }

    func testReturnsNilWhenNothingToFeature() {
        XCTAssertNil(pickBillboard(rows: [], seed: 0))
        XCTAssertNil(pickBillboard(rows: [row("continue", [])], seed: 0))
    }

    // MARK: dailySeed

    func testDailySeedStableWithinDayAndDiffersAcrossDays() {
        let d1 = Date(timeIntervalSince1970: 1_760_000_000) // some instant
        let sameDayLater = d1.addingTimeInterval(60 * 60)   // +1h, same UTC day bucket
        let nextDay = d1.addingTimeInterval(24 * 60 * 60)   // +24h
        XCTAssertEqual(dailySeed(now: d1), dailySeed(now: sameDayLater))
        XCTAssertEqual(dailySeed(now: nextDay), dailySeed(now: d1) + 1)
    }

    // MARK: isNew

    func testIsNewWithinAndOutsideWindow() {
        let now = ISO8601DateFormatter().date(from: "2026-07-05T00:00:00Z")!
        XCTAssertTrue(isNew(addedAt: "2026-07-01T00:00:00.000Z", now: now))  // 4 days
        XCTAssertFalse(isNew(addedAt: "2026-06-01T00:00:00.000Z", now: now)) // >14 days
        XCTAssertFalse(isNew(addedAt: nil, now: now))
        XCTAssertFalse(isNew(addedAt: "not-a-date", now: now))
    }

    // MARK: resumeLabel

    func testResumeLabel() {
        XCTAssertNil(resumeLabel(nil))
        XCTAssertEqual(resumeLabel(MediaCard.Resume(seasonNumber: 1, episodeNumber: 2)), "S1 E2")
        XCTAssertEqual(
            resumeLabel(MediaCard.Resume(seasonNumber: 3, episodeNumber: 4, episodeTitle: "Old Friends")),
            "S3 E4 · Old Friends"
        )
        // Empty title behaves as absent (JS falsy parity).
        XCTAssertEqual(resumeLabel(MediaCard.Resume(seasonNumber: 1, episodeNumber: 2, episodeTitle: "")), "S1 E2")
    }
}
