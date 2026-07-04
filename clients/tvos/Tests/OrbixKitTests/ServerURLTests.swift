import XCTest
@testable import OrbixKit

final class ServerURLTests: XCTestCase {
    func testPrependsHttpWhenNoScheme() {
        XCTAssertEqual(normalizeServerURL("192.168.1.95:8080"), "http://192.168.1.95:8080")
    }

    func testPrependsHttpForBareHost() {
        XCTAssertEqual(normalizeServerURL("orbix.local"), "http://orbix.local")
    }

    func testKeepsExplicitHttp() {
        XCTAssertEqual(normalizeServerURL("http://10.0.0.2:8080"), "http://10.0.0.2:8080")
    }

    func testKeepsExplicitHttps() {
        XCTAssertEqual(normalizeServerURL("https://orbix.example.com"), "https://orbix.example.com")
    }

    func testTrimsWhitespaceAndTrailingSlash() {
        XCTAssertEqual(normalizeServerURL("  192.168.1.95:8080/  "), "http://192.168.1.95:8080")
    }

    func testKeepsSubPathButDropsTrailingSlash() {
        XCTAssertEqual(normalizeServerURL("192.168.1.95:8080/orbix/"), "http://192.168.1.95:8080/orbix")
    }

    func testSchemeMatchIsCaseInsensitive() {
        // Already has a scheme (case-insensitively) → not double-prefixed.
        XCTAssertEqual(normalizeServerURL("HTTP://host:8080"), "HTTP://host:8080")
    }

    func testEmptyOrWhitespaceIsNil() {
        XCTAssertNil(normalizeServerURL(""))
        XCTAssertNil(normalizeServerURL("    "))
    }

    func testSchemeWithoutHostIsNil() {
        XCTAssertNil(normalizeServerURL("http://"))
    }

    func testForeignSchemeIsNil() {
        XCTAssertNil(normalizeServerURL("ftp://host"))
    }
}
