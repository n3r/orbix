import SwiftUI

/// The web billboard's three legibility gradients
/// (apps/web/src/components/billboard/HomeBillboard.tsx), ported 1:1 in
/// intent for the tvOS focus-driven billboard: a bottom dissolve into the
/// page background so rails can overlap it, a leading vignette behind the
/// copy block, and a top bar scrim for the transparent nav.

/// Bottom dissolve: clear → solid `OrbixColor.bg`, eased across several
/// stops (web: `from-[var(--bg)] via-[var(--bg)]/60 to-transparent`).
struct BottomScrim: View {
    var body: some View {
        LinearGradient(
            stops: [
                .init(color: .clear, location: 0),
                .init(color: OrbixColor.bg.opacity(0.35), location: 0.45),
                .init(color: OrbixColor.bg.opacity(0.8), location: 0.75),
                .init(color: OrbixColor.bg, location: 1.0),
            ],
            startPoint: .top,
            endPoint: .bottom
        )
    }
}

/// Leading vignette behind the copy block: full-width gradient matching web
/// (apps/web/src/components/billboard/HomeBillboard.tsx line 43:
/// `bg-gradient-to-r from-[var(--bg)]/85 via-[var(--bg)]/25 to-transparent`).
struct LeftVignette: View {
    var body: some View {
        LinearGradient(
            stops: [
                .init(color: OrbixColor.bg.opacity(0.85), location: 0),
                .init(color: OrbixColor.bg.opacity(0.25), location: 0.5),
                .init(color: .clear, location: 1.0),
            ],
            startPoint: .leading,
            endPoint: .trailing
        )
    }
}

/// Top bar scrim for the transparent nav (web: `from-black/60 via-black/20
/// to-transparent`).
struct TopBarScrim: View {
    var body: some View {
        LinearGradient(
            stops: [
                .init(color: .black.opacity(0.5), location: 0),
                .init(color: .black.opacity(0.2), location: 0.5),
                .init(color: .clear, location: 1.0),
            ],
            startPoint: .top,
            endPoint: .bottom
        )
    }
}
