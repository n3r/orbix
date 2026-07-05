import SwiftUI

struct OrbixButtonStyle: ButtonStyle {
    enum Variant { case primary, ghost, danger }
    let variant: Variant
    @Environment(\.isFocused) private var isFocused
    @Environment(\.isEnabled) private var isEnabled

    init(_ variant: Variant) { self.variant = variant }

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 29, weight: .semibold))
            .padding(.horizontal, 36)
            .padding(.vertical, 14)
            .background(background)
            .foregroundStyle(foreground)
            .clipShape(RoundedRectangle(cornerRadius: OrbixRadius.sm, style: .continuous))
            // `.disabled(true)` (e.g. Connect with an empty field, Create with
            // an empty name) previously looked identical to enabled — dim the
            // whole label+background so disabled reads as disabled at a glance.
            .opacity(isEnabled ? 1.0 : 0.4)
            .scaleEffect(isFocused ? 1.05 : 1.0)
            .animation(.easeOut(duration: 0.2), value: isFocused)
    }

    private var background: Color {
        switch variant {
        case .primary: return isFocused ? .white : .white.opacity(0.9)
        case .ghost: return .white.opacity(isFocused ? 0.3 : 0.2)
        case .danger: return isFocused ? OrbixColor.dangerStrong : OrbixColor.danger
        }
    }

    private var foreground: Color {
        switch variant {
        case .primary: return .black
        case .ghost, .danger: return OrbixColor.text
        }
    }
}
