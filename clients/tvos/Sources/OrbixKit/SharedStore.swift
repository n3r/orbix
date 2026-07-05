import Foundation

/// Cross-process storage shared between the Orbix app and its Top Shelf
/// extension. The extension runs in a **separate process** with no access to
/// the app's own sandbox container, so the two things it needs to talk to the
/// server — the configured `baseURL` and the device bearer token — are shared
/// here:
///
/// - `baseURL` via the App Group's shared `UserDefaults` (`appGroupID`); the
///   app persists it in `AppModel.configure`, the extension reads it in
///   `loadTopShelfContent`.
/// - the device token via a shared Keychain access group
///   (`keychainAccessGroup`), which `TokenStore` is pointed at when
///   constructed with that group (see `TokenStore(accessGroup:)`).
///
/// Both require matching entitlements on the app **and** the extension
/// (`com.apple.security.application-groups` + `keychain-access-groups`; see
/// each target's `.entitlements`). Neither is enforceable on the tvOS
/// Simulator — it has no entitlement sandbox, the same limitation that already
/// prevents device tokens persisting in the Simulator (see the tvOS README) —
/// so the shared read only actually crosses the process boundary on real
/// hardware. The plumbing is otherwise complete: on device the extension picks
/// up whatever the app last wrote.
public enum OrbixSharedStore {
    /// App Group identifier shared by the app + extension entitlements.
    public static let appGroupID = "group.dev.orbix.tvos"

    /// The shared Keychain access group, un-prefixed. On device the system
    /// resolves the entitlement's `$(AppIdentifierPrefix)dev.orbix.tvos.shared`
    /// form (the team-prefixed group); the tvOS README documents the single
    /// on-device wiring note. On the Simulator there is no entitlement sandbox
    /// so this is inert.
    public static let keychainAccessGroup = "dev.orbix.tvos.shared"

    private static let baseURLKey = "serverBaseURL"

    private static var defaults: UserDefaults? { UserDefaults(suiteName: appGroupID) }

    /// Persists the server base URL to the App Group so the extension can
    /// reach the same server. A no-op if the App Group container isn't
    /// available (e.g. entitlement missing on the Simulator).
    public static func saveBaseURL(_ url: URL) {
        defaults?.set(url.absoluteString, forKey: baseURLKey)
    }

    /// Reads back the server base URL the app last saved, or `nil` if none has
    /// been written (or the container is unavailable).
    public static func loadBaseURL() -> URL? {
        guard let string = defaults?.string(forKey: baseURLKey) else { return nil }
        return URL(string: string)
    }

    /// Clears the shared base URL (e.g. if the app were ever to fully sign
    /// out). Not currently called by the app, but the setter's counterpart.
    public static func clearBaseURL() {
        defaults?.removeObject(forKey: baseURLKey)
    }
}
