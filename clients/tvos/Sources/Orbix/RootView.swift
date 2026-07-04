import SwiftUI

/// M0 acceptance surface: shows the configured server base URL, lets the
/// user type or edit it, and reports reachability (`GET /health`) as a
/// green/red result. No server address is hardcoded — `AppModel` resolves
/// an initial value from a launch argument or environment variable, or
/// leaves the field blank for manual entry.
struct RootView: View {
    @State private var model = AppModel()
    @State private var baseURLText = ""
    @FocusState private var isTextFieldFocused: Bool

    var body: some View {
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
