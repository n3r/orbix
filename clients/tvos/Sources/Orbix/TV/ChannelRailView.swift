import OrbixKit
import SwiftUI

/// One TV Home rail: heading + a horizontal, focus-sectioned strip of
/// `ChannelCard`s — tvOS port of `apps/web/src/components/tv/ChannelRail.tsx`.
/// Structurally identical to `Home/RailView.swift` (heading, `ScrollView(.horizontal)`
/// + `LazyHStack` + `.focusSection()` + vertical headroom padding for the
/// focus-scale growth), just with `ChannelCard`'s 16:9 lockup/gap instead of
/// `BoxArtCard`'s.
///
/// Like `RailView`, there is intentionally **no paddle UI** — the web's
/// hover-only chevron paddles (`ChannelRail.tsx`'s `canScroll`/`page` state)
/// have no tvOS analogue; horizontal movement is entirely focus-driven, and
/// the focus engine auto-scrolls to keep the focused card on-screen.
///
/// `onPlay` hands the rail's *own* channel list as the zap context (web
/// `onPlay(ch, channels)`, line 66) — selecting a card three rails down still
/// zaps through that rail's channels, not some other rail's.
struct ChannelRailView: View {
    /// Used only for the accessibility identifier (`channelRail_\(id)`) — a
    /// stable per-rail key (`"recents"`, `"favorites"`, `"country_GB"`,
    /// `"category_news"`), distinct from `title` (which is the localized/
    /// display heading).
    let id: String
    let title: String
    let channels: [TvChannelCard]
    let baseURL: URL?
    let imageLoader: ImageLoader
    var onPlay: (TvChannelCard, [TvChannelCard]) -> Void
    var onToggleFavorite: (TvChannelCard) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(title)
                .font(OrbixType.rowHeading)
                .foregroundStyle(OrbixColor.text)
                .padding(.leading, 4)

            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: OrbixSpacing.cardGap) {
                    ForEach(channels, id: \.id) { channel in
                        ChannelCard(
                            channel: channel,
                            baseURL: baseURL,
                            imageLoader: imageLoader,
                            onPlay: { onPlay(channel, channels) },
                            onToggleFavorite: { onToggleFavorite(channel) }
                        )
                    }
                }
                // Vertical headroom so a card's scale-on-focus growth doesn't
                // visually clip against the rail above/below (same rationale
                // as RailView).
                .padding(.horizontal, 4)
                .padding(.vertical, 16)
            }
            // Each rail is its own focus section: left/right moves within the
            // rail, up/down hands off to the adjacent rail.
            .focusSection()
        }
        .accessibilityIdentifier("channelRail_\(id)")
    }
}

#Preview {
    ChannelRailView(
        id: "favorites",
        title: "Favorites",
        channels: [
            TvChannelCard(id: "bbc-one", number: 101, name: "BBC One HD", categories: ["general"], quality: "HD", healthy: true, favorite: true),
            TvChannelCard(id: "cnn", number: 202, name: "CNN International", categories: ["news"], quality: "HD", healthy: true, favorite: true),
            TvChannelCard(id: "disco", number: 303, name: "Discovery Science", categories: ["science"], quality: "4K", healthy: false, favorite: true),
        ],
        baseURL: nil,
        imageLoader: ImageLoader(),
        onPlay: { _, _ in },
        onToggleFavorite: { _ in }
    )
    .padding(.vertical, 40)
    .background(OrbixColor.bg)
}
