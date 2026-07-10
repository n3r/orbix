import OrbixKit
import SwiftUI
import UIKit

/// A single focusable poster in a catalog/search/wishlist grid: 2:3 art (via
/// `ImageLoader`, with a placeholder while loading or on a missing/failed
/// poster) and title + year below.
///
/// Built as a `Button` styled `.card`, the same lockup convention already
/// proven in this codebase for tvOS focusable art (the M1 `SpikeListView`'s
/// poster grid, `ProfilePickerView`'s avatar row): `.card` is Apple's own
/// "enlarges slightly + adds a shadow when focused" button style — i.e.
/// scale-on-focus is inherited for free rather than hand-rolled, and the
/// label can still be arbitrarily rich content (here, the artwork +
/// title/year stack).
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
                PosterArtwork(url: posterURL, imageLoader: imageLoader)
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

    private var posterURL: URL? {
        guard let posterPath = card.posterPath, let baseURL else { return nil }
        return baseURL.appending(path: "api/images/\(posterPath)")
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
                posterPath: nil
            ),
            baseURL: nil,
            imageLoader: ImageLoader(),
            onSelect: {}
        )
    }
    .padding(60)
}
