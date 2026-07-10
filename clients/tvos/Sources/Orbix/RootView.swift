import SwiftUI
import OrbixKit

/// Routes by `AppModel.OnboardingPhase`:
/// - `.needsServer` — LAN autodetect + manual entry (`serverSelectionView`):
///   auto-scans the subnet for Orbix servers, offers found ones to pick, and
///   falls back to a manual address field (with `http://` made optional).
/// - `.needsPairing` — the M2 pairing screen (`PairingView`).
/// - `.needsProfile` — the M2 profile picker (`ProfilePickerView`).
/// - `.ready` — the custom web-parity shell (`ShellView`): a top bar
///   (`OrbixTopBar`) overlaid on the selected section (Home / Search /
///   placeholders), replacing the stock `TabView`.
struct RootView: View {
    @State private var model = AppModel()
    @State private var baseURLText = ""
    @State private var showManualEntry = false
    @FocusState private var isTextFieldFocused: Bool

    var body: some View {
        // `.id(model.uiLanguage)` forces a full teardown/rebuild of every
        // visible screen whenever the resolved UI language changes (profile
        // switch, language chip, sign-out to a languageless onboarding
        // phase, …) — SwiftUI treats a changed `.id` as "this is a new
        // view", not an update, so every `.task` loader underneath re-runs
        // from scratch. That's exactly what re-fetches the now-re-localized
        // catalog (server-side, keyed off the active profile's language) —
        // the TV analogue of the web's query refetch on
        // `useSyncProfileLanguage`. `.environment(\.locale, …)` makes
        // SwiftUI's own locale-aware formatting (e.g. any `Text(date:)`/
        // `.formatted()` call) follow the same resolved language, not the
        // system one.
        Group {
            switch model.phase {
            case .needsServer:
                serverSelectionView
            case .needsPairing:
                pairingOrFallback
            case .needsProfile:
                profilePickerOrFallback
            case .ready:
                ShellView(model: model)
            }
        }
        .id(model.uiLanguage)
        .environment(\.locale, L10n.locale)
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
        OnboardingChrome {
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
            Text(L10n.t("server.scanning"))
                .font(.title2)
                .foregroundStyle(OrbixColor.textDim)
        }
        .accessibilityIdentifier("scanningIndicator")
    }

    private var serverListView: some View {
        VStack(spacing: 24) {
            Text(L10n.t("server.selectTitle")).font(.title2)

            ForEach(model.discoveredServers) { server in
                Button {
                    model.configure(baseURLString: server.baseURL)
                } label: {
                    HStack(spacing: 20) {
                        Image(systemName: "server.rack").font(.title2)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(server.name).font(.title3)
                            Text(server.baseURL).font(.callout).foregroundStyle(OrbixColor.textDim)
                        }
                        Spacer()
                    }
                    .frame(maxWidth: 760)
                }
                .buttonStyle(OrbixButtonStyle(.ghost))
                .accessibilityIdentifier("server_\(server.host)")
            }

            HStack(spacing: 24) {
                Button(L10n.t("server.manualEntry")) { showManualEntry = true }
                    .buttonStyle(OrbixButtonStyle(.ghost))
                Button(L10n.t("server.scanAgain")) { Task { await model.scanForServers() } }
                    .buttonStyle(OrbixButtonStyle(.ghost))
            }
            .padding(.top, 8)

            statusView
        }
    }

    private var manualEntryView: some View {
        VStack(spacing: 24) {
            if model.didScan && model.discoveredServers.isEmpty {
                Text(L10n.t("server.notFound"))
                    .font(.title2)
                    .foregroundStyle(OrbixColor.textDim)
            }

            TextField(L10n.t("server.addressPlaceholder"), text: $baseURLText)
                .textFieldStyle(.plain)
                .focused($isTextFieldFocused)
                .frame(maxWidth: 900)
                .onSubmit(checkServer)
                .accessibilityIdentifier("baseURLField")

            Text(L10n.t("server.httpHint"))
                .font(.callout)
                .foregroundStyle(OrbixColor.textDim)

            HStack(spacing: 24) {
                Button(L10n.t("server.connect"), action: checkServer)
                    .buttonStyle(OrbixButtonStyle(.primary))
                    .disabled(trimmedBaseURLText.isEmpty)
                    .accessibilityIdentifier("checkServerButton")
                Button(L10n.t("server.scanAgain")) {
                    showManualEntry = false
                    Task { await model.scanForServers() }
                }
                .buttonStyle(OrbixButtonStyle(.ghost))
                if !model.discoveredServers.isEmpty {
                    Button(L10n.t("server.backToList")) { showManualEntry = false }
                        .buttonStyle(OrbixButtonStyle(.ghost))
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
                Label(L10n.t("server.reachable"), systemImage: "checkmark.circle.fill")
                    .font(.title3)
                    .foregroundStyle(OrbixColor.success)
            } else {
                Label(L10n.t("server.unreachable"), systemImage: "xmark.circle.fill")
                    .font(.title3)
                    .foregroundStyle(OrbixColor.danger)
            }
        } else if model.isChecking {
            Text(L10n.t("server.checking"))
                .font(.title3)
                .foregroundStyle(OrbixColor.textDim)
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
