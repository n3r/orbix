import OrbixKit
import SwiftUI

/// 16:9 channel tile for the TV Home rails — tvOS port of
/// `apps/web/src/components/tv/ChannelCard.tsx`. `ChannelLogoView(gradient:
/// true)` art (cached logo, or a deterministic hue-hashed gradient monogram
/// fallback) sits under a bottom scrim carrying number · name · `QualityChip`
/// and, when airing, the now-playing title + a red `NowProgressBar`. Same
/// `.frame` size as `BoxArtCard` (both are 16:9 lockups living in a rail), so
/// TV Home's rails read as one system with Home's.
///
/// Web→tvOS adaptations:
/// - The web's hover-revealed heart button (`ChannelCard.tsx` lines 89-101,
///   a positioned sibling above the play hit-area) has no tvOS analogue — no
///   hover, and a second focusable target inside one card would fight the
///   card's own Select-to-play affordance. Ported as a **`.contextMenu`**
///   (tvOS long-press Select) instead, the same "secondary action on a card"
///   pattern the brief specifies; the label ("Add to Favorites"/"Remove from
///   Favorites") reflects current membership exactly like the web's
///   `aria-label` swap.
/// - Offline dim: the web wraps *both* the art and the scrim in one
///   `opacity-50` div, leaving the status dot (a later, un-dimmed sibling)
///   at full strength so the reason for the dimming stays legible
///   (`ChannelCard.tsx` lines 39, 73-79) — ported 1:1 below: `artAndScrim`
///   carries the conditional `.opacity`, `offlineDot` sits outside it.
/// - Focus-promote + disabled system platter follows the exact
///   `BoxArtCardStyle` precedent (`Home/BoxArtCard.swift`): a plain
///   custom-content `Button` draws a bright platter behind it on tvOS by
///   default, which would clash with the card's own art/scrim.
struct ChannelCard: View {
    let channel: TvChannelCard
    let baseURL: URL?
    let imageLoader: ImageLoader
    var onPlay: () -> Void
    var onToggleFavorite: () -> Void

    /// Identical lockup to `BoxArtCard.width/height` — both are 16:9 rail
    /// tiles, so Home and TV Home rails read as one system.
    static let width: CGFloat = 460
    static let height: CGFloat = 259 // 460 * 9/16

    var body: some View {
        Button(action: onPlay) {
            ZStack(alignment: .topLeading) {
                artAndScrim
                    .opacity(channel.healthy ? 1 : 0.5)

                if !channel.healthy {
                    offlineDot
                }
            }
            .frame(width: Self.width, height: Self.height)
        }
        .buttonStyle(ChannelCardStyle())
        .contextMenu {
            Button(
                channel.favorite ? L10n.t("tv.card.unfavoriteMenuLabel") : L10n.t("tv.card.favoriteMenuLabel"),
                action: onToggleFavorite
            )
        }
        .accessibilityIdentifier("channelCard_\(channel.id)")
        .accessibilityLabel(L10n.t("tv.card.play", channel.name))
    }

    // MARK: - Art + scrim (dim together when offline)

    private var artAndScrim: some View {
        ZStack(alignment: .bottom) {
            // A background fill behind the logo so a real (non-16:9) logo
            // image never letterboxes to transparent — matches the OSD's
            // `.background(.white.opacity(0.1))` treatment of the same view.
            OrbixColor.surface
            ChannelLogoView(
                logo: channel.logo,
                name: channel.name,
                channelId: channel.id,
                baseURL: baseURL,
                imageLoader: imageLoader,
                gradient: true
            )
            scrim
        }
        .frame(width: Self.width, height: Self.height)
    }

    /// Bottom black→clear gradient plate: number · name · quality chip, then
    /// (when airing) the now title + red progress bar — web lines 51-70.
    private var scrim: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("\(channel.number)")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.white.opacity(0.6))
                Text(channel.name)
                    .font(.callout.weight(.medium))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                if let quality = channel.quality {
                    QualityChip(label: quality)
                }
            }

            // No now/next label when nothing airs — cards stay clean without
            // EPG data (web line 63's comment, ported verbatim).
            if let now = channel.now {
                VStack(alignment: .leading, spacing: 3) {
                    Text(now.title)
                        .font(.caption2)
                        .foregroundStyle(.white.opacity(0.7))
                        .lineLimit(1)
                    NowProgressBar(fraction: tvNowProgressFraction(startISO: now.start, stopISO: now.stop))
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 30)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            LinearGradient(
                stops: [
                    .init(color: .black.opacity(0.82), location: 0),
                    .init(color: .clear, location: 1),
                ],
                startPoint: .bottom,
                endPoint: .top
            )
        )
    }

    /// Status dot — deliberately outside `artAndScrim`'s dim, so the reason
    /// for the dimming stays legible at full strength (web lines 73-79).
    private var offlineDot: some View {
        Circle()
            .fill(Color(white: 0.42)) // web `bg-zinc-500`
            .frame(width: 12, height: 12)
            .padding(10)
            .accessibilityLabel(L10n.t("tv.badges.offline"))
    }
}

/// Clips to `OrbixRadius.md` and applies the web-parity `focusPromote` scale,
/// disabling the system focus platter — identical treatment to
/// `Home/BoxArtCard.swift`'s `BoxArtCardStyle`.
private struct ChannelCardStyle: ButtonStyle {
    @Environment(\.isFocused) private var isFocused

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .clipShape(RoundedRectangle(cornerRadius: OrbixRadius.md, style: .continuous))
            .focusPromote(isFocused)
            .focusEffectDisabled()
    }
}

#Preview("Healthy / offline / no-logo / no-now") {
    let now = TvProgrammeSlot(
        title: "The Ten O'Clock News",
        start: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-600)),
        stop: ISO8601DateFormatter().string(from: Date().addingTimeInterval(1200))
    )
    return HStack(spacing: OrbixSpacing.cardGap) {
        ChannelCard(
            channel: TvChannelCard(
                id: "bbc-one", number: 101, name: "BBC One HD", categories: ["general"],
                quality: "HD", healthy: true, favorite: false, now: now
            ),
            baseURL: nil,
            imageLoader: ImageLoader(),
            onPlay: {},
            onToggleFavorite: {}
        )
        ChannelCard(
            channel: TvChannelCard(
                id: "disco", number: 303, name: "Discovery Science", categories: ["science"],
                quality: "4K", healthy: false, favorite: true
            ),
            baseURL: nil,
            imageLoader: ImageLoader(),
            onPlay: {},
            onToggleFavorite: {}
        )
    }
    .padding(40)
    .background(OrbixColor.bg)
}
