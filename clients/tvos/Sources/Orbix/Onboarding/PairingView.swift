import OrbixKit
import SwiftUI

/// SP2 M2 onboarding screen shown while `AppModel.phase == .needsPairing`
/// (a reachable server, no usable device token yet). Requests a pairing
/// code on appear and renders by `PairingModel.State`:
/// `.waiting(code)` shows the code to enter on another device plus a
/// spinner, `.error(message)` shows the message with a Retry button, and
/// `.approved(token)` is handed to `AppModel.pairingApproved(token:)` —
/// which persists the token and advances `phase` to `.needsProfile`,
/// causing `RootView` to swap this view out. That swap triggers
/// `onDisappear` below, which tears down the poll loop.
struct PairingView: View {
    let model: AppModel

    @State private var pairingModel = PairingModel()

    var body: some View {
        OnboardingChrome {
            Group {
                if let client = model.client {
                    pairingContent(client: client)
                        .onAppear {
                            pairingModel.start(client: client, name: "Apple TV")
                        }
                        .onDisappear {
                            pairingModel.stop()
                        }
                        .onChange(of: pairingModel.state) { _, newState in
                            if case .approved(let token) = newState {
                                Task { await model.pairingApproved(token: token) }
                            }
                        }
                } else {
                    // Defensive only: RootView only routes to PairingView once
                    // `model.client` is non-nil (see `pairingOrFallback`).
                    ProgressView()
                }
            }
        }
    }

    @ViewBuilder
    private func pairingContent(client: OrbixClient) -> some View {
        switch pairingModel.state {
        case .idle:
            ProgressView(L10n.t("pairing.requestingCode"))
                .font(.title3)
        case .waiting(let code):
            waitingView(code: code)
        case .approved:
            // `AppModel` advances `phase` on the next runloop turn (see
            // onChange above), which swaps this view out — nothing
            // meaningful to render in the interim.
            ProgressView()
        case .error(let message):
            errorView(message: message, client: client)
        }
    }

    private func waitingView(code: String) -> some View {
        VStack(spacing: 40) {
            Text(L10n.t("pairing.title"))
                .font(.title2.bold())
                .foregroundStyle(OrbixColor.textDim)

            // The visual star of the screen: large monospaced-digit code on
            // an elevated surface2 plate, wide kerning for at-a-glance
            // legibility from the couch.
            Text(code)
                .font(.system(size: 120, weight: .bold))
                .monospacedDigit()
                .kerning(16)
                .foregroundStyle(OrbixColor.text)
                .padding(.horizontal, 56)
                .padding(.vertical, 28)
                .background(
                    RoundedRectangle(cornerRadius: OrbixRadius.md, style: .continuous)
                        .fill(OrbixColor.surface2)
                )
                .accessibilityIdentifier("pairingCode")

            Text(L10n.t("pairing.instructions"))
                .font(.title3)
                .foregroundStyle(OrbixColor.textDim)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 1000)

            ProgressView()
                .controlSize(.large)
                .padding(.top, 12)
        }
    }

    private func errorView(message: String, client: OrbixClient) -> some View {
        VStack(spacing: 32) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 64))
                .foregroundStyle(OrbixColor.warning)

            Text(message)
                .font(.title3)
                .foregroundStyle(OrbixColor.textDim)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 900)
                .accessibilityIdentifier("pairingErrorMessage")

            Button(L10n.t("common.actions.retry")) {
                pairingModel.start(client: client, name: "Apple TV")
            }
            .buttonStyle(OrbixButtonStyle(.primary))
            .accessibilityIdentifier("pairingRetryButton")
        }
    }
}

#Preview {
    PairingView(model: AppModel())
}
