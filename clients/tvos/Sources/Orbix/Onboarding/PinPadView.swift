import SwiftUI

/// Full-screen 4-digit PIN pad, shown (inside `OnboardingChrome`) when
/// selecting a PIN-protected profile: `ProfilePickerModel.select` attempts
/// `POST /api/profiles/:id/select` without a pin, the only 403 that route
/// ever sends is `{error: "pin_required"}` (both wires), and the picker
/// swaps this pad in (`ProfilePickerModel.pinPrompt`) — the same
/// state-swap idiom as its add-profile form. The pad is the tvOS
/// adaptation the web doesn't have — web parity used to stop at a
/// localized error (spec §12), superseded by the Phase-5 user decision to
/// ship PIN entry. Dumb by design (strings + callbacks in, digits out, no
/// OrbixKit import) so it previews without a client or model.
///
/// Auto-submits at 4 digits (`onChange(of: entered)`); a wrong PIN comes
/// back as a fresh nil→message `errorText` transition (the model resets
/// `pinError` to nil at the start of every attempt, so consecutive wrong
/// PINs still transition), which clears the dots for the next try.
struct PinPadView: View {
    let profileName: String
    let errorText: String?
    let isVerifying: Bool
    let onSubmit: (String) -> Void
    let onCancel: () -> Void

    @State private var entered = ""
    private static let pinLength = 4

    /// Square key side — big enough for a comfortable 10-ft focus target,
    /// small enough that the 3-wide grid (3×120 + 2×16 = 392pt) sits well
    /// inside `OnboardingChrome`'s centered card.
    private static let keySize: CGFloat = 120

    var body: some View {
        VStack(spacing: 36) {
            Text(L10n.t("profiles.pin.title"))
                .font(.title.bold())
                .foregroundStyle(OrbixColor.text)
            Text(profileName)
                .font(.title3)
                .foregroundStyle(OrbixColor.textDim)

            HStack(spacing: 20) {                    // 4-dot display
                ForEach(0..<Self.pinLength, id: \.self) { i in
                    Circle()
                        .fill(i < entered.count ? OrbixColor.text : OrbixColor.surface3)
                        .frame(width: 22, height: 22)
                }
            }
            .accessibilityIdentifier("pinDots")

            if let errorText {
                Text(errorText)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("pinErrorMessage")
            }

            VStack(spacing: 16) {                    // focusable 3×4 grid
                ForEach([[1, 2, 3], [4, 5, 6], [7, 8, 9]], id: \.self) { row in
                    HStack(spacing: 16) { ForEach(row, id: \.self, content: digitKey) }
                }
                HStack(spacing: 16) {
                    key(label: Image(systemName: "delete.left"), id: "pinKey_delete") {
                        if !entered.isEmpty { entered.removeLast() }
                    }
                    digitKey(0)
                    key(label: Text(L10n.t("profiles.pin.cancel")), id: "pinKey_cancel", action: onCancel)
                }
            }
            .focusSection()
            .disabled(isVerifying)
        }
        .onChange(of: entered) { _, new in
            guard new.count == Self.pinLength, !isVerifying else { return }
            onSubmit(new)
        }
        .onChange(of: errorText) { _, new in
            if new != nil { entered = "" }           // wrong PIN → clear the dots
        }
    }

    private func digitKey(_ n: Int) -> some View {
        key(label: Text("\(n)").monospacedDigit(), id: "pinKey_\(n)") {
            guard entered.count < Self.pinLength else { return }
            entered.append(String(n))
        }
    }

    /// A square key: label centered on a fixed `keySize` frame; the
    /// surface2 plate + focus ring + focus treatment live in
    /// `PinKeyButtonStyle` so they can react to `isFocused`/`isEnabled`.
    /// `minimumScaleFactor` only matters for the one non-glyph label
    /// ("Cancel"), which is wider than a digit.
    private func key(label: some View, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            label
                .font(.system(size: 33, weight: .semibold))
                .foregroundStyle(OrbixColor.text)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                .padding(.horizontal, 8)
                .frame(width: Self.keySize, height: Self.keySize)
        }
        .buttonStyle(PinKeyButtonStyle())
        .accessibilityIdentifier(id)
    }
}

/// The picker's `ProfileTileButtonStyle` focus treatment (`focusPromote` +
/// `focusEffectDisabled()`, i.e. no stock white platter) adapted to a
/// square pad key: unlike the tiles — whose ring wraps only the circular
/// art, not the name text — a key's label *is* the whole target, so the
/// `OrbixColor.surface2` plate and the white focus ring are drawn here on
/// the full `OrbixRadius.md` rounded square. Dims when disabled
/// (`isVerifying`), same idiom as `OrbixButtonStyle`.
private struct PinKeyButtonStyle: ButtonStyle {
    @Environment(\.isFocused) private var isFocused
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                RoundedRectangle(cornerRadius: OrbixRadius.md, style: .continuous)
                    .fill(OrbixColor.surface2)
            )
            .overlay(
                RoundedRectangle(cornerRadius: OrbixRadius.md, style: .continuous)
                    .strokeBorder(OrbixColor.text.opacity(0.9), lineWidth: isFocused ? 4 : 0)
            )
            .opacity(isEnabled ? 1.0 : 0.5)
            .focusPromote(isFocused)
            .focusEffectDisabled()
    }
}

#Preview("Clean") {
    OnboardingChrome {
        PinPadView(profileName: "Guest", errorText: nil, isVerifying: false, onSubmit: { _ in }, onCancel: {})
    }
}

#Preview("Wrong PIN") {
    OnboardingChrome {
        PinPadView(
            profileName: "Guest",
            errorText: "Wrong PIN. Try again.",
            isVerifying: false,
            onSubmit: { _ in },
            onCancel: {}
        )
    }
}

#Preview("Verifying") {
    OnboardingChrome {
        PinPadView(profileName: "Guest", errorText: nil, isVerifying: true, onSubmit: { _ in }, onCancel: {})
    }
}
