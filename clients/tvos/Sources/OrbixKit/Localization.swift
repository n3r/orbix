import Foundation

/// Marker type used only to locate the OrbixKit framework bundle at runtime
/// (`Bundle(for:)` needs a class, and OrbixKit is otherwise all
/// actors/structs). OrbixKit's shared `Localizable.xcstrings` — resolved by
/// the app, the Top Shelf extension, and the unit tests alike — is compiled
/// into this bundle.
final class OrbixKitBundleToken {}

public extension Bundle {
    /// The OrbixKit framework's own bundle, where OrbixKit's `Localizable`
    /// string catalog is compiled to per-language `.lproj`s. The Top Shelf
    /// extension runs in a *separate process* and can't reach the app bundle,
    /// so any string it shares with the app is resolved from here instead.
    static let orbixKit = Bundle(for: OrbixKitBundleToken.self)
}

/// Resolves a localized string from OrbixKit's shared catalog (EN/RU). Used by
/// non-`Text` call sites — the Top Shelf extension's TVServices section titles
/// and any plain-`String` context — where SwiftUI's automatic
/// `LocalizedStringKey` localization isn't available. SwiftUI views in the app
/// keep using `Text("…")` literals against the app's own catalog; this is the
/// escape hatch for everything else.
public func OrbixLocalized(_ key: String.LocalizationValue) -> String {
    String(localized: key, bundle: .orbixKit)
}
