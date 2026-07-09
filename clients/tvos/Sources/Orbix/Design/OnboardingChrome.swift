import SwiftUI

/// Full-screen chrome for the pre-`ShellView` onboarding flow (server
/// selection + pairing), ported in intent from the web login/setup
/// composition (`apps/web/src/pages/LoginPage.tsx`): a full-bleed
/// `OrbixColor.bg`, a soft accent "orbit glow" blurred behind a centered
/// `OrbixColor.surface` card, and a tracked-uppercase wordmark above it.
///
/// Purely presentational — callers hand in whatever content they already
/// render for a given onboarding state (scanning / server list / manual
/// entry / pairing code) and this only supplies the surrounding chrome, so
/// wrapping a view in it changes nothing about that view's logic, state, or
/// accessibility identifiers.
struct OnboardingChrome<Content: View>: View {
    private let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        ZStack {
            OrbixColor.bg.ignoresSafeArea()

            OrbitGlow()

            VStack(spacing: 40) {
                wordmark
                card
            }
            .padding(OrbixSpacing.pageMargin)
        }
    }

    /// Web: `text-2xl font-extrabold uppercase tracking-[0.25em]
    /// text-[var(--accent)]` centered above the `Card`. `OrbixTopBar`'s
    /// wordmark is the same treatment but is a `private var` in a file this
    /// task doesn't own, so this is a small local copy rather than an
    /// extraction.
    private var wordmark: some View {
        Text(L10n.t("common.app.wordmark"))
            .font(OrbixType.wordmark(size: 44))
            .kerning(10)
            .foregroundStyle(OrbixColor.accent)
    }

    /// Web: `<Card>` (`bg-[var(--surface)] rounded-[var(--radius)] p-4`).
    private var card: some View {
        content
            .padding(64)
            .background(
                RoundedRectangle(cornerRadius: OrbixRadius.lg, style: .continuous)
                    .fill(OrbixColor.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: OrbixRadius.lg, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.06))
            )
    }
}

/// The web login screen's "one brand moment" — a blurred accent glow behind
/// the card (web: `rounded-full bg-[var(--accent)]/15 blur-3xl`), widened
/// here into an `accent` → `accent2` → clear radial blend at TV scale.
private struct OrbitGlow: View {
    var body: some View {
        RadialGradient(
            colors: [OrbixColor.accent, OrbixColor.accent2, .clear],
            center: .center,
            startRadius: 0,
            endRadius: 460
        )
        .opacity(0.35)
        .frame(width: 920, height: 920)
        .blur(radius: 140)
        .offset(y: -200)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

#Preview {
    OnboardingChrome {
        VStack(spacing: 24) {
            Text("Preview content").font(.title2)
        }
        .frame(maxWidth: 700)
    }
}
