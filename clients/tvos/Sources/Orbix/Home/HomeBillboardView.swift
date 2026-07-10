import OrbixKit
import SwiftUI
import UIKit

/// Netflix-style full-bleed Home billboard — tvOS port of the web's
/// `apps/web/src/components/billboard/HomeBillboard.tsx` (+ its host
/// `HomePage.tsx`). Paints immediately from the row card (title + backdrop —
/// web lines 18, 32-38) and upgrades to logo art, synopsis and the maturity
/// cert once `GET /api/items/:id` lands (web lines 15-18, 48-62, 75-103).
///
/// Three legibility scrims layer over the backdrop, 1:1 with web (lines
/// 42-44): a `TopBarScrim` under the transparent nav, a `LeftVignette` behind
/// the copy block, and a `BottomScrim` dissolving into `OrbixColor.bg` so the
/// first rail can ride up into it (`HomeView` pulls the rails up `-80`, the
/// tvOS analogue of web's `-mt-12 md:-mt-20`).
///
/// Focus-driven, not hover-driven: **Play** (`OrbixButtonStyle(.primary)`,
/// white/black — web lines 82-87) and **More info** (`.ghost` — web lines
/// 88-93) call back to `HomeView`, which pushes the two `TitleRoute` variants
/// (`autoplay: true` for Play, the web `?play=1` deep-link; plain for info).
struct HomeBillboardView: View {
    let card: MediaCard
    let model: AppModel
    let imageLoader: ImageLoader
    var onPlay: () -> Void
    var onMoreInfo: () -> Void

    /// Loaded lazily; the copy block reads from `card` until it arrives, then
    /// upgrades in place (logo, overview, seasons, cert).
    @State private var detail: ItemDetail?

    /// Fixed height that reads as "full-bleed" on a 1080pt-tall tvOS screen
    /// while still leaving the first rail visibly peeking in below the
    /// dissolve (same proven value `TitlePage.heroHeight` uses).
    private static let height: CGFloat = 820

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            BillboardBackdrop(url: backdropURL, imageLoader: imageLoader)
                .frame(height: Self.height)
                .frame(maxWidth: .infinity)
                .clipped()
                // Web lines 42-44: top nav scrim, leading vignette, bottom
                // dissolve into the page background.
                .overlay { LeftVignette() }
                .overlay(alignment: .top) { TopBarScrim().frame(height: 220) }
                .overlay(alignment: .bottom) { BottomScrim().frame(height: 380) }

            copyBlock
                .padding(.horizontal, 64)
                .padding(.bottom, 150)
        }
        .frame(height: Self.height)
        .frame(maxWidth: .infinity)
        // Web lines 97-103: maturity cert plate pinned to the trailing edge.
        .overlay(alignment: .bottomTrailing) {
            if let rating = detail?.rating, !rating.isEmpty {
                certPlate(rating)
                    .padding(.trailing, 64)
                    .padding(.bottom, 158)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("homeBillboard")
        .task(id: card.id) {
            guard let client = model.client else { return }
            detail = try? await client.itemDetail(id: card.id)
        }
    }

    // MARK: - Copy block (web lines 46-95)

    private var copyBlock: some View {
        VStack(alignment: .leading, spacing: 18) {
            logoOrTitle
            metaRow
            overviewText
            buttons
                .padding(.top, 6)
        }
        .frame(maxWidth: 900, alignment: .leading)
    }

    /// Web lines 48-62: the logo art *is* the title; text `heroTitle`
    /// fallback (a heading is kept for AT on the `homeBillboard` element).
    @ViewBuilder
    private var logoOrTitle: some View {
        if let logoURL {
            BillboardLogo(url: logoURL, imageLoader: imageLoader, fallbackTitle: card.title)
                .accessibilityLabel(card.title)
        } else {
            Text(card.title)
                .font(OrbixType.heroTitle)
                .foregroundStyle(OrbixColor.text)
                .lineLimit(2)
                .shadow(color: .black.opacity(0.6), radius: 8, y: 2)
        }
    }

    /// Web lines 64-73: NEW chip + `genre · year · seasons/runtime`.
    @ViewBuilder
    private var metaRow: some View {
        let parts = metaParts
        let fresh = isNew(addedAt: card.addedAt, now: Date())
        if fresh || !parts.isEmpty {
            HStack(spacing: 12) {
                if fresh { NewBadge() }
                if !parts.isEmpty {
                    Text(parts.joined(separator: " · "))
                        .font(.system(size: 26, weight: .medium))
                        .foregroundStyle(OrbixColor.text.opacity(0.85))
                        .shadow(color: .black.opacity(0.7), radius: 2, y: 1)
                }
            }
        }
    }

    /// Web lines 21-27: `[detail.genres[0], card.year ?? detail.year,
    /// seasons]`. The brief widens the third slot to `seasons/runtime`:
    /// seasons for a series, formatted runtime for a movie.
    private var metaParts: [String] {
        var parts: [String] = []
        if let genre = detail?.genres?.first, !genre.isEmpty { parts.append(genre) }
        if let year = card.year ?? detail?.year { parts.append(String(year)) }
        if let seasons = detail?.seasons, !seasons.isEmpty {
            parts.append(L10n.plural("catalog.spotlight.seasons", seasons.count))
        } else if let runtime = Self.formattedRuntime(detail?.runtimeSec) {
            parts.append(runtime)
        }
        return parts
    }

    /// Web lines 75-79: 3-line overview.
    @ViewBuilder
    private var overviewText: some View {
        if let overview = detail?.overview, !overview.isEmpty {
            Text(overview)
                .font(.system(size: 26))
                .foregroundStyle(OrbixColor.text.opacity(0.9))
                .lineLimit(3)
                .frame(maxWidth: 820, alignment: .leading)
                .shadow(color: .black.opacity(0.7), radius: 3, y: 1)
        }
    }

    /// Web lines 81-94: Play (primary) + More info (ghost). No hover states —
    /// focus emphasis comes from `OrbixButtonStyle`.
    ///
    /// `.focusSection()` here is load-bearing, not decorative: gate-verified
    /// live (Phase 3 Task 6) that without it, pressing Down from
    /// `OrbixTopBar` skips this row entirely and drops focus straight into
    /// the first rail below (`RailView`'s own `.focusSection()` — see its
    /// doc comment) — the tvOS focus engine's directional search prefers an
    /// explicit focus section as the next candidate over an unsectioned
    /// `Button` sitting geometrically closer, so Play/More Info were
    /// completely unreachable by remote from Home. Once this row is its own
    /// section, Down from the bar lands here first, and only a second Down
    /// continues on into the rails, matching how every rail already hands
    /// off to its neighbor.
    private var buttons: some View {
        HStack(spacing: 20) {
            Button(action: onPlay) {
                Label(L10n.t("catalog.hero.play"), systemImage: "play.fill")
            }
            .buttonStyle(OrbixButtonStyle(.primary))
            .accessibilityIdentifier("billboardPlayButton")

            Button(action: onMoreInfo) {
                Label(L10n.t("catalog.hero.moreInfo"), systemImage: "info.circle")
            }
            .buttonStyle(OrbixButtonStyle(.ghost))
            .accessibilityIdentifier("billboardMoreInfoButton")
        }
        .focusSection()
    }

    /// Web lines 99-102: bordered translucent plate carrying `detail.rating`.
    private func certPlate(_ rating: String) -> some View {
        Text(rating)
            .font(.system(size: 24, weight: .medium))
            .foregroundStyle(OrbixColor.text.opacity(0.9))
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(OrbixColor.surface.opacity(0.5))
            .clipShape(RoundedRectangle(cornerRadius: OrbixRadius.sm, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: OrbixRadius.sm, style: .continuous)
                    .strokeBorder(OrbixColor.surface2)
            }
            .accessibilityLabel(L10n.t("catalog.hero.rated", rating))
    }

    // MARK: - Images

    /// Backdrop: `card.backdropPath` first (paints immediately), upgraded to
    /// `detail?.backdropPath` when detail lands (web line 18).
    private var backdropURL: URL? {
        imageURL(path: detail?.backdropPath ?? card.backdropPath)
    }

    private var logoURL: URL? {
        imageURL(path: detail?.logoPath)
    }

    private func imageURL(path: String?) -> URL? {
        guard let path, let baseURL = model.baseURL else { return nil }
        return baseURL.appending(path: "api/images/\(path)")
    }

    /// `3720` → `"1h 2m"`; `600` → `"10m"`; `nil`/non-positive → `nil` — the
    /// same helper `TitlePage`/`TitleHeroView`/`SeasonEpisodeListView` each
    /// keep as a private copy (no shared symbol exists yet; the Phase 5
    /// polish pass may consolidate).
    private static func formattedRuntime(_ seconds: Int?) -> String? {
        guard let seconds, seconds > 0 else { return nil }
        let hours = seconds / 3600
        let minutes = (seconds % 3600) / 60
        return hours > 0 ? L10n.t("title.runtime.hm", hours, minutes) : L10n.t("title.runtime.m", minutes)
    }
}

/// Full-bleed backdrop art fetched via `ImageLoader`, fading in when it lands
/// (web's `animate-[fadein_500ms]`, line 37). The old image is intentionally
/// *not* cleared when the URL upgrades (card → detail backdrop) so the swap
/// crossfades rather than flashing to `OrbixColor.bg`.
private struct BillboardBackdrop: View {
    let url: URL?
    let imageLoader: ImageLoader

    @State private var uiImage: UIImage?

    var body: some View {
        ZStack {
            OrbixColor.bg
            if let uiImage {
                Image(uiImage: uiImage)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .transition(.opacity)
            }
        }
        .clipped()
        .task(id: url) {
            guard let url else {
                uiImage = nil
                return
            }
            if let data = await imageLoader.image(for: url), let image = UIImage(data: data) {
                withAnimation(.easeOut(duration: 0.4)) { uiImage = image }
            }
        }
    }
}

/// A title's logo art (transparent-background wordmark), fetched via
/// `ImageLoader`; falls back to the `heroTitle` text (same styling
/// `HomeBillboardView.logoOrTitle`'s no-logo branch uses) while loading or on
/// a missing/failed logo. Same `.task(id:)` idiom as `TitlePage.LogoImage`.
private struct BillboardLogo: View {
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
                    .frame(maxWidth: 640, maxHeight: 180, alignment: .leading)
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
            if let data = await imageLoader.image(for: url) {
                uiImage = UIImage(data: data)
            }
        }
    }
}

#Preview {
    HomeBillboardView(
        card: MediaCard(
            id: "1",
            title: "Arrival",
            year: 2016,
            backdropPath: nil,
            addedAt: ISO8601DateFormatter().string(from: Date())
        ),
        model: AppModel(),
        imageLoader: ImageLoader(),
        onPlay: {},
        onMoreInfo: {}
    )
    .background(OrbixColor.bg)
}
