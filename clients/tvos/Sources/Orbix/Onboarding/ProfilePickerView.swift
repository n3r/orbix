import OrbixKit
import SwiftUI

/// SP2 M2 onboarding screen shown while `AppModel.phase == .needsProfile`
/// (device token resolved, no active profile yet — either freshly paired
/// or a returning token that hadn't selected one). Loads `GET /api/profiles`
/// on appear and renders web-parity "Who's watching?" chrome (see
/// `apps/web/src/pages/ProfilesPage.tsx`): a full-screen tile grid (avatar +
/// name, focus-promoted) plus a trailing "Add profile" tile. Selecting a
/// tile persists it server-side (`ProfilePickerModel.select`, wrapping
/// `OrbixClient.selectProfile`) and calls `AppModel.profileSelected()` to
/// advance to the M1 home list; the add tile swaps in a small create form
/// (`ProfilePickerModel.addProfile`, wrapping `OrbixClient.createProfile`)
/// rather than navigating away, so Cancel is a one-button trip back.
struct ProfilePickerView: View {
    let model: AppModel

    /// Either a profile tile or the trailing "Add profile" tile — one
    /// `@FocusState` covers the whole grid so focus can move between them
    /// (e.g. auto-advancing from the Add tile onto the first loaded profile).
    private enum FocusTarget: Hashable {
        case profile(String)
        case add
    }

    /// The 6 profile languages the web add-profile form offers
    /// (`SUPPORTED_LANGUAGES`/`LANGUAGE_LABELS` in
    /// `apps/web/src/lib/i18n/languages.ts`). Full i18n on tvOS is Phase 5
    /// work, so this is a small hardcoded parity list rather than wiring up
    /// a client-side translation catalog for one picker.
    private static let languages: [(code: String, label: String)] = [
        ("en", "English"),
        ("es", "Español"),
        ("de", "Deutsch"),
        ("pt", "Português"),
        ("ru", "Русский"),
        ("fr", "Français"),
    ]

    private static let avatarSize: CGFloat = 160

    @State private var profileModel = ProfilePickerModel()
    @FocusState private var focusedTarget: FocusTarget?

    @State private var showAddForm = false
    @State private var newProfileName = ""
    @State private var newProfileLanguage = "en"
    @FocusState private var nameFieldFocused: Bool

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
    }

    @ViewBuilder
    private func content(client: OrbixClient) -> some View {
        if showAddForm {
            OnboardingChrome {
                addProfileForm(client: client)
            }
        } else {
            pickerScreen(client: client)
        }
    }

    // MARK: - Picker grid

    private func pickerScreen(client: OrbixClient) -> some View {
        ZStack {
            OrbixColor.bg.ignoresSafeArea()

            VStack(spacing: 48) {
                wordmark

                Text("Who's Watching?")
                    .font(.system(size: 64, weight: .bold))
                    .foregroundStyle(OrbixColor.text)

                if profileModel.isLoading && profileModel.profiles.isEmpty {
                    ProgressView("Loading profiles…")
                        .font(.title3)
                } else if let loadError = profileModel.loadError, profileModel.profiles.isEmpty {
                    errorView(message: loadError, client: client)
                } else {
                    profileGrid(client: client)
                }
            }
            .padding(OrbixSpacing.pageMargin)
        }
        .onChange(of: profileModel.profiles) { _, profiles in
            // Auto-advance focus from the (always-present) Add tile onto the
            // first loaded profile, but only while the user hasn't already
            // moved focus elsewhere — avoids hijacking a deliberate remote
            // press while the list happens to refresh (e.g. after add).
            if let first = profiles.first, focusedTarget == .add {
                focusedTarget = .profile(first.id)
            }
        }
    }

    /// Web: `text-2xl font-extrabold uppercase tracking-[0.25em]
    /// text-[var(--accent)]` — same small local copy `OnboardingChrome`
    /// keeps of `OrbixTopBar`'s wordmark treatment (this screen isn't
    /// wrapped in `OnboardingChrome` itself, since that layout is a narrow
    /// centered card and the picker is a full-screen moment on web too).
    private var wordmark: some View {
        Text("ORBIX")
            .font(OrbixType.wordmark(size: 44))
            .kerning(10)
            .foregroundStyle(OrbixColor.accent)
    }

    private func profileGrid(client: OrbixClient) -> some View {
        VStack(spacing: 24) {
            HStack(spacing: 48) {
                ForEach(profileModel.profiles, id: \.id) { profile in
                    profileTile(profile, client: client)
                }
                addProfileTile()
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 16)

            if profileModel.profiles.isEmpty {
                Text("Create your first profile to start watching.")
                    .font(.callout)
                    .foregroundStyle(OrbixColor.textDim)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 700)
            }

            // A failed *select* (e.g. a transient network blip after a
            // successful load) surfaces here without discarding the
            // already-loaded grid, so the user can just try again.
            if let loadError = profileModel.loadError {
                Text(loadError)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("profileSelectErrorMessage")
            }
        }
    }

    private func profileTile(_ profile: Profile, client: OrbixClient) -> some View {
        // Only the tile actually being submitted disables/dims — matches
        // ProfilePickerModel.selectingId's documented intent ("lets the UI
        // disable just that row"). ProfilePickerModel.select itself still
        // guards re-entrancy (a stray press on another tile while this one
        // is in flight is a silent no-op), so this is purely UX polish.
        let isSelecting = profileModel.selectingId == profile.id
        let isFocused = focusedTarget == .profile(profile.id)
        return Button {
            select(profile, client: client)
        } label: {
            VStack(spacing: 16) {
                ZStack(alignment: .topTrailing) {
                    AvatarView(name: profile.name, imageURL: avatarURL(for: profile), size: Self.avatarSize)
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
                    .foregroundStyle(OrbixColor.text)
                    .lineLimit(1)
                    .frame(maxWidth: 220)
            }
        }
        .buttonStyle(.plain)
        .focused($focusedTarget, equals: .profile(profile.id))
        .focusPromote(isFocused)
        .disabled(isSelecting)
        .accessibilityIdentifier("profileButton_\(profile.id)")
    }

    /// Web: the ghost "Add Profile" button below the grid, ported here as a
    /// trailing tile matching the profile tiles' size/shape so the whole row
    /// stays one focus-navigable group — tapping it swaps `content` over to
    /// `addProfileForm` (see the `showAddForm` state) rather than navigating.
    private func addProfileTile() -> some View {
        let isFocused = focusedTarget == .add
        return Button {
            profileModel.clearAddError()
            newProfileName = ""
            showAddForm = true
        } label: {
            VStack(spacing: 16) {
                ZStack {
                    Circle()
                        .fill(Color.white.opacity(isFocused ? 0.3 : 0.15))
                    Image(systemName: "plus")
                        .font(.system(size: 56, weight: .semibold))
                        .foregroundStyle(OrbixColor.text)
                }
                .frame(width: Self.avatarSize, height: Self.avatarSize)

                Text("Add Profile")
                    .font(.title3)
                    .foregroundStyle(OrbixColor.textDim)
                    .lineLimit(1)
                    .frame(maxWidth: 220)
            }
        }
        .buttonStyle(.plain)
        .focused($focusedTarget, equals: .add)
        .focusPromote(isFocused)
        .accessibilityIdentifier("addProfileTile")
    }

    /// Renders the profile's avatar image path resolved the same way
    /// `PosterCard` resolves poster art (relative to `baseURL` under
    /// `api/images/`, the only image-serving route this API exposes — see
    /// `apps/api/src/routes/images.ts`), or `nil` when the profile has no
    /// avatar set — `AvatarView` falls back to its hue-hashed initials tile
    /// either way (missing avatar, bad URL, or a failed fetch).
    private func avatarURL(for profile: Profile) -> URL? {
        guard let avatarPath = profile.avatar, let baseURL = model.baseURL else { return nil }
        return baseURL.appending(path: "api/images/\(avatarPath)")
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
                .accessibilityIdentifier("profilesErrorMessage")

            Button("Retry") {
                Task { await profileModel.load(client: client) }
            }
            .buttonStyle(OrbixButtonStyle(.primary))
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

    // MARK: - Add profile form

    /// Web: the inline `<Card>` form below the grid (name `Input` + language
    /// `Select` + Save/Cancel) — presented here inside `OnboardingChrome`
    /// (its narrow centered-card layout is a good fit for a single form,
    /// unlike the full-bleed grid) as a same-screen state swap rather than a
    /// separate sheet, so Cancel is a single, obvious way back with no
    /// navigation stack to unwind.
    @ViewBuilder
    private func addProfileForm(client: OrbixClient) -> some View {
        VStack(alignment: .leading, spacing: 32) {
            Text("New Profile")
                .font(.title2.bold())
                .foregroundStyle(OrbixColor.text)

            VStack(alignment: .leading, spacing: 12) {
                Text("Name")
                    .font(.callout)
                    .foregroundStyle(OrbixColor.textDim)
                TextField("Profile name", text: $newProfileName)
                    .textFieldStyle(.plain)
                    .focused($nameFieldFocused)
                    .accessibilityIdentifier("profileNameField")
            }

            VStack(alignment: .leading, spacing: 12) {
                Text("Language")
                    .font(.callout)
                    .foregroundStyle(OrbixColor.textDim)
                Picker("Language", selection: $newProfileLanguage) {
                    ForEach(Self.languages, id: \.code) { language in
                        Text(language.label).tag(language.code)
                    }
                }
                .accessibilityIdentifier("profileLanguagePicker")

                Text("The language Orbix uses for this profile.")
                    .font(.caption)
                    .foregroundStyle(OrbixColor.textDim)
            }

            if let addError = profileModel.addError {
                Text(addError)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("addProfileErrorMessage")
            }

            HStack(spacing: 24) {
                Button(profileModel.isAdding ? "Saving…" : "Create") {
                    submitAddProfile(client: client)
                }
                .buttonStyle(OrbixButtonStyle(.primary))
                .disabled(newProfileName.isEmpty || profileModel.isAdding)
                .accessibilityIdentifier("createProfileButton")

                Button("Cancel") {
                    closeAddForm()
                }
                .buttonStyle(OrbixButtonStyle(.ghost))
                .accessibilityIdentifier("cancelAddProfileButton")
            }
        }
        .frame(maxWidth: 700)
        .onAppear { nameFieldFocused = true }
    }

    private func submitAddProfile(client: OrbixClient) {
        let name = newProfileName
        guard !name.isEmpty else { return }
        Task {
            let ok = await profileModel.addProfile(name: name, language: newProfileLanguage, client: client)
            if ok {
                newProfileName = ""
                showAddForm = false
            }
        }
    }

    private func closeAddForm() {
        showAddForm = false
        newProfileName = ""
    }
}

#Preview {
    ProfilePickerView(model: AppModel())
}
