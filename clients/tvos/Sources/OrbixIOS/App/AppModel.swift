import Foundation
import Observation
import OrbixKit

@MainActor
@Observable
final class AppModel {
    enum OnboardingPhase: Equatable {
        case needsServer
        case needsPairing
        case needsProfile
        case ready
    }

    private(set) var baseURL: URL?
    private(set) var reachable: Bool?
    private(set) var client: OrbixClient?
    private(set) var isChecking = false
    private(set) var token: String?
    private(set) var phase: OnboardingPhase = .needsServer
    private(set) var activeProfile: MeProfile?

    private(set) var isScanning = false
    private(set) var discoveredServers: [DiscoveredServer] = []
    private(set) var didScan = false

    private let tokenStore: TokenStore
    @ObservationIgnored private let defaults: UserDefaults

    private static let launchBaseURLKey = "orbixBaseURL"
    private static let storedBaseURLKey = "dev.orbix.ios.serverBaseURL"

    init(tokenStore: TokenStore = TokenStore(service: "dev.orbix.ios"), defaults: UserDefaults = .standard) {
        self.tokenStore = tokenStore
        self.defaults = defaults

        let resolvedBaseURL = Self.resolveBaseURLString(defaults: defaults)
        if !resolvedBaseURL.isEmpty {
            configure(baseURLString: resolvedBaseURL)
        }
    }

    static func resolveBaseURLString(
        defaults: UserDefaults = .standard,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> String {
        if let launchArg = defaults.string(forKey: launchBaseURLKey), !launchArg.isEmpty {
            return launchArg
        }
        if let envValue = environment["ORBIX_BASE_URL"], !envValue.isEmpty {
            return envValue
        }
        if let storedValue = defaults.string(forKey: storedBaseURLKey), !storedValue.isEmpty {
            return storedValue
        }
        return ""
    }

    static func resolveTokenString() -> String {
        if let launchArg = UserDefaults.standard.string(forKey: "orbixToken"), !launchArg.isEmpty {
            return launchArg
        }
        if let envValue = ProcessInfo.processInfo.environment["ORBIX_TOKEN"], !envValue.isEmpty {
            return envValue
        }
        return ""
    }

    func configure(baseURLString: String) {
        guard let url = URL(string: baseURLString), url.scheme != nil, url.host != nil else {
            baseURL = nil
            client = nil
            reachable = false
            isChecking = false
            activeProfile = nil
            phase = .needsServer
            return
        }

        baseURL = url
        let newClient = OrbixClient(baseURL: url)
        client = newClient
        reachable = nil
        isChecking = true
        token = nil
        activeProfile = nil
        phase = .needsServer

        Task {
            await newClient.setUnauthorizedHandler { [weak self, newClient] in
                self?.handleUnauthorized(from: newClient)
            }

            let isReachable = await newClient.serverReachable()
            guard self.client === newClient else { return }
            self.reachable = isReachable
            self.isChecking = false
            if isReachable {
                self.rememberReachableBaseURL(url)
                await self.resolveOnboarding(client: newClient)
            }
        }
    }

    private func rememberReachableBaseURL(_ url: URL) {
        defaults.set(url.absoluteString, forKey: Self.storedBaseURLKey)
    }

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

    private func checkActiveProfile(client: OrbixClient) async {
        var attempt = 0
        while true {
            guard self.client === client else { return }
            attempt += 1
            do {
                let me = try await client.meProfile()
                guard self.client === client else { return }
                activeProfile = (me.id != nil) ? me : nil
                phase = (me.id != nil) ? .ready : .needsProfile
                return
            } catch {
                guard self.client === client else { return }

                if let orbixError = error as? OrbixError, case .http(401) = orbixError {
                    handleUnauthorized(from: client)
                    return
                }

                guard attempt < 3 else {
                    token = nil
                    phase = .needsPairing
                    return
                }

                do {
                    try await Task.sleep(nanoseconds: 1_000_000_000)
                } catch {
                    return
                }
            }
        }
    }

    func pairingApproved(token: String) async {
        guard let client else { return }
        await client.setToken(token)
        guard self.client === client else { return }
        self.token = token
        activeProfile = nil
        phase = .needsProfile

        let store = tokenStore
        Task { try? await store.save(token: token) }
    }

    private func handleUnauthorized(from client: OrbixClient) {
        guard self.client === client else { return }

        let store = tokenStore
        Task {
            await client.setToken(nil)
            await store.clear()
        }

        token = nil
        activeProfile = nil
        phase = .needsPairing
    }

    func profileSelected(_ profile: Profile) {
        activeProfile = MeProfile(
            id: profile.id,
            name: profile.name,
            avatar: profile.avatar,
            kind: profile.kind,
            maturityCap: profile.maturityCap,
            language: profile.language
        )
        phase = .ready
    }

    func switchProfile() {
        phase = .needsProfile
    }

    func disconnect() {
        let store = tokenStore
        Task { await store.clear() }
        defaults.removeObject(forKey: Self.storedBaseURLKey)

        baseURL = nil
        reachable = nil
        client = nil
        isChecking = false
        token = nil
        activeProfile = nil
        isScanning = false
        discoveredServers = []
        didScan = false
        phase = .needsServer
    }

    func scanForServers() async {
        guard !isScanning else { return }
        isScanning = true
        discoveredServers = []
        let servers = await ServerDiscovery().scan()
        guard phase == .needsServer else {
            isScanning = false
            return
        }
        discoveredServers = servers
        didScan = true
        isScanning = false
    }
}
