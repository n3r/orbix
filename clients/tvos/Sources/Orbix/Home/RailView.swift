import OrbixKit
import SwiftUI

/// A single Home rail: heading + a horizontal, focus-sectioned strip of
/// `BoxArtCard`s — tvOS port of the web's `apps/web/src/components/MediaRow.tsx`.
/// Mirrors the focus-rail structure `HomeView.railView` already uses for
/// `PosterCard` (heading, `ScrollView(.horizontal)` + `LazyHStack` +
/// `.focusSection()` + vertical headroom padding so focus-scale doesn't
/// clip), just with `BoxArtCard`'s 16:9 lockup and gap instead of
/// `PosterCard`'s 2:3 grid.
///
/// The web renders hover-only chevron paddles that page the strip
/// (`MediaRow.tsx`'s `canScroll`/`page` state + `paddle` buttons); tvOS has no
/// hover, so there is intentionally **no paddle UI** here — horizontal
/// movement is entirely focus-driven, the same adaptation `HomeView.railView`
/// already made (the focus engine auto-scrolls to keep the focused card
/// on-screen as the remote's D-pad moves focus within the `.focusSection()`).
///
/// Heading text mirrors the web's `LOCALIZED_ROW_KEYS` override
/// (`MediaRow.tsx:22-30`): the static UI-chrome row keys are localized by
/// key via `L10n.t("catalog.rows.\(row.key)")`; every other (data-bearing)
/// row falls back to the server-provided `row.title`.
struct RailView: View {
    let row: HomeRow
    let baseURL: URL?
    let imageLoader: ImageLoader
    var onSelect: (MediaCard) -> Void

    /// Home-row keys whose headings are static UI chrome and can be
    /// localized by key. Data-bearing rows (e.g. "becauseYouWatched" and
    /// "genre:*", whose headings embed a media title / localized genre name)
    /// are not listed and fall back to the server-provided `row.title`.
    /// Kept byte-for-byte in sync with the web's `LOCALIZED_ROW_KEYS`
    /// (`MediaRow.tsx:22-30`).
    private static let localizedRowKeys: Set<String> = [
        "continue", "wishlist", "recentlyAdded", "hiddenGems", "tonight", "topRated", "series",
    ]

    private var heading: String {
        Self.localizedRowKeys.contains(row.key) ? L10n.t("catalog.rows.\(row.key)") : row.title
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(heading)
                .font(OrbixType.rowHeading)
                .foregroundStyle(OrbixColor.text)
                .padding(.leading, 4)

            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: OrbixSpacing.cardGap) {
                    ForEach(row.items, id: \.id) { card in
                        BoxArtCard(card: card, baseURL: baseURL, imageLoader: imageLoader) {
                            onSelect(card)
                        }
                    }
                }
                // Vertical headroom so a card's scale-on-focus growth
                // doesn't visually clip against the rail above/below (same
                // rationale as HomeView.railView).
                .padding(.horizontal, 4)
                .padding(.vertical, 16)
            }
            // Each rail is its own focus section: the tvOS focus engine
            // moves within a rail on left/right and hands off to the
            // adjacent rail on up/down, rather than treating every card on
            // screen as one flat focus group.
            .focusSection()
        }
        .accessibilityIdentifier("homeRail_\(row.key)")
    }
}

#Preview {
    RailView(
        row: HomeRow(
            key: "continue",
            title: "Continue Watching",
            items: [
                MediaCard(
                    id: "1",
                    title: "Arrival",
                    year: 2016,
                    progress: MediaCard.Progress(positionSec: 3200, durationSec: 6600)
                ),
                MediaCard(id: "2", title: "The Long Title Of A Movie", year: 2020),
                MediaCard(id: "3", title: "Freshly Added", addedAt: ISO8601DateFormatter().string(from: Date())),
            ]
        ),
        baseURL: nil,
        imageLoader: ImageLoader(),
        onSelect: { _ in }
    )
    .padding(.vertical, 40)
    .background(OrbixColor.bg)
}
