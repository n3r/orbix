import SwiftUI

/// "NEW" chip for recently-added titles — ported from the web's spotlight
/// badge (apps/web/src/components/BoxArtCard.tsx: `rounded-sm
/// bg-[var(--accent-strong)] px-1.5 py-0.5 text-[10px] font-bold text-white`).
/// This view is just the chip; callers position it (e.g. `.padding(8)`
/// inside a top-leading `ZStack`), same as the web places it absolutely
/// over the card art.
struct NewBadge: View {
    var body: some View {
        Text("NEW")
            .font(.caption.bold())
            .foregroundStyle(.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(OrbixColor.accentStrong, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .accessibilityLabel(Text("New"))
    }
}

/// Small translucent info chip (resolution/source label, e.g. "HD"/"4K") —
/// ported from the web live-TV OSD's quality tag
/// (apps/web/src/components/tv/LiveTvOverlay.tsx: `rounded-sm bg-white/15
/// px-1 py-0.5 font-semibold`).
struct QualityChip: View {
    let label: String

    var body: some View {
        Text(label)
            .font(.caption.bold())
            .foregroundStyle(.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(.white.opacity(0.15), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}

#Preview {
    HStack(spacing: 16) {
        NewBadge()
        QualityChip(label: "HD")
        QualityChip(label: "4K")
    }
    .padding(40)
    .background(OrbixColor.bg)
}
