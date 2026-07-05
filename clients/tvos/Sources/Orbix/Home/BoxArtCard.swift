import OrbixKit
import SwiftUI
import UIKit

/// Netflix-style 16:9 landscape box-art card for Home rails — tvOS port of
/// the web's `apps/web/src/components/BoxArtCard.tsx`. Backdrop art first,
/// poster as a cover-crop fallback, a gradient plate when neither is
/// available (web lines 22, 37-48); a bottom title/subtitle plate always
/// names the card since the art has no baked-in title text (web line 50);
/// a top-leading `NewBadge` for recently-added titles (web lines 57-61); and
/// a thin `ProgressBarView` pinned to the bottom edge for in-progress titles
/// (web lines 63-67, the shared accent progress bar).
///
/// Unlike `PosterCard` (Apple's `.card` button style), this needs a *specific*
/// 1.04 hover-scale to match the web's `hover:scale-[1.04]` — `.card`'s
/// built-in focus scale doesn't encode that number — so it's a custom
/// `Button` styled by `BoxArtCardStyle`, which also disables the system focus
/// platter the same way `ProfileTileButtonStyle` does (`.focusEffectDisabled()`
/// + `focusPromote`), since a plain custom-content `Button` on tvOS draws a
/// bright platter behind it by default that would clash with the card's own
/// art and gradient plate.
struct BoxArtCard: View {
    let card: MediaCard
    let baseURL: URL?
    let imageLoader: ImageLoader
    var onSelect: () -> Void

    /// 16:9 at a size that reads as a landscape strip in a rail, matching the
    /// web's `aspect-video` box-art cards.
    static let width: CGFloat = 460
    static let height: CGFloat = 259 // 460 * 9/16

    var body: some View {
        Button(action: onSelect) {
            ZStack(alignment: .topLeading) {
                art

                VStack {
                    Spacer()
                    titlePlate
                }

                if isNew(addedAt: card.addedAt, now: Date()) {
                    NewBadge()
                        .padding(8)
                }

                if let progressFraction {
                    VStack {
                        Spacer()
                        ProgressBarView(fraction: progressFraction)
                    }
                }
            }
            .frame(width: Self.width, height: Self.height)
        }
        .buttonStyle(BoxArtCardStyle())
        .accessibilityIdentifier("boxArtCard_\(card.id)")
    }

    /// Backdrop → poster (cover-crop) → gradient plate — web lines 20-22,
    /// 37-48. The web additionally gates art on `matchState` (only
    /// "matched"/"manual"/absent show art); Home cards never carry
    /// `matchState` (it's only sent on the narrower catalog/wishlist/search
    /// shapes — see `MediaCard`'s doc comment), so that check is inert here
    /// but kept for correctness if this card is ever reused off Home.
    @ViewBuilder
    private var art: some View {
        let matched = card.matchState == nil || card.matchState == "matched" || card.matchState == "manual"
        if matched, let artURL {
            BoxArtImage(url: artURL, imageLoader: imageLoader)
        } else {
            LinearGradient(
                colors: [OrbixColor.surface2, OrbixColor.surface],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        }
    }

    private var artURL: URL? {
        guard let baseURL else { return nil }
        if let backdropPath = card.backdropPath {
            return baseURL.appending(path: "api/images/\(backdropPath)")
        }
        if let posterPath = card.posterPath {
            return baseURL.appending(path: "api/images/\(posterPath)")
        }
        return nil
    }

    /// Title + subtitle over a bottom black 0.8→0 gradient (web line 50);
    /// subtitle is the resume label when in-progress, else the year (web
    /// line 24).
    private var titlePlate: some View {
        ZStack(alignment: .bottomLeading) {
            LinearGradient(
                stops: [
                    .init(color: .black.opacity(0.8), location: 0),
                    .init(color: .clear, location: 1),
                ],
                startPoint: .bottom,
                endPoint: .top
            )
            .frame(height: 120)

            VStack(alignment: .leading, spacing: 2) {
                Text(card.title)
                    .font(.callout.weight(.medium))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                if let subtitle {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.8))
                        .lineLimit(1)
                }
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 10)
        }
    }

    private var subtitle: String? {
        resumeLabel(card.resume) ?? card.year.map(String.init)
    }

    /// `positionSec / durationSec`, `nil` (no bar) when there's no
    /// `progress` or a non-positive `durationSec` (web line 63 gates the
    /// same way via `progressPct`).
    private var progressFraction: Double? {
        guard let progress = card.progress, progress.durationSec > 0 else { return nil }
        return Double(progress.positionSec) / Double(progress.durationSec)
    }
}

/// Box-art fetched via `ImageLoader`; a plain surface fill while loading or
/// on a missing/failed fetch (the gradient-plate fallback above already
/// handles "no art at all" — this placeholder is just the in-flight/failure
/// state for a URL that does exist). Same `.task(id:)` idiom as
/// `PosterCard`'s `PosterArtwork`.
private struct BoxArtImage: View {
    let url: URL
    let imageLoader: ImageLoader

    @State private var uiImage: UIImage?

    var body: some View {
        ZStack {
            Rectangle().fill(OrbixColor.surface2)
            if let uiImage {
                Image(uiImage: uiImage)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            }
        }
        .clipped()
        .task(id: url) {
            uiImage = nil
            if let data = await imageLoader.image(for: url) {
                uiImage = UIImage(data: data)
            }
        }
    }
}

/// Clips the card to `OrbixRadius.md` and applies the web-parity
/// `focusPromote` scale, disabling the system focus platter that would
/// otherwise draw behind this custom-content button (same precedent as
/// `ProfileTileButtonStyle` in `Onboarding/ProfilePickerView.swift`).
private struct BoxArtCardStyle: ButtonStyle {
    @Environment(\.isFocused) private var isFocused

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .clipShape(RoundedRectangle(cornerRadius: OrbixRadius.md, style: .continuous))
            .focusPromote(isFocused)
            .focusEffectDisabled()
    }
}

#Preview {
    HStack(spacing: OrbixSpacing.cardGap) {
        BoxArtCard(
            card: MediaCard(id: "1", title: "Arrival", year: 2016),
            baseURL: nil,
            imageLoader: ImageLoader(),
            onSelect: {}
        )
        BoxArtCard(
            card: MediaCard(
                id: "2",
                title: "Some Series With A Rather Long Title",
                year: 2020,
                progress: MediaCard.Progress(positionSec: 900, durationSec: 1500),
                resume: MediaCard.Resume(seasonNumber: 3, episodeNumber: 4, episodeTitle: "Old Friends")
            ),
            baseURL: nil,
            imageLoader: ImageLoader(),
            onSelect: {}
        )
        BoxArtCard(
            card: MediaCard(id: "3", title: "Freshly Added", addedAt: ISO8601DateFormatter().string(from: Date())),
            baseURL: nil,
            imageLoader: ImageLoader(),
            onSelect: {}
        )
    }
    .padding(60)
    .background(OrbixColor.bg)
}
