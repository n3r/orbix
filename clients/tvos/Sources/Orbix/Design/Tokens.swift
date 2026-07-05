import SwiftUI

extension Color {
    /// 0xRRGGBB → opaque sRGB color (design-token values from packages/ui/src/tokens.css).
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}

/// 1:1 port of packages/ui/src/tokens.css. Values must stay in sync by hand.
enum OrbixColor {
    static let bg = Color(hex: 0x0B0D12)
    static let surface = Color(hex: 0x14171F)
    static let surface2 = Color(hex: 0x1C212B)
    static let surface3 = Color(hex: 0x232936)
    static let text = Color(hex: 0xE8EAF0)
    static let textMuted = Color(hex: 0xC2C8D4)
    static let textDim = Color(hex: 0x9AA3B2)
    static let accent = Color(hex: 0x6D7BFF)
    static let accent2 = Color(hex: 0xA06DFF)
    static let accentStrong = Color(hex: 0x4B57D6)
    static let danger = Color(hex: 0xEF4444)
    static let dangerStrong = Color(hex: 0xDC2626)
    static let live = Color(hex: 0xEF4444)
    static let success = Color(hex: 0x34D399)
    static let warning = Color(hex: 0xFBBF24)
    static let scrim = Color.black.opacity(0.62)
}

/// Web radii ×1.5 for 10-ft viewing (8/12/16px → 12/18/24pt).
enum OrbixRadius {
    static let sm: CGFloat = 12
    static let md: CGFloat = 18
    static let lg: CGFloat = 24
}

enum OrbixSpacing {
    static let cardGap: CGFloat = 12
    static let railGap: CGFloat = 40
    static let pageMargin: CGFloat = 80
}

enum OrbixType {
    /// Tracked-uppercase wordmark (web: font-extrabold uppercase tracking-[0.25em]).
    static func wordmark(size: CGFloat) -> Font { .system(size: size, weight: .heavy) }
    static let heroTitle: Font = .system(size: 76, weight: .heavy)
    static let rowHeading: Font = .system(size: 31, weight: .bold)
}
