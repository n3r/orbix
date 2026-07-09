import Foundation
import Observation
import OrbixKit

/// Drives the tvOS profile picker (SP2 M2): loads the account's profiles
/// (`GET /api/profiles`) and, on selection, persists the choice as this
/// device's active profile (`POST /api/profiles/:id/select` — see
/// `OrbixClient.selectProfile(id:)`, which for a Bearer-authed device
/// updates `DeviceToken.activeProfileId` server-side instead of a cookie).
@MainActor
@Observable
final class ProfilePickerModel {
    private(set) var profiles: [Profile] = []
    private(set) var isLoading = false
    private(set) var loadError: String?

    /// The id of the profile currently being selected, if any — lets the UI
    /// disable just that row and guards `select` against a second call
    /// (e.g. a double press on the remote) racing the first.
    private(set) var selectingId: String?

    /// True while `addProfile` is in flight — lets the add-profile form
    /// disable its Create button and guards against a double submit.
    private(set) var isAdding = false

    /// The most recent `addProfile` failure, if any (surfaced by the
    /// add-profile form; distinct from `loadError`, which the grid/select
    /// path owns — mirrors the web form's separate `formError` state in
    /// `ProfilesPage.tsx`).
    private(set) var addError: String?

    init() {}

    /// Clears a stale `addError` when the add-profile form is (re)opened —
    /// web parity: `ProfilesPage`'s "Add Profile" button resets `formError`
    /// on click so a previous failed attempt doesn't linger once Cancel'd
    /// and reopened.
    func clearAddError() {
        addError = nil
    }

    /// Fetches the profile list. Safe to call again (e.g. retry after
    /// `loadError`) once the previous call has finished; a call that
    /// arrives while one is already in flight is a no-op rather than
    /// racing a second fetch (mirrors the `selectingId` guard on `select`).
    func load(client: OrbixClient) async {
        guard !isLoading else { return }
        isLoading = true
        loadError = nil
        do {
            profiles = try await client.profiles()
        } catch {
            loadError = "Couldn't load profiles: \(error)"
        }
        isLoading = false
    }

    /// Selects `id` as this device's active profile. Returns `true` on
    /// success (the caller advances past the picker); on failure sets
    /// `loadError` and returns `false` so the picker stays up.
    @discardableResult
    func select(_ id: String, client: OrbixClient) async -> Bool {
        guard selectingId == nil else { return false }
        selectingId = id
        defer { selectingId = nil }

        do {
            try await client.selectProfile(id: id)
            return true
        } catch OrbixError.http(403, _) {
            // Web parity (`ProfilesPage.handleSelectProfile`): the only 403
            // `POST /profiles/:id/select` ever sends is `{error:
            // "pin_required"}` (see `apps/api/src/routes/profiles.ts` — a
            // device client never sends a `pin` in the body, so this is the
            // sole way that route 403s). There's no PIN entry UI here (same
            // as web), so surface the same "not yet supported" message
            // rather than a generic failure.
            loadError = "This profile requires a PIN. PIN entry is not yet supported."
            return false
        } catch {
            loadError = "Couldn't select profile: \(error)"
            return false
        }
    }

    /// Creates a new profile (`POST /api/profiles`, `kind` hardcoded to
    /// `"standard"` inside `OrbixClient.createProfile` — web parity, this
    /// form never creates a kids profile) then reloads the list so the new
    /// tile appears. Returns `true` on success so the add-profile form can
    /// swap back to the grid; on failure sets `addError` and returns `false`
    /// so the form stays up with the message.
    @discardableResult
    func addProfile(name: String, language: String, client: OrbixClient) async -> Bool {
        guard !isAdding else { return false }
        isAdding = true
        addError = nil
        defer { isAdding = false }

        do {
            _ = try await client.createProfile(name: name, language: language)
        } catch {
            addError = "Couldn't create profile: \(error)"
            return false
        }

        // Web parity: a failed reload after a successful create still closes
        // the form (`ProfilesPage.handleAddProfile` awaits `loadProfiles`
        // without gating the form close on it) — the new profile was
        // created either way, the list is just stale until the next
        // load/select. Surfaced via `loadError` like any other list-refresh
        // failure, not `addError`, since profile creation itself succeeded.
        do {
            profiles = try await client.profiles()
        } catch {
            loadError = "Couldn't load profiles: \(error)"
        }
        return true
    }
}
