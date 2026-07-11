import OrbixKit
import SwiftUI

struct ServerSelectionView: View {
    let model: AppModel

    @State private var baseURLText = ""
    @State private var showManualEntry = true
    @FocusState private var fieldFocused: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    brandHeader
                    scanSummary

                    if !model.discoveredServers.isEmpty && !showManualEntry {
                        serverList
                    }

                    manualEntry
                }
                .padding(.horizontal, 20)
                .padding(.top, 28)
                .padding(.bottom, 40)
            }
            .background(OrbixScreenBackground())
            .task {
                if model.baseURL == nil && !model.didScan {
                    await model.scanForServers()
                }
            }
        }
    }

    private var brandHeader: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Text("Orbix")
                    .font(.title2.weight(.black))
                    .foregroundStyle(.white)
                Spacer()
                OrbixPill(text: "LAN", systemImage: "wifi", selected: false)
            }

            VStack(alignment: .leading, spacing: 10) {
                OrbixEyebrow(text: "Connect to your home media server")
                Text("Find the server on your network.")
                    .font(.system(size: 34, weight: .black))
                    .foregroundStyle(.white)
                    .lineLimit(2)
                    .minimumScaleFactor(0.82)
                Text("Orbix checks the local network first. Use the address field only when discovery is blocked by your router or simulator.")
                    .font(.callout)
                    .foregroundStyle(OrbixMobileStyle.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var scanSummary: some View {
        OrbixGlassPanel {
            HStack(alignment: .top, spacing: 14) {
                ZStack {
                    Circle()
                        .fill(model.isScanning ? OrbixMobileStyle.red.opacity(0.22) : OrbixMobileStyle.teal.opacity(0.20))
                    if model.isScanning {
                        ProgressView()
                            .tint(.white)
                    } else {
                        Image(systemName: model.discoveredServers.isEmpty ? "dot.radiowaves.left.and.right" : "checkmark")
                            .font(.headline.weight(.bold))
                            .foregroundStyle(model.discoveredServers.isEmpty ? OrbixMobileStyle.amber : OrbixMobileStyle.teal)
                    }
                }
                .frame(width: 46, height: 46)

                VStack(alignment: .leading, spacing: 8) {
                    Text(scanTitle)
                        .font(.headline)
                        .foregroundStyle(.white)
                    Text(scanSubtitle)
                        .font(.footnote)
                        .foregroundStyle(OrbixMobileStyle.secondaryText)

                    HStack(spacing: 10) {
                        Button {
                            showManualEntry = false
                            Task { await model.scanForServers() }
                        } label: {
                            OrbixPill(text: model.didScan ? "Scan Again" : "Scan Now", systemImage: "arrow.triangle.2.circlepath")
                        }
                        .buttonStyle(.plain)

                        if !model.discoveredServers.isEmpty {
                            Button {
                                showManualEntry.toggle()
                            } label: {
                                OrbixPill(
                                    text: showManualEntry ? "Show Found" : "Manual",
                                    systemImage: showManualEntry ? "server.rack" : "keyboard"
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
    }

    private var serverList: some View {
        VStack(alignment: .leading, spacing: 12) {
            OrbixSectionHeader(title: "Found Servers", detail: "\(model.discoveredServers.count)")

            ForEach(model.discoveredServers) { server in
                Button {
                    model.configure(baseURLString: server.baseURL)
                } label: {
                    HStack(spacing: 14) {
                        Image(systemName: "server.rack")
                            .font(.headline)
                            .foregroundStyle(OrbixMobileStyle.teal)
                            .frame(width: 44, height: 44)
                            .background(OrbixMobileStyle.teal.opacity(0.14), in: RoundedRectangle(cornerRadius: 8))

                        VStack(alignment: .leading, spacing: 3) {
                            Text(server.name)
                                .font(.headline)
                                .foregroundStyle(.white)
                            Text(server.baseURL)
                                .font(.footnote)
                                .foregroundStyle(OrbixMobileStyle.secondaryText)
                                .lineLimit(1)
                        }
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                    .padding(16)
                    .background(OrbixMobileStyle.panel, in: RoundedRectangle(cornerRadius: 8))
                    .overlay {
                        RoundedRectangle(cornerRadius: 8).stroke(OrbixMobileStyle.stroke, lineWidth: 1)
                    }
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var manualEntry: some View {
        VStack(alignment: .leading, spacing: 14) {
            OrbixSectionHeader(title: "Server Address", detail: model.discoveredServers.isEmpty ? "Fallback" : "Optional")

            if model.didScan && model.discoveredServers.isEmpty {
                Text("No Orbix servers were found automatically. Enter the LAN address from the web app or NAS.")
                    .font(.callout)
                    .foregroundStyle(OrbixMobileStyle.secondaryText)
            }

            TextField("192.168.1.10:8080", text: $baseURLText)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .focused($fieldFocused)
                .submitLabel(.go)
                .onSubmit(checkServer)
                .padding(.horizontal, 16)
                .frame(height: 54)
                .background(.black.opacity(0.3), in: RoundedRectangle(cornerRadius: 8))
                .overlay {
                    RoundedRectangle(cornerRadius: 8).stroke(OrbixMobileStyle.stroke, lineWidth: 1)
                }
                .accessibilityIdentifier("baseURLField")

            Button {
                checkServer()
            } label: {
                OrbixPrimaryActionLabel(title: model.isChecking ? "Checking" : "Connect", systemImage: "arrow.right")
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .tint(.white)
            .foregroundStyle(.black)
            .disabled(trimmedBaseURLText.isEmpty)
            .accessibilityIdentifier("checkServerButton")

            HStack(spacing: 10) {
                Button {
                    showManualEntry = false
                    Task { await model.scanForServers() }
                } label: {
                    OrbixPill(text: "Scan Again", systemImage: "dot.radiowaves.left.and.right")
                }
                .buttonStyle(.plain)

                if !model.discoveredServers.isEmpty {
                    Button {
                        showManualEntry = false
                    } label: {
                        OrbixPill(text: "Found Servers", systemImage: "server.rack")
                    }
                    .buttonStyle(.plain)
                }
            }

            statusView
        }
        .onAppear {
            if baseURLText.isEmpty {
                baseURLText = model.baseURL?.absoluteString ?? ""
            }
            fieldFocused = baseURLText.isEmpty
        }
    }

    @ViewBuilder
    private var statusView: some View {
        if let reachable = model.reachable {
            if reachable {
                Label("Server reachable", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(OrbixMobileStyle.teal)
            } else {
                Label("Couldn't reach that server", systemImage: "xmark.circle.fill")
                    .foregroundStyle(OrbixMobileStyle.red)
            }
        } else if model.isChecking {
            Label("Checking", systemImage: "arrow.triangle.2.circlepath")
                .foregroundStyle(OrbixMobileStyle.secondaryText)
        }
    }

    private var scanTitle: String {
        if model.isScanning { return "Scanning your local network" }
        if model.discoveredServers.isEmpty { return model.didScan ? "No server discovered yet" : "Ready to scan" }
        return "Orbix server found"
    }

    private var scanSubtitle: String {
        if model.isScanning { return "Looking for Orbix on nearby LAN addresses." }
        if model.discoveredServers.isEmpty { return "Automatic discovery mirrors the Apple TV flow." }
        return "Choose a server below or enter an address manually."
    }

    private var trimmedBaseURLText: String {
        baseURLText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func checkServer() {
        model.configure(baseURLString: normalizeServerURL(trimmedBaseURLText) ?? trimmedBaseURLText)
    }
}
