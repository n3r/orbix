import OrbixKit
import SwiftUI

/// Phase 5 Task 3 Account screen, reached from `OrbixTopBar`'s avatar
/// (`AppSection.account`) — tvOS port of the web `/account` hub
/// (`apps/web/src/pages/account/{AccountLayout,AccountOverview}.tsx` +
/// `components/account/ProfileMenuEditor.tsx` + `components/LanguageSwitcher.tsx`).
///
/// **Single screen, no tabs.** The web hub is a tab strip (Overview / My Menu
/// / TV / Library / Settings / Devices) that also gates admin-only tabs
/// behind `isAdmin`. Per spec §7.11's TV adaptation, admin surfaces
/// (library/TV/settings management, device approval) stay **web-only** —
/// this screen only ever renders the non-admin subset, so there is nothing
/// left to tab between: every section a viewer can reach here scrolls in one
/// list, top to bottom:
///
/// 1. **Profile card** — avatar + name + kind line (`AccountOverview.tsx:23-31`).
/// 2. **Language** — `LanguageSwitcher.tsx`'s `<select>`, adapted to a row of
///    six focusable chips (tvOS has no native picker control — same
///    adaptation `LibraryBrowseView`'s sort `<select>` got). See
///    `AccountModel`'s doc comment for the optimistic-flip + Task-5 bridge.
/// 3. **Switch Profile** — `nav:switchProfile`, routed through
///    `AppModel.switchProfile()` back to the picker (which now has the PIN
///    pad — Task 2's single integration point covers this path for free).
/// 4. **My Menu** — `ProfileMenuEditor.tsx`, adapted to a focusable toggle +
///    ↑/↓ reorder row per library (`AccountModel` owns the editor state).
/// 5. **Server** — TV-only (spec §7.11): the configured server URL + app
///    version, useful on a device with no browser devtools to check either.
/// 6. **Unlink Device** — TV-only (spec §7.11): danger-styled, confirms via
///    `.alert` before calling `AppModel.unlinkDevice()`. Client-side only —
///    see that method's doc comment for why the server-side revoke stays on
///    the web admin Devices page.
///
/// Pushes no routes of its own (no `NavigationStack` destination anywhere in
/// this screen), so — per `ShellView`'s established per-section Menu-walk
/// pattern (`SearchView`/`LibraryBrowseView`/`WishlistView`/`TvHomeView`,
/// each owning their own `.onExitCommand` rather than `ShellView` attaching
/// one from outside) — this view's own `.onExitCommand` calls `onMenuExit`
/// unconditionally, with no `path.isEmpty` check: there is no `path` that
/// could ever be non-empty.
struct AccountView: View {
    let model: AppModel

    /// Called on Menu — always fires immediately (see the type doc comment
    /// for why this section never needs to pop a route first).
    let onMenuExit: () -> Void

    @State private var accountModel = AccountModel()
    @State private var showUnlinkConfirm = false

    /// Same top padding rationale as `LibraryBrowseView`/`WishlistView`:
    /// `OrbixTopBar` renders over this section (a hub, like every other
    /// non-Home, non-search section), and this page has no hero art meant to
    /// bleed under it.
    private static let contentTopPadding: CGFloat = 140

    /// The six web-native language labels (`LANGUAGE_LABELS` in
    /// `apps/web/src/lib/i18n/languages.ts`) — deliberately never localized,
    /// same as the web: each label is the language's own name in itself, so
    /// a viewer can find their language regardless of what the chrome
    /// currently reads in.
    private static let languages: [(code: String, label: String)] = [
        ("en", "English"),
        ("es", "Español"),
        ("de", "Deutsch"),
        ("pt", "Português"),
        ("ru", "Русский"),
        ("fr", "Français"),
    ]

    var body: some View {
        NavigationStack {
            Group {
                if let client = model.client {
                    content(client: client)
                        .task { await accountModel.loadMenuConfig(client: client) }
                } else {
                    // Defensive only: ShellView only routes to `.account`
                    // once `model.client` is non-nil — same invariant every
                    // other section's fallback documents.
                    ProgressView()
                }
            }
        }
        // Unconditional — see the type doc comment for why this section
        // never needs `LibraryBrowseView`/`WishlistView`'s `path.isEmpty`
        // check first.
        .onExitCommand { onMenuExit() }
    }

    // MARK: - Content

    @ViewBuilder
    private func content(client: OrbixClient) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 48) {
                profileSection
                languageSection(client: client)
                switchProfileSection
                menuSection(client: client)
                serverSection
                unlinkSection
            }
            .padding(.horizontal, 64)
            .padding(.top, Self.contentTopPadding)
            .padding(.bottom, 80)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityIdentifier("accountView")
    }

    // MARK: - 1. Profile card

    /// Web `AccountOverview.tsx:23-31`: avatar + name + kind line
    /// (`account:profileKind.*`).
    private var profileSection: some View {
        HStack(spacing: 24) {
            AvatarView(name: model.activeProfile?.name ?? "?", imageURL: avatarURL, size: 96)
            VStack(alignment: .leading, spacing: 6) {
                Text(model.activeProfile?.name ?? "")
                    .font(.system(size: 34, weight: .semibold))
                    .foregroundStyle(OrbixColor.text)
                Text(model.activeProfile?.kind == "kids" ? L10n.t("account.profileKind.kids") : L10n.t("account.profileKind.standard"))
                    .font(.title3)
                    .foregroundStyle(OrbixColor.textDim)
            }
        }
        .focusSection()
        .accessibilityIdentifier("accountProfileCard")
    }

    /// Same resolution as `OrbixTopBar.avatarURL`/`ProfilePickerView.avatarURL`:
    /// relative to `baseURL` under `api/images/`, the only image-serving
    /// route this API exposes.
    private var avatarURL: URL? {
        guard let avatar = model.activeProfile?.avatar, let baseURL = model.baseURL else { return nil }
        return baseURL.appending(path: "api/images/\(avatar)")
    }

    // MARK: - 2. Language

    /// Web `LanguageSwitcher.tsx`'s `<select>`, adapted to a row of six
    /// focusable chips — see the type doc comment for the never-localized
    /// label rationale and `AccountModel.changeLanguage` for the
    /// optimistic-flip mechanics.
    private func languageSection(client: OrbixClient) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(L10n.t("common.language"))
                .font(OrbixType.rowHeading)
                .foregroundStyle(OrbixColor.text)

            HStack(spacing: 16) {
                ForEach(Self.languages, id: \.code) { language in
                    languageChip(language, client: client)
                }
            }

            if let languageError = accountModel.languageError {
                Text(languageError)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("accountLanguageError")
            }
        }
        .focusSection()
        .accessibilityIdentifier("accountLanguageSection")
    }

    private func languageChip(_ language: (code: String, label: String), client: OrbixClient) -> some View {
        let isSelected = (model.activeProfile?.language ?? "en") == language.code
        return Button {
            Task { await accountModel.changeLanguage(to: language.code, client: client, appModel: model) }
        } label: {
            Text(language.label)
                .font(.system(size: 24, weight: isSelected ? .semibold : .regular))
                // The longer native labels ("Português", "Français") wrapped
                // to two lines at a fixed chip width — same single-line
                // shrink-to-fit idiom as `PinPadView`'s "Cancel" key label.
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .buttonStyle(LanguageChipStyle(isSelected: isSelected))
        .accessibilityIdentifier("accountLanguage_\(language.code)")
    }

    // MARK: - 3. Switch Profile

    /// Web `nav:switchProfile` — ghost button back to the picker
    /// (`AppModel.switchProfile()`), which now offers PIN entry for free
    /// (Task 2's single integration point).
    private var switchProfileSection: some View {
        Button(L10n.t("nav.switchProfile")) {
            model.switchProfile()
        }
        .buttonStyle(OrbixButtonStyle(.ghost))
        .focusSection()
        .accessibilityIdentifier("accountSwitchProfile")
    }

    // MARK: - 4. My Menu

    /// Web `ProfileMenuEditor.tsx`, adapted: the checkbox becomes a
    /// focusable toggle button (`checkmark.square.fill` / `square`), the
    /// `aria-label`ed ↑/↓ buttons stay literal disabled-at-the-ends reorder
    /// controls. `accountModel.config` gates loading/loaded exactly like the
    /// web's `isLoading || !data` guard.
    @ViewBuilder
    private func menuSection(client: OrbixClient) -> some View {
        // Bounded to a readable width — the web's own `max-w-xl` intent
        // (`ProfileMenuEditor.tsx:58`) — unlike `languageSection`'s chip row,
        // which needs the full content width to lay out six native labels
        // without truncating (see `content`'s `.frame(maxWidth: .infinity)`).
        VStack(alignment: .leading, spacing: 20) {
            Text(L10n.t("account.tabs.menu"))
                .font(OrbixType.rowHeading)
                .foregroundStyle(OrbixColor.text)
            Text(L10n.t("account.menu.intro"))
                .font(.callout)
                .foregroundStyle(OrbixColor.textDim)

            if let config = accountModel.config {
                let byId = Dictionary(uniqueKeysWithValues: config.libraries.map { ($0.libraryId, $0) })

                VStack(spacing: 12) {
                    ForEach(Array(accountModel.order.enumerated()), id: \.element) { index, id in
                        if let library = byId[id] {
                            menuRow(library, index: index, total: accountModel.order.count)
                        }
                    }
                }
                .focusSection()
                .accessibilityIdentifier("accountMenuList")

                menuSaveRow(client: client)
            } else if let menuError = accountModel.menuError {
                Text(menuError)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("accountMenuError")
            } else {
                ProgressView()
                    .accessibilityIdentifier("accountMenuLoading")
            }
        }
        .frame(maxWidth: 900, alignment: .leading)
        .accessibilityIdentifier("accountMenuSection")
    }

    private func menuRow(_ library: MenuItem, index: Int, total: Int) -> some View {
        let name = library.name ?? L10n.t("catalog.library.fallbackName")
        let isEnabled = accountModel.enabled.contains(library.libraryId)
        return HStack(spacing: 20) {
            Button {
                accountModel.toggle(library.libraryId)
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: isEnabled ? "checkmark.square.fill" : "square")
                        .font(.system(size: 26))
                        .foregroundStyle(isEnabled ? OrbixColor.accent : OrbixColor.textDim)
                    Text(name)
                        .font(.system(size: 26))
                        .foregroundStyle(OrbixColor.text)
                    Spacer()
                }
            }
            .buttonStyle(MenuToggleRowStyle())
            .accessibilityIdentifier("accountMenuRow_\(library.libraryId)")

            HStack(spacing: 4) {
                Button {
                    accountModel.move(index, -1)
                } label: {
                    Image(systemName: "chevron.up")
                }
                .buttonStyle(MenuMoveButtonStyle())
                .disabled(index == 0)
                .accessibilityIdentifier("accountMenuUp_\(library.libraryId)")
                .accessibilityLabel(L10n.t("account.menu.moveUp", name))

                Button {
                    accountModel.move(index, 1)
                } label: {
                    Image(systemName: "chevron.down")
                }
                .buttonStyle(MenuMoveButtonStyle())
                .disabled(index == total - 1)
                .accessibilityIdentifier("accountMenuDown_\(library.libraryId)")
                .accessibilityLabel(L10n.t("account.menu.moveDown", name))
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .background(OrbixColor.surface, in: RoundedRectangle(cornerRadius: OrbixRadius.sm, style: .continuous))
    }

    /// Save button + status line, mirroring the web's disabled-while-saving/
    /// disabled-when-empty button plus the mutually exclusive "select at
    /// least one" / "Saved." captions (`ProfileMenuEditor.tsx:86-90`).
    private func menuSaveRow(client: OrbixClient) -> some View {
        HStack(spacing: 16) {
            Button(accountModel.isSavingMenu ? L10n.t("common.status.saving") : L10n.t("account.menu.save")) {
                Task { await accountModel.saveMenu(client: client, appModel: model) }
            }
            .buttonStyle(OrbixButtonStyle(.primary))
            .disabled(accountModel.isSavingMenu || accountModel.noneEnabled)
            .accessibilityIdentifier("accountMenuSave")

            if accountModel.noneEnabled {
                Text(L10n.t("account.menu.selectOne"))
                    .font(.callout)
                    .foregroundStyle(OrbixColor.textDim)
                    .accessibilityIdentifier("accountMenuSelectOne")
            } else if accountModel.menuSaved {
                Text(L10n.t("account.menu.saved"))
                    .font(.callout)
                    .foregroundStyle(OrbixColor.textDim)
                    .accessibilityIdentifier("accountMenuSaved")
            }

            if let menuError = accountModel.menuError {
                Text(menuError)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("accountMenuSaveError")
            }
        }
        .focusSection()
    }

    // MARK: - 5. Server

    /// TV-only block (spec §7.11) — there's no browser devtools on a TV to
    /// check either of these, so they're surfaced here instead.
    private var serverSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L10n.t("account.server.heading"))
                .font(OrbixType.rowHeading)
                .foregroundStyle(OrbixColor.text)
            Text(model.baseURL?.absoluteString ?? L10n.t("account.server.url"))
                .font(.callout)
                .foregroundStyle(OrbixColor.textDim)
                .accessibilityIdentifier("accountServerURL")
            Text(appVersionString)
                .font(.callout)
                .foregroundStyle(OrbixColor.textDim)
                .accessibilityIdentifier("accountAppVersion")
        }
        .accessibilityIdentifier("accountServerSection")
    }

    /// `CFBundleShortVersionString (CFBundleVersion)`, e.g. "0.1 (1)" — `?`
    /// for either half defensively (a debug/simulator build always has both).
    private var appVersionString: String {
        let bundle = Bundle.main
        let short = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let build = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        return "\(short) (\(build))"
    }

    // MARK: - 6. Unlink Device

    /// TV-only (spec §7.11): danger-styled, confirms via `.alert` before
    /// calling `AppModel.unlinkDevice()` — client-side teardown only, see
    /// that method's doc comment.
    private var unlinkSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button(L10n.t("account.unlink.button")) {
                showUnlinkConfirm = true
            }
            .buttonStyle(OrbixButtonStyle(.danger))
            .accessibilityIdentifier("accountUnlink")
        }
        .focusSection()
        .accessibilityIdentifier("accountUnlinkSection")
        .alert(L10n.t("account.unlink.confirmTitle"), isPresented: $showUnlinkConfirm) {
            Button(L10n.t("common.actions.cancel"), role: .cancel) {}
                .accessibilityIdentifier("accountUnlinkCancel")
            Button(L10n.t("account.unlink.confirmButton"), role: .destructive) {
                Task { await model.unlinkDevice() }
            }
            .accessibilityIdentifier("accountUnlinkConfirm")
        } message: {
            Text(L10n.t("account.unlink.confirmBody"))
        }
    }
}

// MARK: - Styles

/// Language chip focus/selection styling — the same accent-tinted-selected /
/// white-on-focus idiom as `LibraryBrowseView`'s `SortChipStyle` (not reused
/// directly: that type is private to its file), applied to the six native
/// language labels instead of the three sort options.
private struct LanguageChipStyle: ButtonStyle {
    let isSelected: Bool
    @Environment(\.isFocused) private var isFocused

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(isFocused ? Color.white : (isSelected ? Color.white : OrbixColor.textDim))
            .padding(.horizontal, 28)
            .padding(.vertical, 14)
            .background(background, in: RoundedRectangle(cornerRadius: OrbixRadius.sm, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: OrbixRadius.sm, style: .continuous)
                    .strokeBorder(OrbixColor.surface2, lineWidth: isSelected || isFocused ? 0 : 1)
            )
            .overlay(
                RoundedRectangle(cornerRadius: OrbixRadius.sm, style: .continuous)
                    .strokeBorder(Color.white, lineWidth: isFocused ? 3 : 0)
            )
            .scaleEffect(isFocused ? 1.06 : 1.0)
            .animation(.easeOut(duration: 0.15), value: isFocused)
            .focusEffectDisabled()
    }

    private var background: Color {
        isFocused ? Color.white.opacity(0.25) : (isSelected ? OrbixColor.accent : OrbixColor.surface)
    }
}

/// The menu editor's toggle row: a plain text-scale focus emphasis (no
/// platter — the row already sits on its own `OrbixColor.surface` plate from
/// `menuRow`), matching how `TvChannelView`'s row-style buttons read focus.
private struct MenuToggleRowStyle: ButtonStyle {
    @Environment(\.isFocused) private var isFocused

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(isFocused ? 1.02 : 1.0)
            .opacity(isFocused ? 1.0 : 0.9)
            .animation(.easeOut(duration: 0.15), value: isFocused)
    }
}

/// A ↑/↓ reorder button: dims when `disabled` (index at either end — web's
/// `disabled:opacity-30`), a soft white platter + scale on focus.
private struct MenuMoveButtonStyle: ButtonStyle {
    @Environment(\.isFocused) private var isFocused
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 22, weight: .semibold))
            .foregroundStyle(isFocused ? Color.white : OrbixColor.textDim)
            .frame(width: 44, height: 44)
            .background(isFocused ? Color.white.opacity(0.2) : Color.clear, in: Circle())
            .opacity(isEnabled ? 1.0 : 0.3)
            .scaleEffect(isFocused ? 1.08 : 1.0)
            .animation(.easeOut(duration: 0.15), value: isFocused)
    }
}

#Preview {
    AccountView(model: AppModel(), onMenuExit: {})
}
