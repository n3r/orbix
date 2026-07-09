import XCTest
@testable import OrbixKit

/// `orbixParseISODate` is the two-formatter idiom (fractional first, then
/// plain) extracted from `Billboard.parseISODate`; `Billboard`/`TvGridLayout`
/// delegate to it — their own suites (`BillboardTests`/`TvGridLayoutTests`)
/// prove that delegation didn't change behavior.
final class ISODateTests: XCTestCase {
    func testParsesFractionalISO() {
        // The server's Date.toISOString() shape — always fractional ".000Z".
        XCTAssertNotNil(orbixParseISODate("2026-07-06T12:34:56.789Z"))
    }

    func testParsesPlainISOWithoutFractionalSeconds() {
        XCTAssertNotNil(orbixParseISODate("2026-07-06T12:34:56Z"))
    }

    func testJunkReturnsNil() {
        XCTAssertNil(orbixParseISODate("not-a-date"))
    }

    func testRoundTripsAgainstAKnownEpoch() {
        let epoch = Date(timeIntervalSince1970: 1_751_760_000) // arbitrary fixed instant
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let iso = formatter.string(from: epoch)
        let parsed = orbixParseISODate(iso)
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?.timeIntervalSince1970 ?? -1, epoch.timeIntervalSince1970, accuracy: 0.001)
    }
}
