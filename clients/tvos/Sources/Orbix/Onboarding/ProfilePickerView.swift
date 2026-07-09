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
/// A PIN-protected tile 403s the pin-less select and swaps in `PinPadView`
/// the same way (`ProfilePickerModel.pinPrompt`) for a `{pin}` retry.
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
        // Same same-screen state-swap idiom as `showAddForm` below: a
        // PIN-protected tile's pin-less select 403s (`pin_required`), the
        // model captures the profile as `pinPrompt`, and the pad swaps in —
        // Cancel is a one-button trip back with no navigation stack.
        if let prompt = profileModel.pinPrompt {
            OnboardingChrome {
                PinPadView(
                    profileName: prompt.name,
                    errorText: profileModel.pinError,
                    isVerifying: profileModel.isVerifyingPin,
                    onSubmit: { pin in
                        Task {
                            if await profileModel.select(prompt.id, pin: pin, client: client) {
                                model.profileSelected()
                            }
                        }
                    },
                    onCancel: { profileModel.cancelPinEntry() }
                )
            }
        } else if showAddForm {
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

                Text(L10n.t("profiles.title"))
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
            if let first = profiles.first, focusedTarget == nil || focusedTarget == .add {
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
        Text(L10n.t("common.app.wordmark"))
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
                Text(L10n.t("profiles.emptyHint"))
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
                        .overlay {
                            // Web-parity focus ring in place of the (removed)
                            // system platter — see `ProfileTileButtonStyle`.
                            Circle().stroke(OrbixColor.text.opacity(0.9), lineWidth: isFocused ? 4 : 0)
                        }

                    // Badges stack (trailing-aligned) so KIDS and the lock
                    // can coexist without overlapping; the offset that used
                    // to sit on the KIDS badge moved to the stack, so a lone
                    // badge renders exactly where KIDS always has.
                    VStack(alignment: .trailing, spacing: 8) {
                        if profile.kind == "kids" {
                            Text(L10n.t("profiles.badge.kids"))
                                .font(.caption.bold())
                                .padding(.horizontal, 10)
                                .padding(.vertical, 4)
                                .background(.yellow, in: Capsule())
                                .foregroundStyle(.black)
                                .accessibilityIdentifier("kidsBadge_\(profile.id)")
                        }

                        // Cosmetic only — the main/NAS wire sends `hasPin`
                        // (`Boolean(p.pinHash)` in `serializeProfile`); this
                        // branch's wire omits it entirely, so the badge never
                        // renders against a branch server, by design.
                        // Selection never gates on it either way: the pad
                        // opens off the 403 pin_required from attempt-select.
                        if profile.hasPin == true {
                            Image(systemName: "lock.fill")
                                .font(.caption.bold())
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .background(OrbixColor.surface2, in: Capsule())
                                .foregroundStyle(OrbixColor.text)
                                .accessibilityIdentifier("pinBadge_\(profile.id)")
                        }
                    }
                    .offset(x: 8, y: -8)
                }

                Text(profile.name)
                    .font(.title3)
                    .foregroundStyle(OrbixColor.text)
                    .lineLimit(1)
                    .frame(maxWidth: 220)
            }
        }
        .buttonStyle(ProfileTileButtonStyle())
        .focused($focusedTarget, equals: .profile(profile.id))
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
                    Circle()
                        .stroke(OrbixColor.text.opacity(0.9), lineWidth: isFocused ? 4 : 0)
                    Image(systemName: "plus")
                        .font(.system(size: 56, weight: .semibold))
                        .foregroundStyle(OrbixColor.text)
                }
                .frame(width: Self.avatarSize, height: Self.avatarSize)

                // Fixed-size (rather than the profile tiles' `frame(maxWidth:
                // 220)`) so "Add Profile" — longer than any real profile name
                // — never truncates to "Add Prof…" (finding 3).
                Text(L10n.t("profiles.addProfile"))
                    .font(.title3)
                    .foregroundStyle(OrbixColor.textDim)
                    .lineLimit(1)
                    .fixedSize()
            }
        }
        .buttonStyle(ProfileTileButtonStyle())
        .focused($focusedTarget, equals: .add)
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

            Button(L10n.t("common.actions.retry")) {
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
            Text(L10n.t("profiles.form.title"))
                .font(.title2.bold())
                .foregroundStyle(OrbixColor.text)

            VStack(alignment: .leading, spacing: 12) {
                Text(L10n.t("profiles.form.nameLabel"))
                    .font(.callout)
                    .foregroundStyle(OrbixColor.textDim)
                TextField(L10n.t("profiles.form.namePlaceholder"), text: $newProfileName)
                    .textFieldStyle(.plain)
                    .focused($nameFieldFocused)
                    .accessibilityIdentifier("profileNameField")
            }

            VStack(alignment: .leading, spacing: 12) {
                Text(L10n.t("profiles.language.label"))
                    .font(.callout)
                    .foregroundStyle(OrbixColor.textDim)
                Picker(L10n.t("profiles.language.label"), selection: $newProfileLanguage) {
                    ForEach(Self.languages, id: \.code) { language in
                        Text(language.label).tag(language.code)
                    }
                }
                .accessibilityIdentifier("profileLanguagePicker")

                Text(L10n.t("profiles.language.help"))
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
                Button(profileModel.isAdding ? L10n.t("common.status.saving") : L10n.t("profiles.form.create")) {
                    submitAddProfile(client: client)
                }
                .buttonStyle(OrbixButtonStyle(.primary))
                .disabled(newProfileName.isEmpty || profileModel.isAdding)
                .accessibilityIdentifier("createProfileButton")

                Button(L10n.t("common.actions.cancel")) {
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

/// tvOS's automatic focus effect draws a bright rounded platter behind any
/// focusable content by default — fine for system chrome, but wrong here:
/// it breaks the dark web design and makes the (light-on-dark) profile name
/// illegible against it (see phase1-c-profilepicker.png). `focusEffectDisabled()`
/// (tvOS 17+) turns that off; the web-parity treatment substituted in its
/// place is just `focusPromote`'s scale (the focus *ring* itself is drawn by
/// each tile around its avatar/plus circle specifically, not the whole label,
/// since the label also includes the name text below it). Same
/// environment-reading pattern as `OrbixTopBar`'s `NavItemStyle`/`AvatarItemStyle`.
private struct ProfileTileButtonStyle: ButtonStyle {
    @Environment(\.isFocused) private var isFocused

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .focusPromote(isFocused)
            .focusEffectDisabled()
    }
}

#Preview {
    ProfilePickerView(model: AppModel())
}
