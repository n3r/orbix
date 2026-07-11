import Foundation
import Observation
import OrbixKit

@MainActor
@Observable
final class PairingModel {
    enum State: Equatable, Sendable {
        case idle
        case waiting(code: String)
        case approved(token: String)
        case error(String)
    }

    private static let pollIntervalNanoseconds: UInt64 = 2_000_000_000

    private(set) var state: State = .idle
    @ObservationIgnored private var pollTask: Task<Void, Never>?

    deinit {
        pollTask?.cancel()
    }

    func start(client: OrbixClient, name: String, platform: String = "ios") {
        guard pollTask == nil else { return }
        state = .idle
        pollTask = Task { [weak self] in
            await self?.run(client: client, name: name, platform: platform)
        }
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    private func run(client: OrbixClient, name: String, platform: String) async {
        let initiate: PairInitiateResponse
        do {
            initiate = try await client.pairInitiate(name: name, platform: platform)
        } catch {
            guard !Task.isCancelled else { return }
            finish(.error("Couldn't start pairing: \(error)"))
            return
        }
        guard !Task.isCancelled else { return }
        state = .waiting(code: initiate.code)

        let deadline = Date().addingTimeInterval(TimeInterval(initiate.expiresInSec))
        var consecutiveFailures = 0
        while true {
            guard !Task.isCancelled else { return }
            guard Date() < deadline else {
                finish(.error("Pairing code expired. Try again."))
                return
            }

            do {
                let response = try await client.pairPoll(pollToken: initiate.pollToken)
                guard !Task.isCancelled else { return }
                consecutiveFailures = 0
                if case .approved(let deviceToken, _) = response {
                    finish(.approved(token: deviceToken))
                    return
                }
            } catch {
                guard !Task.isCancelled else { return }
                if let orbixError = error as? OrbixError, case .http(404) = orbixError {
                    finish(.error("Pairing failed: \(error)"))
                    return
                }
                consecutiveFailures += 1
                if consecutiveFailures >= 3 {
                    finish(.error("Pairing failed: \(error)"))
                    return
                }
            }

            do {
                try await Task.sleep(nanoseconds: Self.pollIntervalNanoseconds)
            } catch {
                return
            }
        }
    }

    private func finish(_ state: State) {
        self.state = state
        pollTask = nil
    }
}
