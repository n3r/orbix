import Foundation
import Observation
import OrbixKit

/// Top-level app state: the configured server `baseURL`, the device auth
/// `token`, the `OrbixClient` built from both, and (for the M0 reachability
/// screen) the result of the last reachability check.
///
/// Neither the server address nor the token is ever hardcoded:
/// `resolveBaseURLString()` / `resolveTokenString()` each read a launch
/// argument, then an environment variable, else default to `""` (SP2 Global
/// Constraint: "No hardcoded server origin in committed code" — the same
/// reasoning extends to the M1 spike's device token, which in production is
/// minted through the real pairing UI, deferred to M2).
@MainActor
@Observable
final class AppModel {
    /// The last successfully parsed server base URL, or `nil` if none has
    /// been configured yet (or the last attempt failed to parse as a URL).
    private(set) var baseURL: URL?

    /// Result of the most recent `serverReachable()` check: `nil` before any
    /// check has completed (including while one is in flight — see
    /// `isChecking`), `true`/`false` once it resolves.
    private(set) var reachable: Bool?

    /// The client built for `baseURL` (constructed with `token`, if one was
    /// resolved at launch). `nil` until `configure` succeeds.
    private(set) var client: OrbixClient?

    /// `true` while a `serverReachable()` request is in flight, so the UI
    /// can distinguish "never checked" from "checking".
    private(set) var isChecking = false

    /// The device token resolved at launch (see `resolveTokenString()`).
    /// `nil` until one is supplied via launch arg/env — there is no
    /// on-screen entry for it; that's M2's pairing UI (on-screen code +
    /// poll). The M1 spike's stand-in is a token minted through the
    /// web/API pairing flow and passed in via `-orbixToken`/`ORBIX_TOKEN`.
    private(set) var token: String?

    private let tokenStore: TokenStore

    init(tokenStore: TokenStore = TokenStore()) {
        self.tokenStore = tokenStore

        let resolvedToken = Self.resolveTokenString()
        if !resolvedToken.isEmpty {
            token = resolvedToken
            // Fire-and-forget: persist to Keychain via TokenStore per the
            // Task 4 interfaces. A failure here (e.g. no Keychain
            // access-group entitlement in some simulator/CI hosts) doesn't
            // block the spike, which only ever reads `token` from this
            // launch-time resolution, not from the store.
            let store = tokenStore
            Task { try? await store.save(token: resolvedToken) }
        }

        let resolvedBaseURL = Self.resolveBaseURLString()
        if !resolvedBaseURL.isEmpty {
            configure(baseURLString: resolvedBaseURL)
        }
    }

    /// `true` once both a server address and a device token are configured
    /// — `RootView`'s signal to route to `SpikeListView` (the M1 spike)
    /// instead of the M0 reachability screen.
    var isReadyForSpike: Bool {
        client != nil && token != nil
    }

    /// Resolution order for the initial base URL (SP2 Task 3): a launch
    /// argument `-orbixBaseURL <url>` — Xcode's scheme "Arguments Passed On
    /// Launch" registers `-key value` pairs into `UserDefaults`, so this is
    /// read via `UserDefaults.standard.string(forKey:)` rather than parsing
    /// `CommandLine.arguments` directly — then the `ORBIX_BASE_URL`
    /// environment variable, else `""` (the on-screen field starts blank;
    /// the user types the address). This keeps any real server address out
    /// of committed code.
    static func resolveBaseURLString() -> String {
        if let launchArg = UserDefaults.standard.string(forKey: "orbixBaseURL"), !launchArg.isEmpty {
            return launchArg
        }
        if let envValue = ProcessInfo.processInfo.environment["ORBIX_BASE_URL"], !envValue.isEmpty {
            return envValue
        }
        return ""
    }

    /// Resolution order for the M1 spike's device token (SP2 Task 4): a
    /// launch argument `-orbixToken <token>` (same `UserDefaults`-via-
    /// scheme-arguments mechanism as `resolveBaseURLString()`), then the
    /// `ORBIX_TOKEN` environment variable, else `""` (no token configured;
    /// `RootView` falls back to the M0 reachability screen).
    static func resolveTokenString() -> String {
        if let launchArg = UserDefaults.standard.string(forKey: "orbixToken"), !launchArg.isEmpty {
            return launchArg
        }
        if let envValue = ProcessInfo.processInfo.environment["ORBIX_TOKEN"], !envValue.isEmpty {
            return envValue
        }
        return ""
    }

    /// Builds an `OrbixClient` for `baseURLString` (carrying `token`, if
    /// any was resolved) and checks reachability. An empty or unparseable
    /// string clears any prior configuration and reports `reachable =
    /// false` immediately, rather than leaving a stale green/red result on
    /// screen from a previously configured address.
    func configure(baseURLString: String) {
        guard let url = URL(string: baseURLString), url.scheme != nil, url.host != nil else {
            baseURL = nil
            client = nil
            reachable = false
            isChecking = false
            return
        }

        baseURL = url
        let newClient = OrbixClient(baseURL: url, token: token)
        client = newClient
        reachable = nil
        isChecking = true

        Task {
            // `OrbixClient` is an actor, so this `await` hops off the
            // MainActor for the network call. `Task { }` created from a
            // MainActor-isolated method inherits MainActor isolation for
            // the rest of the closure, so the writes below are
            // main-actor-safe without an explicit `MainActor.run`.
            let isReachable = await newClient.serverReachable()
            guard self.client === newClient else {
                // A later `configure(baseURLString:)` call superseded this
                // one while the request was in flight; drop the stale
                // result rather than overwriting a newer check.
                return
            }
            self.reachable = isReachable
            self.isChecking = false
        }
    }
}
