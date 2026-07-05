import Foundation
import Observation
import OrbixKit

/// Top-level app state: the configured server `baseURL`, the resolved
/// device auth `token`, the `OrbixClient` built from both, the result of
/// the last reachability check, and the SP2 M2 onboarding `phase` that
/// drives `RootView`'s routing.
///
/// Neither the server address nor the token is ever hardcoded:
/// `resolveBaseURLString()` reads a launch argument/environment variable
/// (or leaves the field blank for manual entry, per SP2's "no hardcoded
/// server origin in committed code" constraint); the device token is
/// resolved from the persisted `TokenStore` first and only falls back to a
/// launch-arg/env value as a dev convenience (see `resolveOnboarding`
/// below) — the real path is the M2 pairing UI.
@MainActor
@Observable
final class AppModel {
    /// Onboarding progression (SP2 M2): `.needsServer` while no reachable
    /// server is configured yet (the existing M0 reachability screen);
    /// once reachable, `.needsPairing` (no usable device token) or
    /// `.needsProfile` (token present, no active profile yet); `.ready`
    /// once both a token and an active profile are resolved, which routes
    /// to the M3 home screen (`HomeView`). `RootView` switches on this.
    enum OnboardingPhase: Equatable {
        case needsServer
        case needsPairing
        case needsProfile
        case ready
    }

    /// The last successfully parsed server base URL, or `nil` if none has
    /// been configured yet (or the last attempt failed to parse as a URL).
    private(set) var baseURL: URL?

    /// Result of the most recent `serverReachable()` check: `nil` before any
    /// check has completed (including while one is in flight — see
    /// `isChecking`), `true`/`false` once it resolves.
    private(set) var reachable: Bool?

    /// The client built for `baseURL`. `nil` until `configure` succeeds.
    /// Once a token is resolved, it's attached via `setToken` on this same
    /// instance rather than rebuilding — see `resolveOnboarding`.
    private(set) var client: OrbixClient?

    /// `true` while a `serverReachable()` request is in flight, so the UI
    /// can distinguish "never checked" from "checking".
    private(set) var isChecking = false

    /// The device token currently attached to `client`, if any resolved —
    /// either loaded from the persisted `TokenStore`, a dev launch-arg/env
    /// stand-in, or minted just now by a completed pairing.
    private(set) var token: String?

    /// The current onboarding phase. See `OnboardingPhase`.
    private(set) var phase: OnboardingPhase = .needsServer

    /// LAN autodetect (see `ServerDiscovery`): `true` while a subnet scan is
    /// running, the Orbix servers the last scan found, and whether any scan
    /// has completed — the last distinguishes "haven't scanned yet" from
    /// "scanned and found nothing" for the server-selection UI.
    private(set) var isScanning = false
    private(set) var discoveredServers: [DiscoveredServer] = []
    private(set) var didScan = false

    /// The device's currently-active profile, as last returned by
    /// `meProfile()` — captured on the `checkActiveProfile` success path and
    /// (for the `profileSelected()` path) by `loadShellData()`. Drives the
    /// shell's kids gating (`kind == "kids"` hides the TV item) and the top
    /// bar's avatar; `nil` until a profile is resolved. Distinct from `phase`
    /// so the shell can read the profile without re-deriving it.
    private(set) var activeProfile: MeProfile?

    /// The active profile's resolved nav categories (`GET /api/me/menu`), one
    /// per enabled library, in display order — the source for the top bar's
    /// category items. Empty until `loadShellData()` populates it (and left
    /// empty on fetch failure, so the bar simply renders without categories).
    private(set) var menuItems: [MenuItem] = []

    private let tokenStore: TokenStore

    init(tokenStore: TokenStore = TokenStore()) {
        self.tokenStore = tokenStore

        let resolvedBaseURL = Self.resolveBaseURLString()
        if !resolvedBaseURL.isEmpty {
            configure(baseURLString: resolvedBaseURL)
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

    /// Dev-only fallback device token (SP2 Task 4, kept working per the M2
    /// brief): a launch argument `-orbixToken <token>` (same
    /// `UserDefaults`-via-scheme-arguments mechanism as
    /// `resolveBaseURLString()`), then the `ORBIX_TOKEN` environment
    /// variable, else `""`. Only consulted by `resolveOnboarding` when
    /// `TokenStore.load()` has nothing persisted — the real path for a
    /// human is the M2 pairing UI (`PairingView`/`PairingModel`).
    static func resolveTokenString() -> String {
        if let launchArg = UserDefaults.standard.string(forKey: "orbixToken"), !launchArg.isEmpty {
            return launchArg
        }
        if let envValue = ProcessInfo.processInfo.environment["ORBIX_TOKEN"], !envValue.isEmpty {
            return envValue
        }
        return ""
    }

    /// Builds an `OrbixClient` for `baseURLString` and checks reachability;
    /// once reachable, kicks off token/profile resolution
    /// (`resolveOnboarding`). An empty or unparseable string clears any
    /// prior configuration and reports `reachable = false` immediately
    /// (and resets `phase` to `.needsServer`), rather than leaving a stale
    /// green/red result — or a stale further-along phase — on screen from a
    /// previously configured address.
    func configure(baseURLString: String) {
        guard let url = URL(string: baseURLString), url.scheme != nil, url.host != nil else {
            baseURL = nil
            client = nil
            reachable = false
            isChecking = false
            phase = .needsServer
            return
        }

        baseURL = url
        let newClient = OrbixClient(baseURL: url)
        client = newClient
        reachable = nil
        isChecking = true
        token = nil
        phase = .needsServer

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
            if isReachable {
                await self.resolveOnboarding(client: newClient)
            }
        }
    }

    /// Runs once `client` is confirmed reachable: resolves a device token
    /// — the persisted `TokenStore` first, else the dev launch-arg/env
    /// stand-in (persisted back to the store — fire-and-forget, same as
    /// `pairingApproved`'s save below, since the outcome is ignored either
    /// way and the Keychain must never delay a phase transition — so a
    /// later tokenless launch on the same simulator picks it up the same
    /// way a real pairing would have) — then, if one was found, attaches it
    /// to `client` and asks the server which profile (if any) is already
    /// active for it. No token at all routes to `.needsPairing`.
    private func resolveOnboarding(client: OrbixClient) async {
        guard self.client === client else { return }

        var resolvedToken = await tokenStore.load()
        if resolvedToken == nil {
            let devToken = Self.resolveTokenString()
            if !devToken.isEmpty {
                resolvedToken = devToken
                let store = tokenStore
                Task { try? await store.save(token: devToken) }
            }
        }

        guard let resolvedToken else {
            guard self.client === client else { return }
            phase = .needsPairing
            return
        }

        await client.setToken(resolvedToken)
        guard self.client === client else { return }
        token = resolvedToken
        await checkActiveProfile(client: client)
    }

    /// Total `meProfile()` attempts (including the first) before giving up
    /// on a non-401 failure — mirrors `PairingModel`'s poll loop, which
    /// tolerates "3 in a row" transient errors before treating its own
    /// polling as terminal.
    private static let meProfileMaxAttempts = 3

    /// Backoff between retried `meProfile()` attempts.
    private static let meProfileRetryDelayNanoseconds: UInt64 = 1_000_000_000

    /// `GET /api/me/profile`: a non-null `id` means this token already has
    /// an active profile (persisted server-side on the device row for
    /// bearer clients) — skip straight to `.ready`; a null `id` means the
    /// picker is still needed. Per spec §7 ("401 on missing/revoked token
    /// → app drops to pairing screen"), an unauthorized response clears the
    /// now-known-bad persisted token and routes straight to `.needsPairing`
    /// — retrying with the same bad token can't help. Any other failure
    /// (transient network blip, etc.) is realistically not worth forcing a
    /// full re-pair over, so — same "consecutive failures" idiom as
    /// `PairingModel`'s poll loop — it's tolerated for up to
    /// `meProfileMaxAttempts` attempts total, `meProfileRetryDelayNanoseconds`
    /// apart, before giving up. Only once retries are exhausted does it
    /// route to `.needsPairing` (the only phase with a concrete recovery
    /// action), and even then it leaves the persisted token alone since it
    /// hasn't actually been disproven — a full relaunch still recovers.
    private func checkActiveProfile(client: OrbixClient) async {
        var attempt = 0
        while true {
            guard self.client === client else { return }
            attempt += 1
            do {
                let me = try await client.meProfile()
                guard self.client === client else { return }
                // Capture the resolved profile for the shell (kids gating,
                // avatar). This is the only addition to this method's success
                // path — the `.ready`/`.needsProfile` decision and all of the
                // retry/401 handling below are unchanged.
                activeProfile = me
                phase = (me.id != nil) ? .ready : .needsProfile
                if phase == .ready {
                    Task { await self.loadShellData() }
                }
                return
            } catch {
                guard self.client === client else { return }

                if let orbixError = error as? OrbixError, case .http(401) = orbixError {
                    let store = tokenStore
                    await store.clear()
                    guard self.client === client else { return }
                    token = nil
                    phase = .needsPairing
                    return
                }

                guard attempt < Self.meProfileMaxAttempts else {
                    token = nil
                    phase = .needsPairing
                    return
                }

                do {
                    try await Task.sleep(nanoseconds: Self.meProfileRetryDelayNanoseconds)
                } catch {
                    // Cancelled mid-backoff. Nothing owns cancelling this
                    // Task today, but bail cleanly (leaving `phase`
                    // untouched) rather than looping on a dead task.
                    return
                }
            }
        }
    }

    /// Called by `PairingView` once `PairingModel` reaches
    /// `.approved(token:)`: persists the new device token to the Keychain,
    /// attaches it to the current client, and advances to the profile
    /// picker. `async` and attaches the token before flipping `phase` so
    /// there's no race between "client has the token" and "ProfilePickerView
    /// starts loading `/api/profiles`".
    func pairingApproved(token: String) async {
        guard let client else { return }
        await client.setToken(token)
        guard self.client === client else { return }
        self.token = token
        phase = .needsProfile

        let store = tokenStore
        Task { try? await store.save(token: token) }
    }

    /// Called by `ProfilePickerView` once `ProfilePickerModel.select`
    /// succeeds: advances to the shell (`ShellView`) and loads the shell's
    /// nav data (menu + the now-active profile) for the top bar.
    func profileSelected() {
        phase = .ready
        Task { await loadShellData() }
    }

    /// Loads the data the shell's top bar needs: the profile's nav
    /// categories (`menu()`) and — only when not already known — the active
    /// profile (`meProfile()`). Called on both `.ready` entry paths (the
    /// `checkActiveProfile` success path, which has already captured
    /// `activeProfile`, so the profile fetch is skipped there; and
    /// `profileSelected()`, which hasn't). Tolerant of failure by design:
    /// either fetch failing simply leaves that piece empty (the bar renders
    /// without categories / with a placeholder avatar) rather than blocking
    /// the shell — nav chrome is not worth failing the whole screen over.
    func loadShellData() async {
        guard let client else { return }

        if let items = try? await client.menu() {
            guard self.client === client else { return }
            menuItems = items
        }

        if activeProfile?.id == nil {
            if let me = try? await client.meProfile() {
                guard self.client === client else { return }
                activeProfile = me
            }
        }
    }

    /// Scans the local subnet for Orbix servers (matching the `service:
    /// "orbix"` marker on `GET /health`) and publishes the results for the
    /// server-selection UI. A no-op while a scan is already in flight. The
    /// scan itself runs off the main actor (`ServerDiscovery` is a plain
    /// `Sendable` struct), so the UI stays responsive; only the state writes
    /// hop back here.
    func scanForServers() async {
        guard !isScanning else { return }
        isScanning = true
        discoveredServers = []
        let servers = await ServerDiscovery().scan()
        // A concurrent `configure` (e.g. the viewer picked a server or typed
        // an address while the scan ran) may have advanced past server
        // selection; don't resurrect stale scan results over it.
        guard phase == .needsServer else {
            isScanning = false
            return
        }
        discoveredServers = servers
        didScan = true
        isScanning = false
    }
}
