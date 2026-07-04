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

    init() {}

    /// Fetches the profile list. Safe to call again (e.g. retry after
    /// `loadError`); each call replaces `profiles`/`loadError` with the
    /// latest result.
    func load(client: OrbixClient) async {
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
        } catch {
            loadError = "Couldn't select profile: \(error)"
            return false
        }
    }
}
