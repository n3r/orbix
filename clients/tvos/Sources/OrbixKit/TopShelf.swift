import Foundation

/// The custom URL scheme the Top Shelf items open when selected on the Apple
/// TV home screen. Registered by the app in its Info.plist `CFBundleURLTypes`
/// and handled in `RootView`'s `.onOpenURL`.
public let orbixDeepLinkScheme = "orbix"

/// `orbix://item/<id>` — the deep link a Top Shelf item carries as its
/// `displayAction`, opening the title page for `id` inside the app.
public func orbixItemDeepLink(itemId: String) -> URL {
    let encoded = itemId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? itemId
    return URL(string: "\(orbixDeepLinkScheme)://item/\(encoded)") ?? URL(string: "\(orbixDeepLinkScheme)://item")!
}

/// Parses an `orbix://item/<id>` deep link back to its item id, or `nil` if
/// `url` isn't a well-formed Orbix item link. The inverse of
/// `orbixItemDeepLink(itemId:)`.
public func orbixItemId(from url: URL) -> String? {
    guard url.scheme == orbixDeepLinkScheme, url.host == "item" else { return nil }
    let id = url.lastPathComponent
    guard !id.isEmpty, id != "item", id != "/" else { return nil }
    return id.removingPercentEncoding ?? id
}

/// A pure, `Sendable` description of the Top Shelf content the extension
/// renders above the app icon on the Apple TV home screen — derived from
/// `/api/home/rows` with **no TVServices dependency**, so it's unit-testable
/// without the extension process (see `TopShelfContentTests`). The extension
/// maps this to `TVTopShelfSectionedContent` (see
/// `OrbixTopShelf/TopShelfContentProvider`).
public struct TopShelfContent: Sendable, Equatable {
    public var sections: [Section]

    public init(sections: [Section]) {
        self.sections = sections
    }

    /// The two curated sections surfaced to the Top Shelf, each with its own
    /// localized header (resolved from OrbixKit's shared catalog so the header
    /// is Russian on a Russian Apple TV, unlike the app's server-provided row
    /// titles which the server sends in English).
    public enum SectionKind: String, Sendable, Equatable {
        case continueWatching
        case recommended

        public var localizedTitle: String {
            switch self {
            case .continueWatching: return OrbixLocalized("Continue Watching")
            case .recommended: return OrbixLocalized("Recommended")
            }
        }
    }

    public struct Section: Sendable, Equatable {
        public var kind: SectionKind
        public var items: [Item]

        public init(kind: SectionKind, items: [Item]) {
            self.kind = kind
            self.items = items
        }
    }

    public struct Item: Sendable, Equatable, Identifiable {
        public var id: String
        public var title: String
        public var posterURL: URL?
        public var displayURL: URL
        /// `0...1` resume fraction for a Continue-Watching item, else `nil`
        /// (nothing to show a progress bar for on a fresh recommendation).
        public var playbackProgress: Double?

        public init(id: String, title: String, posterURL: URL?, displayURL: URL, playbackProgress: Double?) {
            self.id = id
            self.title = title
            self.posterURL = posterURL
            self.displayURL = displayURL
            self.playbackProgress = playbackProgress
        }
    }
}

/// Maps `/api/home/rows` into Top Shelf sections: "Continue Watching" (server
/// row key `continue`, carrying each card's resume fraction) followed by
/// "Recommended" (the curated `tonight` row, falling back to `hiddenGems`).
/// Empty sections are omitted, and each section is capped at
/// `maxItemsPerSection`. Pure — same input always yields the same output, no
/// network/clock — so the extension's content logic is testable in isolation.
public func buildTopShelfContent(
    from rows: HomeRows,
    baseURL: URL,
    maxItemsPerSection: Int = 12
) -> TopShelfContent {
    func items(forRowKey rowKey: String) -> [TopShelfContent.Item] {
        guard let row = rows.rows.first(where: { $0.key == rowKey }) else { return [] }
        return row.items.prefix(maxItemsPerSection).map { card in
            let posterURL = card.posterPath.map { baseURL.appending(path: "api/images/\($0)") }
            let progress: Double?
            if let cardProgress = card.progress, cardProgress.durationSec > 0 {
                progress = min(1, max(0, Double(cardProgress.positionSec) / Double(cardProgress.durationSec)))
            } else {
                progress = nil
            }
            return TopShelfContent.Item(
                id: card.id,
                title: card.title,
                posterURL: posterURL,
                displayURL: orbixItemDeepLink(itemId: card.id),
                playbackProgress: progress
            )
        }
    }

    var sections: [TopShelfContent.Section] = []

    let continueItems = items(forRowKey: "continue")
    if !continueItems.isEmpty {
        sections.append(.init(kind: .continueWatching, items: continueItems))
    }

    // "Recommended" prefers the curated `tonight` row and falls back to
    // `hiddenGems`; both are unplayed-title rows, so this never re-surfaces a
    // title already in Continue Watching.
    var recommendedItems = items(forRowKey: "tonight")
    if recommendedItems.isEmpty {
        recommendedItems = items(forRowKey: "hiddenGems")
    }
    if !recommendedItems.isEmpty {
        sections.append(.init(kind: .recommended, items: recommendedItems))
    }

    return TopShelfContent(sections: sections)
}
