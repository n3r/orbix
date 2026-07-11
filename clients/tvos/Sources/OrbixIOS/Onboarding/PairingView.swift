import OrbixKit
import SwiftUI
import UIKit

struct PairingView: View {
    let model: AppModel

    @State private var pairingModel = PairingModel()

    var body: some View {
        Group {
            if let client = model.client {
                content(client: client)
                    .onAppear { pairingModel.start(client: client, name: UIDevice.current.name, platform: "ios") }
                    .onDisappear { pairingModel.stop() }
                    .onChange(of: pairingModel.state) { _, newState in
                        if case .approved(let token) = newState {
                            Task { await model.pairingApproved(token: token) }
                        }
                    }
            } else {
                ProgressView()
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(OrbixScreenBackground())
        .accessibilityIdentifier("pairing-screen")
    }

    @ViewBuilder
    private func content(client: OrbixClient) -> some View {
        switch pairingModel.state {
        case .idle:
            ProgressView("Requesting pairing code")
        case .waiting(let code):
            waitingView(code: code)
        case .approved:
            ProgressView()
        case .error(let message):
            errorView(message: message, client: client)
        }
    }

    private func waitingView(code: String) -> some View {
        VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 8) {
                OrbixEyebrow(text: "Device Pairing")
                Text("Approve this iPhone.")
                    .font(.system(size: 34, weight: .black))
                    .foregroundStyle(.white)
                    .lineLimit(2)
                Text("Use any signed-in browser on your LAN to enter the code below.")
                    .font(.callout)
                    .foregroundStyle(OrbixMobileStyle.secondaryText)
            }

            OrbixGlassPanel {
                VStack(alignment: .leading, spacing: 18) {
                    Text("Pairing Code")
                        .font(.headline)
                        .foregroundStyle(OrbixMobileStyle.secondaryText)

                    Text(code)
                        .font(.system(size: 54, weight: .black, design: .monospaced))
                        .tracking(7)
                        .foregroundStyle(.white)
                        .minimumScaleFactor(0.75)

                    HStack(spacing: 10) {
                        ProgressView()
                            .tint(.white)
                        Text("Waiting for approval")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(OrbixMobileStyle.secondaryText)
                    }
                }
            }

            VStack(alignment: .leading, spacing: 10) {
                OrbixPill(text: "Open Account > Devices", systemImage: "1.circle")
                OrbixPill(text: "Enter code", systemImage: "2.circle")
                OrbixPill(text: "Pick a profile here", systemImage: "3.circle")
            }

            Spacer(minLength: 0)
        }
    }

    private func errorView(message: String, client: OrbixClient) -> some View {
        VStack(alignment: .leading, spacing: 22) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 44))
                .foregroundStyle(OrbixMobileStyle.amber)
            Text("Pairing failed")
                .font(.title.bold())
            Text(message)
                .font(.body)
                .foregroundStyle(OrbixMobileStyle.secondaryText)
            Button("Retry") {
                pairingModel.start(client: client, name: UIDevice.current.name, platform: "ios")
            }
            .buttonStyle(.borderedProminent)
            .tint(.white)
            .foregroundStyle(.black)
        }
    }
}
