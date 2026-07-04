import Foundation
import Observation
import OrbixKit

/// Top-level app state for the M0 reachability screen (and the base other
/// milestones build on). Holds the configured server `baseURL`, the
/// `OrbixClient` built for it, and the result of the last reachability
/// check.
///
/// No server address is ever hardcoded: `resolveBaseURLString()` reads a
/// launch argument, then an environment variable, else returns an empty
/// string so `RootView` starts with a blank field for manual entry (SP2
/// Global Constraint: "No hardcoded server origin in committed code").
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

    /// The client built for `baseURL`. `nil` until `configure` succeeds.
    private(set) var client: OrbixClient?

    /// `true` while a `serverReachable()` request is in flight, so the UI
    /// can distinguish "never checked" from "checking".
    private(set) var isChecking = false

    init() {
        let resolved = Self.resolveBaseURLString()
        if !resolved.isEmpty {
            configure(baseURLString: resolved)
        }
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

    /// Builds an `OrbixClient` for `baseURLString` and checks reachability.
    /// An empty or unparseable string clears any prior configuration and
    /// reports `reachable = false` immediately, rather than leaving a stale
    /// green/red result on screen from a previously configured address.
    func configure(baseURLString: String) {
        guard let url = URL(string: baseURLString), url.scheme != nil, url.host != nil else {
            baseURL = nil
            client = nil
            reachable = false
            isChecking = false
            return
        }

        baseURL = url
        let newClient = OrbixClient(baseURL: url)
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
