import Foundation
import Observation
import OrbixKit

/// Drives the tvOS profile picker (SP2 M2): loads the account's profiles
/// (`GET /api/profiles`) and, on selection, persists the choice as this
/// device's active profile (`POST /api/profiles/:id/select` — see
/// `OrbixClient.selectProfile(id:pin:)`, which for a Bearer-authed device
/// updates `DeviceToken.activeProfileId` server-side instead of a cookie).
/// PIN-protected profiles 403 the pin-less attempt, which swaps the picker
/// over to the PIN pad (`pinPrompt`/`PinPadView`) for a `{pin}` retry.
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

    /// Non-nil while the PIN pad is up for this profile (attempt-select hit
    /// 403 pin_required). The pad is the tvOS adaptation the web doesn't have —
    /// web parity used to stop at a localized error (spec §12), superseded by
    /// the Phase-5 user decision to ship PIN entry.
    private(set) var pinPrompt: Profile?

    /// The most recent PIN-attempt failure, if any — the pad's error line
    /// (distinct from `loadError`, which the grid owns; a pad-owned failure
    /// must not leak onto the grid behind it, and vice versa).
    private(set) var pinError: String?

    /// True while a pin-carrying `select` is in flight — the pad disables
    /// its keys so a slow verify can't accumulate stray digit presses.
    private(set) var isVerifyingPin = false

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

    /// Dismisses the PIN pad without selecting (the pad's Cancel key) —
    /// back to the grid, with any stale wrong-PIN message dropped so a
    /// reopened pad starts clean.
    func cancelPinEntry() {
        pinPrompt = nil
        pinError = nil
    }

    /// Selects `id` as this device's active profile, optionally with a PIN
    /// (`POST /api/profiles/:id/select`, body `{}`/`{pin}`). Returns `true`
    /// on success (the caller advances past the picker). The TV never gates
    /// on `Profile.hasPin` (absent on this branch's wire): every selection
    /// is attempted pin-less first, and a 403 — the only 403 this route
    /// sends is `{error:"pin_required"}`, on this branch (`profiles.ts:81-85`)
    /// and on `origin/main` (`:281-283`) alike — opens the pad
    /// (`pinPrompt`); the same 403 on a pin-carrying retry means "wrong
    /// PIN" (`pinError`). Any other failure sets `loadError` (grid) or
    /// `pinError` (pad) per which surface owns the in-flight attempt, and
    /// returns `false` so that surface stays up.
    @discardableResult
    func select(_ id: String, pin: String? = nil, client: OrbixClient) async -> Bool {
        guard selectingId == nil else { return false }
        selectingId = id
        defer { selectingId = nil }
        if pin != nil {
            // nil→message transitions drive the pad's clear-on-error; reset to
            // nil at the start of every attempt so consecutive wrong PINs still
            // produce a fresh transition.
            pinError = nil
            isVerifyingPin = true
        }
        defer { isVerifyingPin = false }

        do {
            try await client.selectProfile(id: id, pin: pin)
            pinPrompt = nil
            pinError = nil
            return true
        } catch OrbixError.http(403, _) {
            // The only 403 this route sends is {error:"pin_required"} — on this
            // branch (profiles.ts:81-85) and on origin/main (:281-283) alike.
            if pin == nil {
                pinPrompt = profiles.first { $0.id == id }
            } else {
                pinError = "Wrong PIN. Try again."   // → profiles.pin.wrong (Task 4)
            }
            return false
        } catch {
            if pin == nil {
                loadError = "Couldn't select profile: \(error)"
            } else {
                pinError = "Couldn't verify PIN. Try again."  // → profiles.pin.failed
            }
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
