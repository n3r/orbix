import XCTest
@testable import OrbixKit

/// Not required by the Task 2 brief (which only prescribes DTOTests.swift),
/// but TokenStore is one of the four pieces this task delivers, so it gets
/// its own round-trip coverage. A dedicated service/account (distinct from
/// the app's real "dev.orbix.tvos" / "device-token") keeps this isolated from
/// any real stored session on a shared simulator.
final class TokenStoreTests: XCTestCase {
    func testSaveLoadClearRoundTrip() async throws {
        let store = TokenStore(service: "dev.orbix.tvos.tests", account: "device-token-test")

        do {
            try await store.save(token: "orb_test_token")
        } catch TokenStoreError.keychain(let status) where status == errSecMissingEntitlement {
            // Some simulator/CI test hosts run without a Keychain access-group
            // entitlement, so SecItemAdd can't write. TokenStore's logic
            // (query construction, delete-then-add, status handling) is still
            // exercised either way; only the actual persistence round-trip
            // can't be verified in that environment, so skip rather than fail.
            throw XCTSkip("Keychain unavailable in this simulator test host (errSecMissingEntitlement)")
        }

        let loaded = await store.load()
        XCTAssertEqual(loaded, "orb_test_token")

        await store.clear()
        let cleared = await store.load()
        XCTAssertNil(cleared)
    }

    func testLoadWithNothingStoredReturnsNil() async {
        let store = TokenStore(service: "dev.orbix.tvos.tests", account: "device-token-test-empty")
        await store.clear() // in case a previous run left a stray value
        let loaded = await store.load()
        XCTAssertNil(loaded)
    }
}
