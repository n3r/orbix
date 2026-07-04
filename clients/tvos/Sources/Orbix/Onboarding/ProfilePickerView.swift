import OrbixKit
import SwiftUI
import UIKit

/// SP2 M2 onboarding screen shown while `AppModel.phase == .needsProfile`
/// (device token resolved, no active profile yet — either freshly paired
/// or a returning token that hadn't selected one). Loads `GET /api/profiles`
/// on appear and renders a horizontally-focusable row; selecting one
/// persists it server-side (`ProfilePickerModel.select`, wrapping
/// `OrbixClient.selectProfile`) and calls `AppModel.profileSelected()` to
/// advance to the M1 home list.
struct ProfilePickerView: View {
    let model: AppModel

    @State private var profileModel = ProfilePickerModel()
    @State private var imageLoader = ImageLoader()
    @FocusState private var focusedProfileId: String?

    var body: some View {
        Group {
            if let client = model.client {
                content(client: client)
                    .task { await profileModel.load(client: client) }
            } else {
                // Defensive only: RootView only routes to ProfilePickerView
                // once `model.client` is non-nil (see `profilePickerOrFallback`).
                ProgressView()
            }
        }
        .padding(80)
    }

    @ViewBuilder
    private func content(client: OrbixClient) -> some View {
        VStack(spacing: 48) {
            Text("Who's Watching?")
                .font(.system(size: 64, weight: .bold))

            if profileModel.isLoading && profileModel.profiles.isEmpty {
                ProgressView("Loading profiles…")
                    .font(.title3)
            } else if let loadError = profileModel.loadError, profileModel.profiles.isEmpty {
                errorView(message: loadError, client: client)
            } else {
                profileRow(client: client)
            }
        }
        .onChange(of: profileModel.profiles) { _, profiles in
            if focusedProfileId == nil {
                focusedProfileId = profiles.first?.id
            }
        }
    }

    private func profileRow(client: OrbixClient) -> some View {
        VStack(spacing: 24) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 48) {
                    ForEach(profileModel.profiles, id: \.id) { profile in
                        profileButton(profile, client: client)
                            .focused($focusedProfileId, equals: profile.id)
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 16)
            }

            // A failed *select* (e.g. a transient network blip after a
            // successful load) surfaces here without discarding the
            // already-loaded row, so the user can just try again.
            if let loadError = profileModel.loadError {
                Text(loadError)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("profileSelectErrorMessage")
            }
        }
    }

    private func profileButton(_ profile: Profile, client: OrbixClient) -> some View {
        // Only the row actually being submitted disables/dims — matches
        // ProfilePickerModel.selectingId's documented intent ("lets the UI
        // disable just that row"). ProfilePickerModel.select itself still
        // guards re-entrancy (a stray press on another row while this one
        // is in flight is a silent no-op), so this is purely UX polish.
        let isSelecting = profileModel.selectingId == profile.id
        return Button {
            select(profile, client: client)
        } label: {
            VStack(spacing: 16) {
                ZStack(alignment: .topTrailing) {
                    avatarView(for: profile)
                        .frame(width: 220, height: 220)
                        .clipShape(Circle())
                        .opacity(isSelecting ? 0.5 : 1)
                        .overlay {
                            if isSelecting {
                                ProgressView()
                            }
                        }

                    if profile.kind == "kids" {
                        Text("KIDS")
                            .font(.caption.bold())
                            .padding(.horizontal, 10)
                            .padding(.vertical, 4)
                            .background(.yellow, in: Capsule())
                            .foregroundStyle(.black)
                            .offset(x: 8, y: -8)
                            .accessibilityIdentifier("kidsBadge_\(profile.id)")
                    }
                }

                Text(profile.name)
                    .font(.title3)
                    .lineLimit(1)
                    .frame(maxWidth: 240)
            }
        }
        .buttonStyle(.card)
        .disabled(isSelecting)
        .accessibilityIdentifier("profileButton_\(profile.id)")
    }

    /// Renders the profile's avatar image if one is set, resolved the same
    /// way `PosterCard` resolves poster art (relative to `baseURL` under
    /// `api/images/`, the only image-serving route this API exposes —
    /// see `apps/api/src/routes/images.ts`); falls back to initials on a
    /// missing avatar, a bad URL, or a failed fetch.
    @ViewBuilder
    private func avatarView(for profile: Profile) -> some View {
        if let avatarPath = profile.avatar, let baseURL = model.baseURL {
            let url = baseURL.appending(path: "api/images/\(avatarPath)")
            RemoteAvatarImage(url: url, imageLoader: imageLoader, initials: initials(for: profile.name))
        } else {
            InitialsAvatar(initials: initials(for: profile.name))
        }
    }

    private func initials(for name: String) -> String {
        let letters = name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init)
        return letters.isEmpty ? "?" : letters.joined().uppercased()
    }

    private func errorView(message: String, client: OrbixClient) -> some View {
        VStack(spacing: 32) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 64))
                .foregroundStyle(.yellow)

            Text(message)
                .font(.title3)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 900)
                .accessibilityIdentifier("profilesErrorMessage")

            Button("Retry") {
                Task { await profileModel.load(client: client) }
            }
            .accessibilityIdentifier("profilesRetryButton")
        }
    }

    private func select(_ profile: Profile, client: OrbixClient) {
        Task {
            let ok = await profileModel.select(profile.id, client: client)
            if ok {
                model.profileSelected()
            }
        }
    }
}

/// A circular placeholder showing a profile's initials — the no-avatar and
/// failed-fetch fallback for `avatarView(for:)`.
private struct InitialsAvatar: View {
    let initials: String

    var body: some View {
        ZStack {
            Circle().fill(.secondary.opacity(0.3))
            Text(initials)
                .font(.system(size: 64, weight: .semibold))
        }
    }
}

/// A single avatar image fetched via `ImageLoader` (memory + disk cache),
/// falling back to initials while loading or on any failure.
private struct RemoteAvatarImage: View {
    let url: URL
    let imageLoader: ImageLoader
    let initials: String

    @State private var uiImage: UIImage?

    var body: some View {
        ZStack {
            if let uiImage {
                Image(uiImage: uiImage)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } else {
                InitialsAvatar(initials: initials)
            }
        }
        .task(id: url) {
            uiImage = nil
            if let data = await imageLoader.image(for: url) {
                uiImage = UIImage(data: data)
            }
        }
    }
}

#Preview {
    ProfilePickerView(model: AppModel())
}
