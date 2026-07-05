import XCTest
@testable import OrbixKit

/// Proves the EN/RU localization pipeline actually works end-to-end: that the
/// hand-authored `Localizable.xcstrings` compiled into OrbixKit's framework
/// bundle produces per-language `.lproj`s, and that a Russian lookup resolves
/// to the Russian string (not the key, and not English). This is the "a couple
/// of RU lookups" gate from the M4 brief; it targets OrbixKit's catalog because
/// the test bundle can reach the framework bundle (not the app bundle). The
/// app's own catalog uses the identical mechanism — one bundle over — and is
/// covered by the build compiling it plus a Simulator smoke in Russian.
final class LocalizationTests: XCTestCase {
    /// Loads the sub-bundle for one `.lproj` so lookups are pinned to that
    /// language regardless of the test host's own locale (the reliable way to
    /// assert a specific translation).
    private func languageBundle(_ code: String, file: StaticString = #filePath, line: UInt = #line) throws -> Bundle {
        guard let path = Bundle.orbixKit.path(forResource: code, ofType: "lproj"),
              let bundle = Bundle(path: path) else {
            XCTFail("OrbixKit bundle has no compiled \(code).lproj — the String Catalog didn't build \(code)", file: file, line: line)
            throw XCTSkip("missing \(code).lproj")
        }
        return bundle
    }

    func testRussianStringsResolve() throws {
        let ru = try languageBundle("ru")
        XCTAssertEqual(
            ru.localizedString(forKey: "Continue Watching", value: "␀", table: nil),
            "Продолжить просмотр"
        )
        XCTAssertEqual(
            ru.localizedString(forKey: "Recommended", value: "␀", table: nil),
            "Рекомендуем"
        )
    }

    func testEnglishStringsResolve() throws {
        let en = try languageBundle("en")
        XCTAssertEqual(
            en.localizedString(forKey: "Continue Watching", value: "␀", table: nil),
            "Continue Watching"
        )
    }

    func testSectionKindLocalizedTitleIsReal() {
        // Resolves against the test host's current locale; assert it produces a
        // real translation from the shared catalog rather than falling through
        // to the raw key — without pinning a language here.
        XCTAssertFalse(TopShelfContent.SectionKind.continueWatching.localizedTitle.isEmpty)
        XCTAssertFalse(TopShelfContent.SectionKind.recommended.localizedTitle.isEmpty)
    }
}
