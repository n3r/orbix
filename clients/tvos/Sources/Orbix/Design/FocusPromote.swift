import SwiftUI

/// Web hover-promote (`hover:scale-[1.04] duration-200`) translated to the
/// tvOS focus engine. Apply to card-like content; pair with `.focusable()`
/// or a Button wrapper that reports focus via `@Environment(\.isFocused)`.
struct FocusPromote: ViewModifier {
    let isFocused: Bool
    func body(content: Content) -> some View {
        content
            .scaleEffect(isFocused ? 1.04 : 1.0)
            .shadow(color: .black.opacity(isFocused ? 0.5 : 0), radius: 18, y: 10)
            .animation(.easeOut(duration: 0.2), value: isFocused)
    }
}

extension View {
    func focusPromote(_ isFocused: Bool) -> some View { modifier(FocusPromote(isFocused: isFocused)) }
}
