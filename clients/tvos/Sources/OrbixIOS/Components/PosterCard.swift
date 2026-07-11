import OrbixKit
import SwiftUI

struct PosterCard: View {
    let card: MediaCard
    let baseURL: URL?
    let imageLoader: ImageLoader
    var accessibilityIdentifier: String? = nil
    var onSelect: () -> Void

    private let width: CGFloat = 126
    private let height: CGFloat = 189

    var body: some View {
        Button(action: onSelect) {
            VStack(alignment: .leading, spacing: 8) {
                ZStack(alignment: .bottom) {
                    RemoteImage(url: posterURL, imageLoader: imageLoader) {
                        ImagePlaceholder(systemName: "film")
                    }
                    .frame(width: width, height: height)

                    if let resumeFraction {
                        ResumeProgressBar(fraction: resumeFraction)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 7))

                Text(card.title)
                    .font(.caption.weight(.medium))
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .frame(width: width, alignment: .leading)
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(accessibilityIdentifier ?? "poster-card-\(card.id)")
    }

    private var posterURL: URL? {
        guard let posterPath = card.posterPath, let baseURL else { return nil }
        return baseURL.appending(path: "api/images/\(posterPath)")
    }

    private var resumeFraction: Double? {
        guard let progress = card.progress, progress.durationSec > 0 else { return nil }
        return min(1, max(0, Double(progress.positionSec) / Double(progress.durationSec)))
    }
}

struct WidePosterCard: View {
    let card: MediaCard
    let baseURL: URL?
    let imageLoader: ImageLoader
    var accessibilityIdentifier: String? = nil
    var onSelect: () -> Void

    var body: some View {
        Button(action: onSelect) {
            ZStack(alignment: .bottomLeading) {
                RemoteImage(url: backdropURL ?? posterURL, imageLoader: imageLoader) {
                    ImagePlaceholder(systemName: "film")
                }
                .frame(width: 236, height: 132)

                LinearGradient(
                    colors: [.clear, .black.opacity(0.82)],
                    startPoint: .center,
                    endPoint: .bottom
                )

                VStack(alignment: .leading, spacing: 4) {
                    Text(card.title)
                        .font(.subheadline.bold())
                        .lineLimit(1)
                    if let resume = card.resume {
                        Text("S\(resume.seasonNumber)E\(resume.episodeNumber)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    } else if let year = card.year {
                        Text(String(year))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(10)

                if let resumeFraction {
                    ResumeProgressBar(fraction: resumeFraction)
                        .frame(maxHeight: .infinity, alignment: .bottom)
                }
            }
            .frame(width: 236, height: 132)
            .clipShape(RoundedRectangle(cornerRadius: 7))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(accessibilityIdentifier ?? "poster-card-\(card.id)")
    }

    private var posterURL: URL? {
        guard let posterPath = card.posterPath, let baseURL else { return nil }
        return baseURL.appending(path: "api/images/\(posterPath)")
    }

    private var backdropURL: URL? {
        guard let backdropPath = card.backdropPath, let baseURL else { return nil }
        return baseURL.appending(path: "api/images/\(backdropPath)")
    }

    private var resumeFraction: Double? {
        guard let progress = card.progress, progress.durationSec > 0 else { return nil }
        return min(1, max(0, Double(progress.positionSec) / Double(progress.durationSec)))
    }
}
