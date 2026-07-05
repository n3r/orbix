import SwiftUI
import OrbixKit

/// Routes by `AppModel.OnboardingPhase`:
/// - `.needsServer` — LAN autodetect + manual entry (`serverSelectionView`):
///   auto-scans the subnet for Orbix servers, offers found ones to pick, and
///   falls back to a manual address field (with `http://` made optional).
/// - `.needsPairing` — the M2 pairing screen (`PairingView`).
/// - `.needsProfile` — the M2 profile picker (`ProfilePickerView`).
/// - `.ready` — the tvOS top tab bar: "Home" (`HomeView`) and "Search"
///   (`SearchView`), each owning its own `NavigationStack`.
struct RootView: View {
    /// The `.ready`-state top tabs. A binding lets a Top Shelf deep link snap
    /// the app back to Home (where the title page pushes) regardless of which
    /// tab was last focused.
    private enum Tab: Hashable {
        case home
        case search
    }

    @State private var model = AppModel()
    @State private var baseURLText = ""
    @State private var showManualEntry = false
    @State private var selectedTab: Tab = .home
    @FocusState private var isTextFieldFocused: Bool

    var body: some View {
        content
            // A Top Shelf item opens `orbix://item/<id>`; stash the target for
            // `HomeView` to push and make sure Home is the visible tab. Handled
            // at the root so a cold-launch deep link (arriving mid-onboarding)
            // is still captured and replayed once the app reaches `.ready`.
            .onOpenURL { url in
                model.handleDeepLink(url)
                selectedTab = .home
            }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .needsServer:
            serverSelectionView
        case .needsPairing:
            pairingOrFallback
        case .needsProfile:
            profilePickerOrFallback
        case .ready:
            TabView(selection: $selectedTab) {
                HomeView(model: model)
                    .tag(Tab.home)
                    .tabItem { Label("Home", systemImage: "house.fill") }
                    .accessibilityIdentifier("tab_home")
                SearchView(model: model)
                    .tag(Tab.search)
                    .tabItem { Label("Search", systemImage: "magnifyingglass") }
                    .accessibilityIdentifier("tab_search")
            }
        }
    }

    /// `.needsPairing`/`.needsProfile` are only reached once
    /// `configure(baseURLString:)` has built a client, so `model.client` is
    /// non-nil in practice; these fallbacks just avoid force-unwrapping.
    @ViewBuilder
    private var pairingOrFallback: some View {
        if model.client != nil { PairingView(model: model) } else { serverSelectionView }
    }

    @ViewBuilder
    private var profilePickerOrFallback: some View {
        if model.client != nil { ProfilePickerView(model: model) } else { serverSelectionView }
    }

    // MARK: - Server selection (.needsServer)

    private var serverSelectionView: some View {
        VStack(spacing: 48) {
            Text("Orbix").font(.system(size: 96, weight: .bold))

            Group {
                if model.isScanning {
                    scanningView
                } else if !model.discoveredServers.isEmpty && !showManualEntry {
                    serverListView
                } else {
                    manualEntryView
                }
            }
            .frame(maxWidth: 1000)
        }
        .padding(80)
        .task {
            // Auto-scan once on first appearance when no server is configured.
            if model.baseURL == nil && !model.didScan {
                await model.scanForServers()
            }
        }
    }

    private var scanningView: some View {
        VStack(spacing: 24) {
            ProgressView().scaleEffect(1.5)
            Text("Searching your network for Orbix…")
                .font(.title2)
                .foregroundStyle(.secondary)
        }
        .accessibilityIdentifier("scanningIndicator")
    }

    private var serverListView: some View {
        VStack(spacing: 24) {
            Text("Select your server").font(.title2)

            ForEach(model.discoveredServers) { server in
                Button {
                    model.configure(baseURLString: server.baseURL)
                } label: {
                    HStack(spacing: 20) {
                        Image(systemName: "server.rack").font(.title2)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(server.name).font(.title3)
                            Text(server.baseURL).font(.callout).foregroundStyle(.secondary)
                        }
                        Spacer()
                    }
                    .frame(maxWidth: 760)
                }
                .accessibilityIdentifier("server_\(server.host)")
            }

            HStack(spacing: 24) {
                Button("Enter address manually") { showManualEntry = true }
                Button("Scan again") { Task { await model.scanForServers() } }
            }
            .padding(.top, 8)

            statusView
        }
    }

    private var manualEntryView: some View {
        VStack(spacing: 24) {
            if model.didScan && model.discoveredServers.isEmpty {
                Text("No Orbix servers found on your network")
                    .font(.title2)
                    .foregroundStyle(.secondary)
            }

            TextField("192.168.1.10:8080", text: $baseURLText)
                .textFieldStyle(.plain)
                .focused($isTextFieldFocused)
                .frame(maxWidth: 900)
                .onSubmit(checkServer)
                .accessibilityIdentifier("baseURLField")

            Text("No need to type http:// — it's added for you.")
                .font(.callout)
                .foregroundStyle(.secondary)

            HStack(spacing: 24) {
                Button("Connect", action: checkServer)
                    .disabled(trimmedBaseURLText.isEmpty)
                    .accessibilityIdentifier("checkServerButton")
                Button("Scan again") {
                    showManualEntry = false
                    Task { await model.scanForServers() }
                }
                if !model.discoveredServers.isEmpty {
                    Button("Back to list") { showManualEntry = false }
                }
            }

            statusView.accessibilityIdentifier("reachabilityStatus")
        }
        .onAppear {
            if baseURLText.isEmpty {
                baseURLText = model.baseURL?.absoluteString ?? ""
            }
            isTextFieldFocused = baseURLText.isEmpty
        }
    }

    @ViewBuilder
    private var statusView: some View {
        if let reachable = model.reachable {
            if reachable {
                Label("Server reachable", systemImage: "checkmark.circle.fill")
                    .font(.title3)
                    .foregroundStyle(.green)
            } else {
                Label("Couldn't reach that server", systemImage: "xmark.circle.fill")
                    .font(.title3)
                    .foregroundStyle(.red)
            }
        } else if model.isChecking {
            Text("Checking…")
                .font(.title3)
                .foregroundStyle(.secondary)
        }
    }

    private var trimmedBaseURLText: String {
        baseURLText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func checkServer() {
        // Normalize so a viewer can type `192.168.1.95:8080`; an unparseable
        // string falls through to `configure`, which reports it unreachable.
        model.configure(baseURLString: normalizeServerURL(trimmedBaseURLText) ?? trimmedBaseURLText)
    }
}

#Preview {
    RootView()
}
