import OrbixKit
import SwiftUI
import UIKit

/// A single focusable poster in a `HomeView` rail: 2:3 art (via
/// `ImageLoader`, with a placeholder while loading or on a missing/failed
/// poster), title + year below, and — when `card.progress` is present — a
/// thin resume-progress bar along the poster's bottom edge.
///
/// Built as a `Button` styled `.card`, the same lockup convention already
/// proven in this codebase for tvOS focusable art (the M1 `SpikeListView`'s
/// poster grid, `ProfilePickerView`'s avatar row): `.card` is Apple's own
/// "enlarges slightly + adds a shadow when focused" button style — i.e.
/// scale-on-focus is inherited for free rather than hand-rolled, and the
/// label can still be arbitrarily rich content (here, the artwork + resume
/// bar overlay + title/year stack).
struct PosterCard: View {
    let card: MediaCard
    let baseURL: URL?
    let imageLoader: ImageLoader
    var onSelect: () -> Void

    private static let posterWidth: CGFloat = 220
    private static let posterHeight: CGFloat = 330 // 2:3

    var body: some View {
        Button(action: onSelect) {
            VStack(alignment: .leading, spacing: 10) {
                artwork
                    .frame(width: Self.posterWidth, height: Self.posterHeight)
                    .clipShape(RoundedRectangle(cornerRadius: 12))

                VStack(alignment: .leading, spacing: 2) {
                    Text(card.title)
                        .font(.callout)
                        .lineLimit(1)
                    if let year = card.year {
                        Text(String(year))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: Self.posterWidth, alignment: .leading)
            }
        }
        .buttonStyle(.card)
        .accessibilityIdentifier("posterCard_\(card.id)")
    }

    @ViewBuilder
    private var artwork: some View {
        ZStack(alignment: .bottom) {
            PosterArtwork(url: posterURL, imageLoader: imageLoader)
            if let resumeFraction {
                ResumeProgressBar(fraction: resumeFraction)
                    .accessibilityIdentifier("posterCardResumeBar_\(card.id)")
            }
        }
    }

    private var posterURL: URL? {
        guard let posterPath = card.posterPath, let baseURL else { return nil }
        return baseURL.appending(path: "api/images/\(posterPath)")
    }

    /// `positionSec / durationSec` clamped to `0...1`; `nil` (no bar drawn)
    /// when there's no `progress` or a non-positive `durationSec` — the
    /// server shouldn't send the latter, but this defends against a
    /// divide-by-zero/negative-width overlay rather than trusting it.
    private var resumeFraction: Double? {
        guard let progress = card.progress, progress.durationSec > 0 else { return nil }
        return min(1, max(0, Double(progress.positionSec) / Double(progress.durationSec)))
    }
}

/// Poster art fetched via `ImageLoader` (memory + bounded disk cache); a
/// film-glyph placeholder while loading or on a missing/failed poster.
/// Mirrors the pattern used elsewhere in this app for remote art (the M1
/// spike's poster grid, `ProfilePickerView`'s avatar row) — each caller
/// keeps its own tiny loader-view rather than sharing one, since the
/// `.task(id:)` reload-on-url-change behavior is identical but the
/// placeholder glyph/shape differs per call site.
private struct PosterArtwork: View {
    let url: URL?
    let imageLoader: ImageLoader

    @State private var uiImage: UIImage?

    var body: some View {
        ZStack {
            Rectangle().fill(.secondary.opacity(0.2))
            if let uiImage {
                Image(uiImage: uiImage)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } else {
                Image(systemName: "film")
                    .font(.largeTitle)
                    .foregroundStyle(.secondary)
            }
        }
        .clipped()
        .task(id: url) {
            uiImage = nil
            guard let url else { return }
            if let data = await imageLoader.image(for: url) {
                uiImage = UIImage(data: data)
            }
        }
    }
}

/// A thin bar along the bottom of the poster showing resume progress
/// (`fraction` in `0...1`) — filled portion vs. remaining, Netflix-style.
private struct ResumeProgressBar: View {
    let fraction: Double

    private static let barHeight: CGFloat = 6

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Rectangle().fill(.white.opacity(0.35))
                Rectangle()
                    .fill(.red)
                    .frame(width: geometry.size.width * fraction)
            }
        }
        .frame(height: Self.barHeight)
    }
}

#Preview {
    HStack(spacing: 32) {
        PosterCard(
            card: MediaCard(id: "1", title: "Arrival", year: 2016, posterPath: nil),
            baseURL: nil,
            imageLoader: ImageLoader(),
            onSelect: {}
        )
        PosterCard(
            card: MediaCard(
                id: "2",
                title: "Some Series With A Rather Long Title",
                year: 2020,
                posterPath: nil,
                progress: MediaCard.Progress(positionSec: 900, durationSec: 1500)
            ),
            baseURL: nil,
            imageLoader: ImageLoader(),
            onSelect: {}
        )
    }
    .padding(60)
}
