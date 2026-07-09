import XCTest
@testable import OrbixKit

/// Ported vectors from apps/web/src/components/account/menu-order.test.ts's
/// `moveItem` — `menuMoveItem` is a 1:1 port.
final class MenuOrderTests: XCTestCase {
    func testMovesAnItemUp() {
        XCTAssertEqual(menuMoveItem(["a", "b", "c"], index: 1, dir: -1), ["b", "a", "c"])
    }

    func testMovesAnItemDown() {
        XCTAssertEqual(menuMoveItem(["a", "b", "c"], index: 1, dir: 1), ["a", "c", "b"])
    }

    func testIsANoOpCopyPastTheTop() {
        let input = ["a", "b"]
        XCTAssertEqual(menuMoveItem(input, index: 0, dir: -1), input)
    }

    func testIsANoOpCopyPastTheBottom() {
        let input = ["a", "b"]
        XCTAssertEqual(menuMoveItem(input, index: 1, dir: 1), input)
    }

    func testSingleElementIsANoOpInEitherDirection() {
        XCTAssertEqual(menuMoveItem(["a"], index: 0, dir: -1), ["a"])
        XCTAssertEqual(menuMoveItem(["a"], index: 0, dir: 1), ["a"])
    }

    func testDoesNotMutateTheInput() {
        let input = ["a", "b"]
        _ = menuMoveItem(input, index: 0, dir: 1)
        XCTAssertEqual(input, ["a", "b"])
    }
}
