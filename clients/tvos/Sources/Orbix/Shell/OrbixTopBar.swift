import OrbixKit
import SwiftUI

/// The custom top bar that replaces the stock tvOS `TabView`, ported in
/// intent from the web `TopNav` (`apps/web/src/components/shell/TopNav.tsx` +
/// `NavCategories` + `icons.tsx`). Item order matches the web exactly:
///
/// - **Left cluster:** wordmark (tracked-uppercase accent brand mark), Home,
///   TV (hidden when the active profile is a kids profile), then up to
///   `maxVisibleCategories` catalog categories from `model.menuItems`, with
///   any overflow collapsed into a "More" menu.
/// - **Right cluster:** wishlist heart, search magnifier, account avatar.
///
/// Visual states mirror the web: the **focused** item is white and scaled up
/// (the tvOS analogue of the web's hover/underline emphasis); the
/// **selected** item (the current `selection`) uses `OrbixColor.text`
/// (accent for the wishlist heart, matching web); everything else sits at
/// `OrbixColor.textDim`. The background is the web's transparent
/// black-gradient normally and turns near-solid `OrbixColor.bg` once
/// `isScrolled` is true (Home wires real scroll detection in Phase 2; other
/// sections pass a constant `false` for now).
///
/// The whole bar is one `.focusSection()` so the tvOS focus engine keeps
/// left/right movement inside the bar and hands off to the content below on
/// a down press. The wordmark is intentionally a non-focusable brand mark
/// (not a redundant second "go Home" target next to the Home item) — a
/// deliberate simplification over strict web parity, where hover makes an
/// extra logo link harmless but a TV remote's discrete focus does not.
struct OrbixTopBar: View {
    let model: AppModel
    @Binding var selection: AppSection
    var isScrolled: Bool

    /// Web `NavCategories` default (`maxVisible = 6`): the first six
    /// categories render inline; the rest fold into the "More" menu.
    private static let maxVisibleCategories = 6

    private var isKids: Bool { model.activeProfile?.kind == "kids" }
    private var categories: [MenuItem] { model.menuItems }
    private var visibleCategories: ArraySlice<MenuItem> { categories.prefix(Self.maxVisibleCategories) }
    private var overflowCategories: ArraySlice<MenuItem> { categories.dropFirst(Self.maxVisibleCategories) }

    var body: some View {
        HStack(spacing: 0) {
            HStack(spacing: 28) {
                wordmark
                labeledItem(.home, "Home", systemImage: "house.fill", id: "nav_home")
                if !isKids {
                    labeledItem(.tv, "TV", systemImage: "tv", id: "nav_tv")
                }
                categoryItems
            }

            Spacer(minLength: 24)

            HStack(spacing: 16) {
                iconItem(.wishlist,
                         systemImage: selection == .wishlist ? "heart.fill" : "heart",
                         selectedColor: OrbixColor.accent,
                         id: "nav_wishlist")
                iconItem(.search,
                         systemImage: "magnifyingglass",
                         selectedColor: OrbixColor.text,
                         id: "nav_search")
                avatarItem
            }
        }
        .padding(.horizontal, 64)
        .padding(.vertical, 24)
        .frame(maxWidth: .infinity)
        .background(background)
        .animation(.easeInOut(duration: 0.3), value: isScrolled)
        .focusSection()
    }

    // MARK: - Left cluster

    /// Non-focusable brand mark (see the type's doc comment). Web:
    /// `text-lg font-extrabold uppercase tracking-[0.25em] text-[var(--accent)]`.
    private var wordmark: some View {
        Text("ORBIX")
            .font(OrbixType.wordmark(size: 34))
            .kerning(8)
            .foregroundStyle(OrbixColor.accent)
            .accessibilityIdentifier("nav_wordmark")
    }

    @ViewBuilder
    private var categoryItems: some View {
        ForEach(visibleCategories, id: \.libraryId) { item in
            labeledItem(.category(item.libraryId),
                        item.name ?? "Library",
                        systemImage: nil,
                        id: "nav_category_\(item.libraryId)")
        }
        if !overflowCategories.isEmpty {
            moreMenu
        }
    }

    /// Web `NavCategories`' `<details>` overflow dropdown, as a tvOS `Menu`.
    private var moreMenu: some View {
        Menu {
            ForEach(overflowCategories, id: \.libraryId) { item in
                Button(item.name ?? "Library") { selection = .category(item.libraryId) }
            }
        } label: {
            HStack(spacing: 6) {
                Text("More").font(.system(size: 26))
                Image(systemName: "chevron.down").font(.system(size: 18))
            }
        }
        .menuStyle(.automatic)
        .foregroundStyle(OrbixColor.textDim)
        .accessibilityIdentifier("nav_more")
    }

    // MARK: - Right cluster

    private var avatarItem: some View {
        Button {
            selection = .account
        } label: {
            AvatarView(name: model.activeProfile?.name ?? "?", imageURL: avatarURL, size: 44)
        }
        .buttonStyle(AvatarItemStyle())
        .accessibilityIdentifier("nav_account")
    }

    private var avatarURL: URL? {
        guard let avatar = model.activeProfile?.avatar, let baseURL = model.baseURL else { return nil }
        return baseURL.appending(path: "api/images/\(avatar)")
    }

    // MARK: - Item builders

    /// A labeled left-cluster item (Home / TV / a category). `systemImage`
    /// is `nil` for categories (web categories are text-only).
    private func labeledItem(_ section: AppSection, _ title: String, systemImage: String?, id: String) -> some View {
        let selected = selection == section
        return Button {
            selection = section
        } label: {
            HStack(spacing: 8) {
                if let systemImage {
                    Image(systemName: systemImage).font(.system(size: 22))
                }
                Text(title).font(.system(size: 26, weight: selected ? .semibold : .regular))
            }
        }
        .buttonStyle(NavItemStyle(isSelected: selected,
                                  selectedColor: OrbixColor.text,
                                  normalColor: OrbixColor.textDim))
        .accessibilityIdentifier(id)
    }

    /// An icon-only right-cluster item (wishlist / search). Web renders these
    /// at `OrbixColor.text` when idle (not the dimmer `textDim` of the left
    /// cluster), so `normalColor` is `.text`; `selectedColor` is per-item
    /// (accent for the wishlist heart, matching web's `text-[var(--accent)]`).
    private func iconItem(_ section: AppSection, systemImage: String, selectedColor: Color, id: String) -> some View {
        let selected = selection == section
        return Button {
            selection = section
        } label: {
            Image(systemName: systemImage).font(.system(size: 24))
        }
        .buttonStyle(NavItemStyle(isSelected: selected,
                                  selectedColor: selectedColor,
                                  normalColor: OrbixColor.text))
        .accessibilityIdentifier(id)
    }

    // MARK: - Background

    @ViewBuilder
    private var background: some View {
        if isScrolled {
            // Web: `bg-[var(--bg)]/95 backdrop-blur border-b border-[var(--surface)]`.
            OrbixColor.bg.opacity(0.95)
                .overlay(alignment: .bottom) {
                    OrbixColor.surface.frame(height: 1)
                }
                .ignoresSafeArea(edges: .top)
        } else {
            // Web: `bg-gradient-to-b from-black/70 via-black/25 to-transparent`.
            LinearGradient(
                stops: [
                    .init(color: .black.opacity(0.7), location: 0),
                    .init(color: .black.opacity(0.25), location: 0.5),
                    .init(color: .clear, location: 1.0),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea(edges: .top)
        }
    }
}

/// Shared focus/selection styling for the bar's text and icon items — the
/// tvOS translation of the web link states. Reads `isFocused` off the
/// environment (same pattern as `OrbixButtonStyle`): focus wins over
/// selection and renders white + scaled; an unfocused-but-selected item uses
/// `selectedColor`; everything else uses `normalColor`.
private struct NavItemStyle: ButtonStyle {
    let isSelected: Bool
    let selectedColor: Color
    let normalColor: Color
    @Environment(\.isFocused) private var isFocused

    func makeBody(configuration: Configuration) -> some View {
        let color = isFocused ? Color.white : (isSelected ? selectedColor : normalColor)
        return configuration.label
            .foregroundStyle(color)
            .scaleEffect(isFocused ? 1.12 : 1.0)
            .animation(.easeOut(duration: 0.15), value: isFocused)
    }
}

/// The avatar button grows and gains a ring on focus (an image can't recolor
/// the way the text/icon items do), matching the web `focusRing` treatment.
private struct AvatarItemStyle: ButtonStyle {
    @Environment(\.isFocused) private var isFocused

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .overlay {
                Circle()
                    .strokeBorder(Color.white, lineWidth: isFocused ? 3 : 0)
            }
            .scaleEffect(isFocused ? 1.12 : 1.0)
            .animation(.easeOut(duration: 0.15), value: isFocused)
    }
}
