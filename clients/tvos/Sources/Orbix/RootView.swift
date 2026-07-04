import SwiftUI

/// Routes by `AppModel.OnboardingPhase`:
/// - `.needsServer` — the M0 acceptance surface: the configured server base
///   URL, editable, reporting reachability (`GET /health`) as a green/red
///   result. No server address is hardcoded — `AppModel` resolves an
///   initial value from a launch argument or environment variable, or
///   leaves the field blank for manual entry.
/// - `.needsPairing` — the M2 pairing screen (`PairingView`): a code to
///   enter on another device.
/// - `.needsProfile` — the M2 profile picker (`ProfilePickerView`).
/// - `.ready` — the M3 home screen (`HomeView`): Netflix-style rails loaded
///   from `/api/home/rows`, replacing the M1 playback spike (`SpikeListView`).
struct RootView: View {
    @State private var model = AppModel()
    @State private var baseURLText = ""
    @FocusState private var isTextFieldFocused: Bool

    var body: some View {
        switch model.phase {
        case .needsServer:
            reachabilityView
        case .needsPairing:
            pairingOrFallback
        case .needsProfile:
            profilePickerOrFallback
        case .ready:
            HomeView(model: model)
        }
    }

    /// `.needsPairing` is only reached once `configure(baseURLString:)` has
    /// built a client and confirmed it reachable, so `model.client` is
    /// always non-nil here in practice; this fallback just avoids force-
    /// unwrapping across that invariant.
    @ViewBuilder
    private var pairingOrFallback: some View {
        if model.client != nil {
            PairingView(model: model)
        } else {
            reachabilityView
        }
    }

    /// Same invariant/fallback reasoning as `pairingOrFallback`, for the
    /// profile-picker phase.
    @ViewBuilder
    private var profilePickerOrFallback: some View {
        if model.client != nil {
            ProfilePickerView(model: model)
        } else {
            reachabilityView
        }
    }

    private var reachabilityView: some View {
        VStack(spacing: 40) {
            Text("Orbix")
                .font(.system(size: 96, weight: .bold))
            Text("tvOS client — scaffold")
                .font(.title2)
                .foregroundStyle(.secondary)

            VStack(spacing: 24) {
                TextField("http://192.168.1.10:1061", text: $baseURLText)
                    .textFieldStyle(.plain)
                    .focused($isTextFieldFocused)
                    .frame(maxWidth: 900)
                    .onSubmit(checkServer)
                    .accessibilityIdentifier("baseURLField")

                Button("Check server", action: checkServer)
                    .disabled(trimmedBaseURLText.isEmpty)
                    .accessibilityIdentifier("checkServerButton")

                statusView
                    .accessibilityIdentifier("reachabilityStatus")
            }
            .padding(.top, 16)
        }
        .padding(80)
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
                Label("Server unreachable", systemImage: "xmark.circle.fill")
                    .font(.title3)
                    .foregroundStyle(.red)
            }
        } else {
            Text(model.isChecking ? "Checking…" : "Not checked yet")
                .font(.title3)
                .foregroundStyle(.secondary)
        }
    }

    private var trimmedBaseURLText: String {
        baseURLText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func checkServer() {
        model.configure(baseURLString: trimmedBaseURLText)
    }
}

#Preview {
    RootView()
}
