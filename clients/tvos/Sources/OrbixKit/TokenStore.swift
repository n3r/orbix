import Foundation
import Security

/// Keychain-backed device-token storage. A device token is the long-lived
/// bearer credential (`Authorization: Bearer orb_...`) issued once by
/// `POST /api/pair/approve` and redeemed by the TV via `GET /api/pair/poll`
/// (see `apps/api/src/routes/devices.ts`, `apps/api/src/lib/pairing.ts`).
public actor TokenStore {
    private let service: String
    private let account: String

    public init(service: String = "dev.orbix.tvos", account: String = "device-token") {
        self.service = service
        self.account = account
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    /// Persists `token`, replacing any previously stored value.
    public func save(token: String) throws {
        // Delete any existing entry first: SecItemAdd fails with
        // errSecDuplicateItem if one is already present for this service/account.
        SecItemDelete(baseQuery as CFDictionary)

        var attributes = baseQuery
        attributes[kSecValueData as String] = Data(token.utf8)
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw TokenStoreError.keychain(status)
        }
    }

    /// Returns the stored token, or `nil` if none is stored (or the item
    /// can't be read back, e.g. a sandboxed test host with no Keychain
    /// entitlement).
    public func load() -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Removes any stored token. A no-op (not an error) when none exists.
    public func clear() {
        SecItemDelete(baseQuery as CFDictionary)
    }
}

/// Thrown by `TokenStore.save` when the Keychain rejects the write (e.g.
/// `errSecMissingEntitlement` in a simulator/test host lacking a Keychain
/// access-group entitlement).
public enum TokenStoreError: Error, Sendable, Equatable {
    case keychain(OSStatus)
}
