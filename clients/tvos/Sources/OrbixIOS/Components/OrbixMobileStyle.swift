import SwiftUI

enum OrbixMobileStyle {
    static let background = Color(red: 0.035, green: 0.039, blue: 0.047)
    static let backgroundRaised = Color(red: 0.055, green: 0.060, blue: 0.073)
    static let panel = Color.white.opacity(0.055)
    static let panelStrong = Color.white.opacity(0.085)
    static let stroke = Color.white.opacity(0.10)
    static let primaryText = Color.white
    static let secondaryText = Color.white.opacity(0.62)
    static let tertiaryText = Color.white.opacity(0.42)
    static let red = Color(red: 0.88, green: 0.10, blue: 0.16)
    static let amber = Color.white.opacity(0.58)
    static let teal = Color(red: 0.42, green: 0.72, blue: 0.86)
    static let selected = Color.white.opacity(0.13)
}

struct OrbixScreenBackground: View {
    var body: some View {
        ZStack {
            OrbixMobileStyle.background

            LinearGradient(
                colors: [
                    Color.white.opacity(0.055),
                    .clear,
                    OrbixMobileStyle.teal.opacity(0.045),
                ],
                startPoint: .top,
                endPoint: .bottomTrailing
            )
            .blur(radius: 42)
        }
        .ignoresSafeArea()
    }
}

struct OrbixEyebrow: View {
    let text: String
    var color: Color = OrbixMobileStyle.amber

    var body: some View {
        Text(text.uppercased())
            .font(.caption2.weight(.semibold))
            .foregroundStyle(color)
            .tracking(0.8)
            .accessibilityLabel(text)
    }
}

struct OrbixPill: View {
    let text: String
    var systemImage: String?
    var selected = false

    var body: some View {
        HStack(spacing: 7) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.caption.weight(.bold))
            }
            Text(text)
                .font(.caption.weight(.bold))
                .lineLimit(1)
        }
        .padding(.horizontal, 12)
        .frame(height: 30)
        .background(selected ? OrbixMobileStyle.selected : OrbixMobileStyle.panelStrong, in: Capsule())
        .foregroundStyle(selected ? OrbixMobileStyle.primaryText : OrbixMobileStyle.secondaryText)
        .overlay {
            Capsule().stroke(OrbixMobileStyle.stroke, lineWidth: 1)
        }
    }
}

struct OrbixSectionHeader: View {
    let title: String
    var detail: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
                .font(.title3.weight(.semibold))
                .foregroundStyle(.white)
            Spacer(minLength: 12)
            if let detail {
                Text(detail)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(OrbixMobileStyle.secondaryText)
                    .lineLimit(1)
            }
        }
    }
}

struct OrbixPrimaryActionLabel: View {
    let title: String
    let systemImage: String
    var isLoading = false

    var body: some View {
        HStack(spacing: 9) {
            Spacer(minLength: 0)
            if isLoading {
                ProgressView()
                    .tint(.black)
            } else {
                Image(systemName: systemImage)
            }
            Text(title)
            Spacer(minLength: 0)
        }
        .font(.headline)
        .frame(maxWidth: .infinity, minHeight: 48)
    }
}

struct OrbixSecondaryActionLabel: View {
    let title: String
    let systemImage: String

    var body: some View {
        HStack(spacing: 8) {
            Spacer(minLength: 0)
            Image(systemName: systemImage)
            Text(title)
            Spacer(minLength: 0)
        }
        .font(.headline)
        .frame(maxWidth: .infinity, minHeight: 48)
    }
}

struct OrbixGlassPanel<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        content()
            .padding(16)
            .background(OrbixMobileStyle.panel, in: RoundedRectangle(cornerRadius: 10))
            .overlay {
                RoundedRectangle(cornerRadius: 10)
                    .stroke(OrbixMobileStyle.stroke, lineWidth: 1)
            }
    }
}
