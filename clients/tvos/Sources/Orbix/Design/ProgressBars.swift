import SwiftUI

/// Thin horizontal progress bar over a translucent track — ported from the
/// web box-art resume bar (apps/web/src/components/BoxArtCard.tsx: `absolute
/// inset-x-0 bottom-0 h-[3px] bg-white/25` track + `bg-[var(--accent)]`
/// fill, scaled to 4pt for 10-ft viewing). `fraction` is clamped to `0...1`
/// defensively — a caller-computed position/duration ratio could exceed 1
/// on a stale duration.
struct ProgressBarView: View {
    let fraction: Double
    var fill: Color = OrbixColor.accent

    private static let barHeight: CGFloat = 4

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Rectangle().fill(.white.opacity(0.25))
                Rectangle()
                    .fill(fill)
                    .frame(width: geometry.size.width * clampedFraction)
            }
        }
        .frame(height: Self.barHeight)
        .accessibilityHidden(true)
    }

    private var clampedFraction: Double { min(1, max(0, fraction)) }
}

/// The live-TV "now playing" elapsed-time bar — same geometry as
/// `ProgressBarView`, filled with `OrbixColor.live` instead of the accent
/// (web: apps/web/src/components/tv/NowProgressBar.tsx's `bg-red-500` fill
/// over a `bg-white/20` track).
struct NowProgressBar: View {
    let fraction: Double

    var body: some View {
        ProgressBarView(fraction: fraction, fill: OrbixColor.live)
    }
}

#Preview {
    VStack(spacing: 24) {
        ProgressBarView(fraction: 0.35)
        NowProgressBar(fraction: 0.7)
    }
    .frame(width: 320)
    .padding(40)
    .background(OrbixColor.bg)
}
