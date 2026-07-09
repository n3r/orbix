import OrbixKit
import SwiftUI

/// Drives `AccountView`'s "My Menu" editor + the language-switch bridge —
/// tvOS port of the web `ProfileMenuEditor.tsx`'s local component state
/// (`order`/`enabled`/`saving`/`saved`) plus `LanguageSwitcher.tsx`'s
/// PATCH-and-persist call, adapted to `AppModel` being this app's single
/// source of truth for the active profile (the web instead re-reads
/// `useMyProfile()`/`i18n.language` after its own PATCH).
///
/// **Menu editor.** `loadMenuConfig` seeds `order`/`enabled` from
/// `GET /me/menu/config` exactly like the web effect (`ProfileMenuEditor.tsx:19-25`):
/// enabled ids first in their saved order, then every other library in
/// default (catalog) order — so an unsaved toggle/reorder is local-only until
/// `saveMenu` PUTs it, and a save immediately hands the fresh `[MenuItem]]`
/// to `AppModel.applyMenu` (the TV's analogue of the web's `["menu"]` query
/// invalidation) so the top bar's categories update without a refetch.
///
/// **Language switch.** `changeLanguage` uses the same optimistic
/// flip-then-revert-on-throw idiom as `TitlePage.toggleWishlist`/
/// `TvChannelView.toggleFavorite`, except the thing being flipped —
/// `AppModel.activeProfile?.language` — has no raw setter (`activeProfile`
/// is `private(set)`): `AppModel.profileLanguageChanged(_:)` *is* the one
/// mutation point, so it's called both to apply the flip up front and, on a
/// thrown `updateProfile`, to call it again with the pre-change value to
/// revert. The PATCH triggers `ensureMetadataLanguage` server-side (catalog
/// re-localization, which runs to completion independently of this call
/// returning) — "optimistic" here means the local chip selection and
/// `activeProfile.language` flip the moment the PATCH itself succeeds,
/// without waiting to observe that re-localization finish. **UI-string
/// flipping is Task 5**: until `AppModel` grows `applyUILanguage()`, a
/// successful switch here persists the choice and re-localizes the catalog,
/// but every label in the TV chrome (including this screen) stays English.
@MainActor
@Observable
final class AccountModel {
    private(set) var config: MenuConfig?
    private(set) var order: [String] = []
    private(set) var enabled: Set<String> = []
    private(set) var isSavingMenu = false
    private(set) var menuSaved = false
    private(set) var menuError: String?
    private(set) var languageError: String?

    var noneEnabled: Bool { enabled.isEmpty }

    /// Seed exactly like the web (ProfileMenuEditor.tsx:19-25): enabled ids
    /// first in saved order, then the rest in default (library) order.
    func loadMenuConfig(client: OrbixClient) async {
        guard config == nil else { return }
        do {
            let cfg = try await client.menuConfig()
            config = cfg
            let rest = cfg.libraries.map(\.libraryId).filter { !cfg.enabled.contains($0) }
            order = cfg.enabled + rest
            enabled = Set(cfg.enabled)
        } catch {
            if case OrbixError.http(_, let code) = error, let code {
                menuError = L10n.errorMessage(code)
            } else {
                menuError = L10n.t("account.menu.loadFailed")
            }
        }
    }

    func toggle(_ id: String) {
        if enabled.contains(id) { enabled.remove(id) } else { enabled.insert(id) }
        menuSaved = false
    }

    func move(_ index: Int, _ dir: Int) {
        order = menuMoveItem(order, index: index, dir: dir)
        menuSaved = false
    }

    func saveMenu(client: OrbixClient, appModel: AppModel) async {
        let libraryIds = order.filter(enabled.contains)
        guard !libraryIds.isEmpty, !isSavingMenu else { return } // ≥1 enforced (server 400s "empty" too)
        isSavingMenu = true
        menuError = nil
        do {
            let items = try await client.saveMenu(libraryIds: libraryIds)
            appModel.applyMenu(items)
            menuSaved = true
        } catch {
            if case OrbixError.http(_, let code) = error, let code {
                menuError = L10n.errorMessage(code)
            } else {
                menuError = L10n.t("account.menu.saveFailed")
            }
        }
        isSavingMenu = false
    }

    /// Language chip selection. A no-op when `code` already matches the
    /// active profile's language (selecting the already-selected chip PATCHes
    /// nothing). Otherwise: flip `appModel.activeProfile?.language` to `code`
    /// immediately via `profileLanguageChanged` (the optimistic step — see
    /// the type doc comment), PATCH the server, and on failure call
    /// `profileLanguageChanged` again with the pre-change value to revert,
    /// surfacing `languageError` for the screen to show.
    func changeLanguage(to code: String, client: OrbixClient, appModel: AppModel) async {
        guard let profileId = appModel.activeProfile?.id else { return }
        let previous = appModel.activeProfile?.language ?? "en"
        guard code != previous else { return }

        languageError = nil
        appModel.profileLanguageChanged(code)
        do {
            _ = try await client.updateProfile(id: profileId, language: code)
        } catch {
            appModel.profileLanguageChanged(previous)
            if case OrbixError.http(_, let code) = error, let code {
                languageError = L10n.errorMessage(code)
            } else {
                languageError = L10n.t("account.language.error")
            }
        }
    }
}
