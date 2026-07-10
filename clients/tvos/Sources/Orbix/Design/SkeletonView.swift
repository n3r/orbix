import SwiftUI

/// Content placeholder ported from packages/ui/src/components/Skeleton.tsx
/// (`animate-pulse bg-[var(--surface-2)]`). Previews the shape of what's
/// coming instead of a spinner; purely decorative, hidden from AT.
struct SkeletonView: View {
    var cornerRadius: CGFloat = OrbixRadius.sm
    @State private var pulsing = false

    init(cornerRadius: CGFloat = OrbixRadius.sm) {
        self.cornerRadius = cornerRadius
    }

    var body: some View {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .fill(OrbixColor.surface2)
            .opacity(pulsing ? 1.0 : 0.55)
            .onAppear {
                withAnimation(.easeInOut(duration: 1).repeatForever(autoreverses: true)) {
                    pulsing = true
                }
            }
            .accessibilityHidden(true)
    }
}
