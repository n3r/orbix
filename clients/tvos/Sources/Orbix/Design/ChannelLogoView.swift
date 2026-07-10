import OrbixKit
import SwiftUI
import UIKit

extension Color {
    /// Exact CSS-HSL → sRGB (SwiftUI's `Color(hue:saturation:brightness:)` is
    /// HSB, a different model). Ports the web `ChannelLogo` monogram's
    /// `hsl(h 45% L%)` tiles faithfully so the tvOS channel art matches the
    /// web's byte-for-byte (apps/web/src/components/tv/ChannelLogo.tsx:55-56).
    init(tvHueDegrees h: Double, saturation s: Double, lightness l: Double) {
        let c = (1 - abs(2 * l - 1)) * s
        let hp = (h.truncatingRemainder(dividingBy: 360)) / 60
        let x = c * (1 - abs(hp.truncatingRemainder(dividingBy: 2) - 1))
        let (r1, g1, b1): (Double, Double, Double)
        switch hp {
        case 0..<1: (r1, g1, b1) = (c, x, 0)
        case 1..<2: (r1, g1, b1) = (x, c, 0)
        case 2..<3: (r1, g1, b1) = (0, c, x)
        case 3..<4: (r1, g1, b1) = (0, x, c)
        case 4..<5: (r1, g1, b1) = (x, 0, c)
        default:    (r1, g1, b1) = (c, 0, x)
        }
        let m = l - c / 2
        self.init(.sRGB, red: r1 + m, green: g1 + m, blue: b1 + m, opacity: 1)
    }
}

/// Channel logo art with a deterministic hue-hashed monogram fallback — tvOS
/// port of `apps/web/src/components/tv/ChannelLogo.tsx`. The monogram shows
/// both when there's no cached logo *and* when the logo fetch fails (web's
/// `onError` on a dead/purged cache file, line 47), so a broken-image glyph
/// never reaches the screen.
///
/// Purely presentational, like the web component: sizing/shape/background are
/// the **caller's** responsibility (the caller frames + clips + backgrounds
/// this view), so the guide row, OSD, mini-guide, hero and 16:9 tile each keep
/// their own look — only the img-vs-monogram switch is shared here.
///
/// Web→tvOS adaptations:
/// - `avatarHue(channelId)` / `avatarInitials(name)` are the verified
///   byte-for-byte port of `channelHue`/`channelInitials` (see
///   `OrbixKit/AvatarHue.swift` + `AvatarHueTests`).
/// - The gradient tile is a 135° `LinearGradient` between `hsl(hue 45% 34%)`
///   and `hsl(hue 45% 18%)`; the flat tile is `hsl(hue 45% 28%)` — rendered
///   via the `Color(tvHueDegrees:…)` helper above.
/// - The web sets the monogram text via a `monogramClassName` prop; tvOS has
///   no frame to key off at call time, so the initials font size is derived
///   from the caller-imposed frame (`min(w,h) * 0.42`, white/bold), which
///   scales cleanly across the OSD/mini-guide/hero/tile call sites.
struct ChannelLogoView: View {
    let logo: String?
    let name: String
    let channelId: String
    let baseURL: URL?
    let imageLoader: ImageLoader
    /// ChannelCard's 16:9 tile uses a diagonal gradient; other sites use a
    /// flat fill (web `gradient` prop, line 33).
    var gradient: Bool = false
    /// Optional cap on the logo image's size (web `imgClassName` max-h/max-w);
    /// `nil` lets the image fit the caller's whole frame.
    var contentMax: CGFloat? = nil

    @State private var uiImage: UIImage?
    @State private var failed = false

    /// The `logo` field is already a same-origin `"/api/images/…"` path;
    /// resolve it against `baseURL`. `nil` (no logo / no server) → monogram.
    private var logoURL: URL? {
        guard let logo, let baseURL else { return nil }
        return URL(string: logo, relativeTo: baseURL)?.absoluteURL
    }

    var body: some View {
        ZStack {
            if let uiImage, !failed {
                Image(uiImage: uiImage)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(maxWidth: contentMax, maxHeight: contentMax)
            } else {
                monogram
            }
        }
        // Same `.task(id:)` art idiom as `BoxArtCard.BoxArtImage`: reload when
        // the resolved URL changes, fall back to the monogram on nil/failure.
        .task(id: logoURL) {
            uiImage = nil
            failed = false
            guard let logoURL else { failed = true; return }
            if let data = await imageLoader.image(for: logoURL), let img = UIImage(data: data) {
                uiImage = img
            } else {
                failed = true
            }
        }
        .accessibilityIdentifier("channelLogo_\(channelId)")
    }

    private var monogram: some View {
        let hue = avatarHue(channelId)
        return GeometryReader { geo in
            ZStack {
                if gradient {
                    LinearGradient(
                        colors: [
                            Color(tvHueDegrees: hue, saturation: 0.45, lightness: 0.34),
                            Color(tvHueDegrees: hue, saturation: 0.45, lightness: 0.18),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                } else {
                    Color(tvHueDegrees: hue, saturation: 0.45, lightness: 0.28)
                }
                Text(avatarInitials(name))
                    .font(.system(size: min(geo.size.width, geo.size.height) * 0.42, weight: .bold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.3)
                    .foregroundStyle(.white)
                    .padding(4)
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
    }
}

#Preview("Logo present / missing / gradient tile") {
    HStack(spacing: 24) {
        // Logo present (nil baseURL → resolves to nil → monogram in preview,
        // but exercises the img path when a real server is configured).
        ChannelLogoView(
            logo: "/api/images/channel/bbc.png",
            name: "BBC One",
            channelId: "bbc-one",
            baseURL: nil,
            imageLoader: ImageLoader()
        )
        .frame(width: 140, height: 100)
        .background(Color.white.opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: OrbixRadius.sm))

        // Missing logo → flat monogram tile.
        ChannelLogoView(
            logo: nil,
            name: "CNN International",
            channelId: "cnn-intl",
            baseURL: nil,
            imageLoader: ImageLoader()
        )
        .frame(width: 140, height: 100)
        .clipShape(RoundedRectangle(cornerRadius: OrbixRadius.sm))

        // Gradient monogram tile (ChannelCard look).
        ChannelLogoView(
            logo: nil,
            name: "Discovery Science",
            channelId: "disco-sci",
            baseURL: nil,
            imageLoader: ImageLoader(),
            gradient: true
        )
        .frame(width: 180, height: 100)
        .clipShape(RoundedRectangle(cornerRadius: OrbixRadius.sm))
    }
    .padding(60)
    .background(OrbixColor.bg)
}
