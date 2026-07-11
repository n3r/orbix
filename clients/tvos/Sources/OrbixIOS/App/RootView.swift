import OrbixKit
import SwiftUI

struct RootView: View {
    @State private var model = AppModel()
    @State private var selectedTab: OrbixTab = .home

    var body: some View {
        Group {
            switch model.phase {
            case .needsServer:
                ServerSelectionView(model: model)
            case .needsPairing:
                if model.client != nil {
                    PairingView(model: model)
                } else {
                    ServerSelectionView(model: model)
                }
            case .needsProfile:
                if model.client != nil {
                    ProfilePickerView(model: model)
                } else {
                    ServerSelectionView(model: model)
                }
            case .ready:
                ZStack(alignment: .bottom) {
                    currentTab
                        .frame(maxWidth: .infinity, maxHeight: .infinity)

                    OrbixTabBar(selectedTab: $selectedTab)
                }
                .background(OrbixScreenBackground())
            }
        }
        .onChange(of: model.phase) { oldPhase, newPhase in
            if oldPhase != .ready, newPhase == .ready {
                selectedTab = .home
            }
        }
    }

    @ViewBuilder
    private var currentTab: some View {
        switch selectedTab {
        case .home:
            HomeView(model: model)
        case .browse:
            BrowseView(model: model)
        case .search:
            SearchView(model: model)
        case .profile:
            ProfileView(model: model)
        }
    }
}

#Preview {
    RootView()
}

private enum OrbixTab: String, CaseIterable, Identifiable {
    case home
    case browse
    case search
    case profile

    var id: String { rawValue }

    var title: String {
        switch self {
        case .home:
            "Home"
        case .browse:
            "Browse"
        case .search:
            "Search"
        case .profile:
            "Profile"
        }
    }

    var systemImage: String {
        switch self {
        case .home:
            "house.fill"
        case .browse:
            "rectangle.stack.fill"
        case .search:
            "magnifyingglass"
        case .profile:
            "person.crop.circle.fill"
        }
    }
}

private struct OrbixTabBar: View {
    @Binding var selectedTab: OrbixTab

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                ForEach(OrbixTab.allCases) { tab in
                    tabButton(tab)
                }
            }
            .padding(.horizontal, 8)
            .padding(.top, 8)
            .padding(.bottom, 9)
        }
        .background(.black)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(OrbixMobileStyle.stroke)
                .frame(height: 1)
        }
        .ignoresSafeArea(.container, edges: .bottom)
    }

    private func tabButton(_ tab: OrbixTab) -> some View {
        let isSelected = selectedTab == tab

        return Button {
            selectedTab = tab
        } label: {
            VStack(spacing: 4) {
                Image(systemName: tab.systemImage)
                    .font(.system(size: 18, weight: isSelected ? .semibold : .regular))
                    .frame(height: 21)

                Text(tab.title)
                    .font(.caption2.weight(isSelected ? .semibold : .medium))
                    .lineLimit(1)
                    .minimumScaleFactor(0.78)
            }
            .frame(maxWidth: .infinity, minHeight: 50)
            .foregroundStyle(isSelected ? OrbixMobileStyle.primaryText : OrbixMobileStyle.secondaryText)
            .background {
                if isSelected {
                    RoundedRectangle(cornerRadius: 10)
                        .fill(OrbixMobileStyle.selected)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(tab.title)
        .accessibilityValue(isSelected ? "Selected" : "")
        .accessibilityIdentifier("orbix-tab-\(tab.rawValue)-button")
    }
}
