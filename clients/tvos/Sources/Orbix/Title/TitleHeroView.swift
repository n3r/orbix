import OrbixKit
import SwiftUI
import UIKit

/// Reusable full-bleed cinematic hero for a title's detail page — tvOS port
/// of the web's `apps/web/src/components/TitleHero.tsx`, shared by both a
/// movie and a series `TitlePage` (Phase 3 Task 3 wires it in and removes
/// `TitlePage`'s private `BackdropImage`/`LogoImage`/hero-building code this
/// view supersedes; the movie/series split lives in what the *caller* passes
/// for `canPlay`/`resumeAvailable`, not in this view — a series' season/
/// episode strip renders below it, not inside it). Layers the same scrim
/// stack `HomeBillboardView` established (`TopBarScrim`/`LeftVignette`/
/// `BottomScrim`, see `ScrimView.swift`) over the backdrop, then a copy
/// block: logo-or-title, a `RatingBadges` + year + seasons·episodes/runtime +
/// up to 3 genres meta row, a 3-line overview, and Play + (optional)
/// Wishlist buttons.
struct TitleHeroView: View {
    let detail: ItemDetail
    let baseURL: URL?
    let imageLoader: ImageLoader
    let canPlay: Bool
    let resumeAvailable: Bool
    /// `nil` while wishlist membership is unknown (ids still loading / fetch
    /// failed) → the toggle is hidden, mirroring web's `inWishlist ===
    /// undefined` (`TitleHero.tsx` line 112).
    let inWishlist: Bool?
    var onPlay: () -> Void
    var onToggleWishlist: () -> Void

    /// Same proven "reads as full-bleed on a 1080pt-tall tvOS screen" height
    /// `TitlePage.heroHeight`/`HomeBillboardView.height` already use.
    private static let height: CGFloat = 820

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            HeroBackdrop(url: imageURL(path: detail.backdropPath), imageLoader: imageLoader)
                .frame(height: Self.height)
                .frame(maxWidth: .infinity)
                .clipped()
                // Web lines 55-57: leading vignette + top/bottom scrims.
                .overlay { LeftVignette() }
                .overlay(alignment: .top) { TopBarScrim().frame(height: 220) }
                .overlay(alignment: .bottom) { BottomScrim().frame(height: 380) }

            copyBlock
                .padding(.horizontal, 64)
                .padding(.bottom, 56)
        }
        .frame(height: Self.height)
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier("titleHero_\(detail.id)")
    }

    // MARK: - Copy block (web lines 60-123)

    private var copyBlock: some View {
        VStack(alignment: .leading, spacing: 20) {
            logoOrTitle
            metaRow
            overviewText
            buttons
                .padding(.top, 8)
        }
        .frame(maxWidth: 1200, alignment: .leading)
    }

    /// Web lines 61-71: logo art *is* the title; text `heroTitle` fallback.
    @ViewBuilder
    private var logoOrTitle: some View {
        if let url = imageURL(path: detail.logoPath) {
            HeroLogo(url: url, imageLoader: imageLoader, fallbackTitle: detail.title)
        } else {
            Text(detail.title)
                .font(OrbixType.heroTitle)
                .foregroundStyle(OrbixColor.text)
                .lineLimit(2)
                .shadow(color: .black.opacity(0.6), radius: 8, y: 2)
        }
    }

    /// Web lines 73-93: `RatingBadges` + year + seasons·episodes/runtime + up
    /// to 3 genres, each its own `"· genre"` text (`item.genres.slice(0, 3)`,
    /// web line 90).
    private var metaRow: some View {
        HStack(spacing: 12) {
            RatingBadges(
                imdbRating: detail.imdbRating,
                rtRating: detail.rtRating,
                tmdbScore: detail.tmdbScore,
                metacritic: detail.metacritic,
                mpaa: detail.rating
            )
            ForEach(Array(metaParts.enumerated()), id: \.offset) { _, part in
                Text(part)
            }
            ForEach(genres, id: \.self) { genre in
                Text("· \(genre)")
            }
        }
        .font(.system(size: 24, weight: .medium))
        .foregroundStyle(OrbixColor.textMuted)
        .shadow(color: .black.opacity(0.7), radius: 2, y: 1)
    }

    /// Year + seasons·episodes (series) / runtime (movie) — web lines 81-89:
    /// `item.kind === "series" && seasonCount ? seasonsText : runtimeText`.
    /// Uses `" · "` (single space each side, per the brief) between the
    /// season and episode counts — not the billboard's double-space join.
    private var metaParts: [String] {
        var parts: [String] = []
        if let year = detail.year { parts.append(String(year)) }
        if detail.kind == "series", let seasons = detail.seasons, !seasons.isEmpty {
            let seasonCount = seasons.count
            let episodeCount = seasons.reduce(0) { $0 + ($1.episodeCount ?? 0) }
            var text = "\(seasonCount) season\(seasonCount == 1 ? "" : "s")"
            if episodeCount > 0 {
                text += " · \(episodeCount) episode\(episodeCount == 1 ? "" : "s")"
            }
            parts.append(text)
        } else if let runtime = Self.formattedRuntime(detail.runtimeSec) {
            parts.append(runtime)
        }
        return parts
    }

    private var genres: [String] {
        Array((detail.genres ?? []).prefix(3))
    }

    /// Web lines 95-99: 3-line overview.
    @ViewBuilder
    private var overviewText: some View {
        if let overview = detail.overview, !overview.isEmpty {
            Text(overview)
                .font(.system(size: 26))
                .foregroundStyle(OrbixColor.text.opacity(0.9))
                .lineLimit(3)
                .frame(maxWidth: 1000, alignment: .leading)
                .shadow(color: .black.opacity(0.7), radius: 3, y: 1)
        }
    }

    // MARK: - Buttons (web lines 101-122)

    private var buttons: some View {
        HStack(spacing: 20) {
            playButton
            if let inWishlist {
                wishlistButton(inWishlist: inWishlist)
            }
        }
    }

    /// Always rendered (never conditionally hidden): a dimmed, `disabled`
    /// button when `!canPlay` communicates "nothing to play" rather than
    /// silently omitting the button (same rationale `TitlePage.playButton`
    /// documents; `OrbixButtonStyle` supplies the disabled dim).
    private var playButton: some View {
        Button(action: onPlay) {
            Label(playLabel, systemImage: "play.fill")
        }
        .buttonStyle(OrbixButtonStyle(.primary))
        .disabled(!canPlay)
        .accessibilityIdentifier("titlePagePlayButton")
    }

    /// Web `title.json`: `"play"` / `"noMedia"`. `"Resume"` is a tvOS
    /// resume-awareness enhancement layered on top (movie only, per the
    /// brief — a series' per-episode resume is a later task's job).
    private var playLabel: String {
        if !canPlay { return "No media" }
        return resumeAvailable ? "Resume" : "Play"
    }

    /// Web lines 112-121: ghost button, hidden while membership is unknown.
    private func wishlistButton(inWishlist: Bool) -> some View {
        Button(action: onToggleWishlist) {
            Text(inWishlist ? "✓ In Wishlist" : "+ Add to Wishlist")
        }
        .buttonStyle(OrbixButtonStyle(.ghost))
        .accessibilityIdentifier("titlePageWishlistButton")
    }

    // MARK: - Images

    private func imageURL(path: String?) -> URL? {
        guard let path, let baseURL else { return nil }
        return baseURL.appending(path: "api/images/\(path)")
    }

    /// `3720` → `"1h 2m"`; `600` → `"10m"`; `nil`/non-positive → `nil` — same
    /// helper `TitlePage`/`HomeBillboardView`/`SeasonEpisodeListView` each keep
    /// their own private copy of (no shared symbol exists yet; Task 3 may
    /// consolidate).
    private static func formattedRuntime(_ seconds: Int?) -> String? {
        guard let seconds, seconds > 0 else { return nil }
        let hours = seconds / 3600
        let minutes = (seconds % 3600) / 60
        return hours > 0 ? "\(hours)h \(minutes)m" : "\(minutes)m"
    }
}

/// Full-bleed backdrop art fetched via `ImageLoader`; a diagonal
/// surface2→bg gradient plate (web line 53: `bg-gradient-to-br
/// from-[var(--surface-2)] to-[var(--bg)]`) while loading or on a
/// missing/failed backdrop — unlike `TitlePage`'s old plain black fill, this
/// mirrors web's gradient fallback exactly.
private struct HeroBackdrop: View {
    let url: URL?
    let imageLoader: ImageLoader

    @State private var uiImage: UIImage?

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [OrbixColor.surface2, OrbixColor.bg],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            if let uiImage {
                Image(uiImage: uiImage)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .transition(.opacity)
            }
        }
        .clipped()
        .task(id: url) {
            uiImage = nil
            guard let url else { return }
            if let data = await imageLoader.image(for: url), let image = UIImage(data: data) {
                withAnimation(.easeOut(duration: 0.4)) { uiImage = image }
            }
        }
    }
}

/// A title's logo art (transparent-background wordmark), fetched via
/// `ImageLoader`; falls back to the plain title `Text` (same styling
/// `logoOrTitle`'s no-logo branch uses) while loading or on a missing/failed
/// logo. Same `.task(id:)` idiom `TitlePage.LogoImage`/`HomeBillboardView.
/// BillboardLogo` use.
private struct HeroLogo: View {
    let url: URL
    let imageLoader: ImageLoader
    let fallbackTitle: String

    @State private var uiImage: UIImage?

    var body: some View {
        Group {
            if let uiImage {
                Image(uiImage: uiImage)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(maxWidth: 800, maxHeight: 220, alignment: .leading)
                    .shadow(color: .black.opacity(0.5), radius: 12, y: 4)
            } else {
                Text(fallbackTitle)
                    .font(OrbixType.heroTitle)
                    .foregroundStyle(OrbixColor.text)
                    .lineLimit(2)
                    .shadow(color: .black.opacity(0.6), radius: 8, y: 2)
            }
        }
        .task(id: url) {
            uiImage = nil
            if let data = await imageLoader.image(for: url) {
                uiImage = UIImage(data: data)
            }
        }
    }
}

#Preview {
    TitleHeroView(
        detail: ItemDetail(
            id: "m1",
            kind: "movie",
            title: "Arrival",
            year: 2016,
            overview: "A linguist is recruited by the military to communicate with alien "
                + "lifeforms after twelve mysterious spacecraft appear around the world.",
            runtimeSec: 6720,
            rating: "PG-13",
            tmdbScore: 7.6,
            imdbRating: 7.9,
            rtRating: 94,
            metacritic: 81,
            genres: ["Drama", "Sci-Fi", "Mystery"],
            files: [.init(id: "f1")]
        ),
        baseURL: nil,
        imageLoader: ImageLoader(),
        canPlay: true,
        resumeAvailable: false,
        inWishlist: false,
        onPlay: {},
        onToggleWishlist: {}
    )
    .background(OrbixColor.bg)
}
