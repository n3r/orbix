import XCTest
@testable import OrbixKit

/// Ports of apps/web/src/lib/tv.ts's `channelHue`/`channelInitials` unit
/// tests (apps/web/src/lib/tv.test.ts) plus the brief's determinism/range
/// assertions — the web algorithm is the source of truth (see AvatarHue.swift).
final class AvatarHueTests: XCTestCase {
    // MARK: - avatarHue

    func testHueIsDeterministicAndInRange() {
        let h1 = avatarHue("Nikita")
        XCTAssertEqual(h1, avatarHue("Nikita"))
        XCTAssertGreaterThanOrEqual(h1, 0)
        XCTAssertLessThan(h1, 360)
        XCTAssertNotEqual(avatarHue("Alice"), avatarHue("Bob"))
    }

    /// Known values from apps/web/src/lib/tv.test.ts ("channelHue is
    /// deterministic with known values") — pins the Swift port to the exact
    /// web hash (`h = (h * 31 + charCode) >>> 0`, `h % 360`).
    func testHueMatchesWebKnownValues() {
        XCTAssertEqual(avatarHue("a"), 97)
        XCTAssertEqual(avatarHue("b"), 98)
        XCTAssertEqual(avatarHue("ab"), 225)
        XCTAssertEqual(avatarHue(""), 0)
    }

    func testHueAlwaysLandsIn0To359() {
        for seed in ["cmb1x2y3", "ChannelOne.ru", String(repeating: "x", count: 200), "☃"] {
            let h = avatarHue(seed)
            XCTAssertGreaterThanOrEqual(h, 0)
            XCTAssertLessThan(h, 360)
        }
    }

    // MARK: - avatarInitials

    func testInitials() {
        XCTAssertEqual(avatarInitials("Nikita Fedorov"), "NF")
        XCTAssertEqual(avatarInitials("kids"), "K")
        XCTAssertEqual(avatarInitials(""), "?")
    }

    /// Ports apps/web/src/lib/tv.test.ts's `channelInitials` cases: trims +
    /// collapses whitespace runs, and falls back to "?" for empty/blank names.
    func testInitialsTrimsAndCollapsesWhitespace() {
        XCTAssertEqual(avatarInitials("  bbc  one "), "BO")
        XCTAssertEqual(avatarInitials("ARD"), "A")
        XCTAssertEqual(avatarInitials("   "), "?")
    }

    /// Code-point (grapheme) aware: an astral-plane emoji must not be split
    /// into surrogate halves, matching the web's `[...w][0]` spread.
    func testInitialsIsCodePointAwareForEmoji() {
        XCTAssertEqual(avatarInitials("😀 CNN"), "😀C")
    }

    /// BMP multi-byte (UTF-8) scripts, e.g. Cyrillic — no regression.
    func testInitialsHandlesCyrillic() {
        XCTAssertEqual(avatarInitials("Первый канал"), "ПК")
    }
}
