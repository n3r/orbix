import SwiftUI

/// Routes to the M1 playback spike (`SpikeListView`) once both a server
/// address and a device token are configured (`AppModel.isReadyForSpike`);
/// otherwise shows the M0 acceptance surface — the configured server base
/// URL, editable, reporting reachability (`GET /health`) as a green/red
/// result. No server address is hardcoded — `AppModel` resolves an initial
/// value from a launch argument or environment variable, or leaves the
/// field blank for manual entry. (The device token has no on-screen entry
/// yet — that's M2's pairing UI; the spike resolves it the same way, via
/// launch arg/env.)
struct RootView: View {
    @State private var model = AppModel()
    @State private var baseURLText = ""
    @FocusState private var isTextFieldFocused: Bool

    var body: some View {
        if model.isReadyForSpike {
            SpikeListView(model: model)
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
