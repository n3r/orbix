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
    /// the loop reaches a terminal state on its own, and by `stop()` when
    /// cancelled from outside — that's the real (MainActor) teardown path.
    ///
    /// `nonisolated(unsafe)`: `deinit` on a `@MainActor` class is itself
    /// nonisolated, so it can't touch a MainActor-isolated stored property
    /// without this — safe here because `deinit` only runs once every
    /// strong reference (and thus every possible caller of `start()`/
    /// `stop()`) is already gone, so there's no actual concurrent access.
    /// (`deinit`'s own `pollTask?.cancel()` is belt-and-suspenders, not a
    /// second teardown path — see the `deinit` comment below.)
    private nonisolated(unsafe) var pollTask: Task<Void, Never>?

    init() {}

    /// Defensive only: `run()` is invoked as `self?.run(...)`, which binds
    /// `self` strongly for the whole (suspending) async call, so `deinit`
    /// can't fire while a poll attempt is genuinely in flight. By the time
    /// `deinit` does run, `pollTask` has always already been cleared by
    /// `finish(_:)` or `stop()` — this `cancel()` is inert belt-and-
    /// suspenders. `stop()` (MainActor) is the real teardown path.
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
            guard !Task.isCancelled else { return }
            if case OrbixError.http(_, let code) = error, let code {
                finish(.error(L10n.errorMessage(code)))
            } else {
                finish(.error(L10n.t("pairing.errors.startFailed")))
            }
            return
        }
        // stop() may have been called while pairInitiate was in flight.
        guard !Task.isCancelled else { return }
        state = .waiting(code: initiate.code)

        let deadline = Date().addingTimeInterval(TimeInterval(initiate.expiresInSec))
        // Consecutive pairPoll failures tolerated before giving up. A single
        // network blip / 429 / transient 5xx shouldn't kill a 10-minute
        // pairing window; reset on every successful poll (pending or
        // approved), escalate to terminal once they stop looking transient.
        var consecutiveFailures = 0
        while true {
            guard !Task.isCancelled else { return }
            guard Date() < deadline else {
                finish(.error(L10n.t("pairing.errors.expired")))
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
                // .pending — keep polling.
            } catch {
                guard !Task.isCancelled else { return }
                if let orbixError = error as? OrbixError, case .http(404, _) = orbixError {
                    // The server's PairingStore already swept this entry
                    // (unknown_or_expired) — same user-facing outcome as our
                    // own local deadline check above, just discovered a
                    // different way. Retrying can't help: terminal.
                    finish(.error(L10n.t("pairing.errors.failed")))
                    return
                }
                // Any other error (rate limit, transport, decoding) may be
                // transient. Tolerate up to 3 in a row before giving up so a
                // single blip doesn't kill the whole attempt.
                consecutiveFailures += 1
                if consecutiveFailures >= 3 {
                    finish(.error(L10n.t("pairing.errors.failed")))
                    return
                }
                // Fewer than 3 in a row so far — fall through to the sleep
                // below and retry.
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
