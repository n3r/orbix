import Foundation

/// Resolves UI strings against the active profile's language (spec §9), not
/// the system language. `override == nil` (onboarding, no profile yet) falls
/// through to Bundle.main — the system language with normal en fallback —
/// mirroring the web's detectInitialLanguage() → profile-override split.
enum L10n {
    /// "en"…"fr", or nil to follow the system. Written only from the main
    /// actor (AppModel.applyUILanguage, Task 5); views re-render via
    /// ShellView/RootView's `.id(uiLanguage)`, not observation of this static.
    nonisolated(unsafe) static var override: String?

    private static let missing = "\u{1}orbix.missing\u{1}"

    static func bundle(for code: String?) -> Bundle {
        guard let code,
              let path = Bundle.main.path(forResource: code, ofType: "lproj"),
              let bundle = Bundle(path: path) else { return .main }
        return bundle
    }
    private static let english = bundle(for: "en")

    /// Key lookup with an explicit en fallback: a language .lproj that lacks
    /// a key does NOT fall back across languages on its own — it would return
    /// the key. Missing everywhere → the key itself (visible in dev, never blank).
    static func t(_ key: String) -> String {
        let s = bundle(for: override).localizedString(forKey: key, value: missing, table: nil)
        if s != missing { return s }
        let en = english.localizedString(forKey: key, value: missing, table: nil)
        return en == missing ? key : en
    }

    /// Format-style lookup ("title.episodeNumber" = "Episode %lld").
    static func t(_ key: String, _ args: CVarArg...) -> String {
        String(format: t(key), locale: locale, arguments: args)
    }

    /// Plural-variation lookup: xcstrings plural variations compile to the
    /// stringsdict mechanism; String(format:locale:) applies the plural rule
    /// for the override language (e.g. ru one/few/many) at format time.
    static func plural(_ key: String, _ count: Int) -> String {
        String(format: t(key), locale: locale, count)
    }

    static var locale: Locale { override.map(Locale.init(identifier:)) ?? .current }

    /// Port of the web errorMessage (tError.ts): {error: code} → errors.<code>,
    /// unknown/missing code → errors.unknown — never a raw code on screen.
    static func errorMessage(_ code: String?) -> String {
        guard let code, !code.isEmpty else { return t("errors.unknown") }
        let msg = t("errors.\(code)")
        return msg == "errors.\(code)" ? t("errors.unknown") : msg
    }
}
