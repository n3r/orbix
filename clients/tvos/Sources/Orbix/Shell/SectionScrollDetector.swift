import SwiftUI

/// Carries a section's `ScrollView` top-edge offset out of a `GeometryReader`
/// so `SectionScrollDetector`'s tvOS-17 fallback path can read it. Shared by
/// every section that has one (`HomeView`, `LibraryBrowseView`,
/// `WishlistView`): each declares its own named coordinate space on its own
/// `ScrollView` (see e.g. `HomeView.scrollSpace`), so reusing this one
/// `PreferenceKey` type across sections causes no cross-talk — a
/// `PreferenceKey` only propagates up through the view hierarchy it's set in,
/// and only one section's tree is ever mounted at a time (`ShellView`'s
/// `content` switch). Only the top-most reading matters.
struct ScrollOffsetKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

/// Flips a section's `isScrolled` binding once its content scrolls up past a
/// small threshold, so `ShellView`'s top bar goes transparent → near-solid
/// (web `useScrolled`). Extracted from `HomeView` (P5 Task 6, née
/// `HomeScrollDetector`) so `LibraryBrowseView` and `WishlistView` get the
/// same bar-re-solidify behavior — before this, scrolling either of those
/// sections left the bar permanently transparent (whatever `isScrolled` was
/// left at on the last section switch), since only `HomeView` ever drove it.
///
/// Prefers `onScrollGeometryChange` (tvOS 18+) — the reliable modern signal
/// every current Apple TV runs — and falls back to the `GeometryReader` +
/// `ScrollOffsetKey` offset in the caller's own named coordinate space on the
/// tvOS-17 floor (`onScrollGeometryChange` doesn't exist there). Both read
/// the same "content top moved up ~one nudge" idea: `contentOffset.y > 10`
/// (18+, positive as content scrolls up) mirrors the fallback's `minY < -10`.
///
/// Each section supplies its own `ScrollView`'s `.coordinateSpace(name:)` +
/// a `GeometryReader`-backed `ScrollOffsetKey` reader in its content (see
/// `HomeView.scrollOffsetReader`) — only the `ViewModifier` + `PreferenceKey`
/// moved here; the per-section wiring is unchanged from pre-extraction
/// `HomeView`.
struct SectionScrollDetector: ViewModifier {
    @Binding var isScrolled: Bool

    func body(content: Content) -> some View {
        if #available(tvOS 18.0, *) {
            content.onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentOffset.y > 10
            } action: { _, scrolled in
                if scrolled != isScrolled { isScrolled = scrolled }
            }
        } else {
            content.onPreferenceChange(ScrollOffsetKey.self) { offset in
                let scrolled = offset < -10
                if scrolled != isScrolled { isScrolled = scrolled }
            }
        }
    }
}
