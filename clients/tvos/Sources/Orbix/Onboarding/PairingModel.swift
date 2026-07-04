import Foundation
import Observation
import OrbixKit

/// Drives the tvOS pairing flow (SP2 M2): `start(client:name:)` requests a
/// pairing code (`POST /api/pair/initiate`), displays it, then polls
/// `GET /api/pair/poll` every 2s until a signed-in web user approves it
/// (`POST /api/pair/approve` from Settings → Devices) or the code's
/// `expiresInSec` window elapses. See `OrbixClient.pairInitiate`/`pairPoll`
/// and the server-side TTL/rate-limit story in
/// `apps/api/src/lib/pairing.ts`.
@MainActor
@Observable
final class PairingModel {
    /// Pairing state machine, driven entirely by `start(client:name:)`.
    enum State: Equatable, Sendable {
        case idle
        case waiting(code: String)
        case approved(token: String)
        case error(String)
    }

    /// How often to re-poll `pairPoll` while `.waiting`.
    private static let pollIntervalNanoseconds: UInt64 = 2_000_000_000

    private(set) var state: State = .idle

    /// The in-flight `pairInitiate` → poll-loop task, if any. Non-nil
    /// exactly while an attempt is in progress: a second `start()` call
    /// before this one reaches a terminal state (`.approved`/`.error`) is a
    /// no-op rather than racing two pollers. Cleared by `finish(_:)` when
    /// the loop reaches a terminal state on its own, and by `stop()`/
    /// `deinit` when cancelled from outside.
    ///
    /// `nonisolated(unsafe)`: `deinit` on a `@MainActor` class is itself
    /// nonisolated, so it can't touch a MainActor-isolated stored property
    /// without this — safe here because `deinit` only runs once every
    /// strong reference (and thus every possible caller of `start()`/
    /// `stop()`) is already gone, so there's no actual concurrent access.
    private nonisolated(unsafe) var pollTask: Task<Void, Never>?

    init() {}

    deinit {
        pollTask?.cancel()
    }

    /// Requests a pairing code and starts polling for approval. A no-op if
    /// an attempt is already in flight — call `stop()` first to abandon it
    /// and start a fresh one.
    func start(client: OrbixClient, name: String) {
        guard pollTask == nil else { return }
        state = .idle
        pollTask = Task { [weak self] in
            await self?.run(client: client, name: name)
        }
    }

    /// Cancels any in-flight pairing attempt. Safe to call when idle. Does
    /// not touch `state` — the caller (typically a view's `onDisappear`)
    /// decides whether a stale `.waiting`/`.error` should still be shown.
    func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    private func run(client: OrbixClient, name: String) async {
        let initiate: PairInitiateResponse
        do {
            initiate = try await client.pairInitiate(name: name)
        } catch {
            finish(.error("Couldn't start pairing: \(error)"))
            return
        }
        // stop() may have been called while pairInitiate was in flight.
        guard !Task.isCancelled else { return }
        state = .waiting(code: initiate.code)

        let deadline = Date().addingTimeInterval(TimeInterval(initiate.expiresInSec))
        while true {
            guard !Task.isCancelled else { return }
            guard Date() < deadline else {
                finish(.error("Pairing code expired. Try again."))
                return
            }

            do {
                let response = try await client.pairPoll(pollToken: initiate.pollToken)
                guard !Task.isCancelled else { return }
                if case .approved(let deviceToken, _) = response {
                    finish(.approved(token: deviceToken))
                    return
                }
                // .pending — keep polling.
            } catch {
                guard !Task.isCancelled else { return }
                // A 404 here means the server's PairingStore already swept
                // this entry (unknown_or_expired) — same user-facing outcome
                // as our own local deadline check above, just discovered a
                // different way; any other error (rate limit, transport,
                // decoding) is treated the same: terminal, retry via a fresh
                // start().
                finish(.error("Pairing failed: \(error)"))
                return
            }

            do {
                try await Task.sleep(nanoseconds: Self.pollIntervalNanoseconds)
            } catch {
                // Cancelled mid-sleep; leave pollTask for stop()/start() to manage.
                return
            }
        }
    }

    /// Sets a terminal state and clears `pollTask` — the loop reached
    /// `.approved`/`.error` on its own, so nothing external is going to call
    /// `stop()` for us.
    private func finish(_ state: State) {
        self.state = state
        pollTask = nil
    }
}
