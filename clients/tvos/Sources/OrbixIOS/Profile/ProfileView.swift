import OrbixKit
import SwiftUI

struct ProfileView: View {
    let model: AppModel
    @State private var path = NavigationPath()
    @State private var showingDisconnectConfirmation = false

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    header
                    profileSummary
                    serverSummary
                    actions
                }
                .padding(.horizontal, 20)
                .padding(.top, 18)
                .padding(.bottom, 126)
            }
            .scrollIndicators(.hidden)
            .background(OrbixScreenBackground())
            .navigationTitle("Profile")
            .navigationBarTitleDisplayMode(.inline)
            .confirmationDialog(
                "Change server?",
                isPresented: $showingDisconnectConfirmation,
                titleVisibility: .visible
            ) {
                Button("Change Server", role: .destructive) {
                    model.disconnect()
                }
                .accessibilityIdentifier("confirm-change-server-button")

                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This clears the saved Orbix server and device token on this iPhone.")
            }
            .navigationDestination(for: TitleRoute.self) { route in
                TitleDetailView(
                    itemId: route.itemId,
                    preferredSeasonNumber: route.resumeSeasonNumber,
                    resumeEpisodeNumber: route.resumeEpisodeNumber,
                    resumeEpisodeLabel: route.resumeEpisodeLabel,
                    model: model,
                    path: $path
                )
            }
            .navigationDestination(for: SeasonRoute.self) { route in
                SeasonEpisodeView(seriesId: route.seriesId, seasonNumber: route.seasonNumber, model: model)
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            OrbixEyebrow(text: "Profile")

            HStack(alignment: .lastTextBaseline) {
                Text(profileName)
                    .font(.system(size: 32, weight: .black))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .minimumScaleFactor(0.78)
                Spacer(minLength: 12)
                OrbixPill(text: profileKind, systemImage: "person.crop.circle.fill")
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Who's Watching")
                .accessibilityIdentifier("profile-tab-title")

            Text("Server, profile, and saved titles")
                .font(.callout)
                .foregroundStyle(OrbixMobileStyle.secondaryText)
        }
    }

    private var profileSummary: some View {
        OrbixGlassPanel {
            HStack(spacing: 16) {
                InitialsAvatar(initials: initials)
                    .frame(width: 72, height: 72)

                VStack(alignment: .leading, spacing: 7) {
                    Text(profileName)
                        .font(.title3.bold())
                        .foregroundStyle(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .accessibilityIdentifier("active-profile-name")

                    HStack(spacing: 8) {
                        Text(profileKind)
                        if let maturityCap {
                            Text(maturityCap)
                        }
                    }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(OrbixMobileStyle.secondaryText)
                }

                Spacer(minLength: 0)
            }
        }
    }

    private var serverSummary: some View {
        OrbixGlassPanel {
            VStack(alignment: .leading, spacing: 8) {
                OrbixEyebrow(text: "Connected Server", color: OrbixMobileStyle.teal)

                Text(model.baseURL?.absoluteString ?? "Not connected")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(OrbixMobileStyle.secondaryText)
                    .lineLimit(2)
                    .textSelection(.enabled)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var actions: some View {
        VStack(spacing: 12) {
            NavigationLink {
                MyListView(model: model, path: $path)
            } label: {
                OrbixSecondaryActionLabel(title: "My List", systemImage: "checkmark.plus")
                    .background(OrbixMobileStyle.panelStrong, in: Capsule())
                    .overlay {
                        Capsule().stroke(OrbixMobileStyle.stroke, lineWidth: 1)
                    }
            }
            .buttonStyle(.plain)
            .foregroundStyle(.white)
            .accessibilityIdentifier("my-list-button")

            Button {
                model.switchProfile()
            } label: {
                OrbixPrimaryActionLabel(title: "Switch Profile", systemImage: "person.2.fill")
                    .background(.white, in: Capsule())
            }
            .buttonStyle(.plain)
            .foregroundStyle(.black)
            .accessibilityIdentifier("switch-profile-button")

            Button(role: .destructive) {
                showingDisconnectConfirmation = true
            } label: {
                OrbixSecondaryActionLabel(title: "Change Server", systemImage: "rectangle.portrait.and.arrow.right")
                    .background(OrbixMobileStyle.red.opacity(0.12), in: Capsule())
                    .overlay {
                        Capsule().stroke(OrbixMobileStyle.red.opacity(0.48), lineWidth: 1)
                    }
            }
            .buttonStyle(.plain)
            .foregroundStyle(OrbixMobileStyle.red)
            .accessibilityIdentifier("change-server-button")
        }
    }

    private var profileName: String {
        guard let name = model.activeProfile?.name, !name.isEmpty else { return "Unknown Profile" }
        return name
    }

    private var profileKind: String {
        switch model.activeProfile?.kind {
        case "kids":
            return "Kids"
        case "standard":
            return "Standard"
        case let kind? where !kind.isEmpty:
            return kind.capitalized
        default:
            return "Profile"
        }
    }

    private var maturityCap: String? {
        guard let cap = model.activeProfile?.maturityCap else { return nil }
        return "Cap \(cap)"
    }

    private var initials: String {
        let letters = profileName.split(separator: " ").prefix(2).compactMap(\.first).map(String.init)
        return letters.isEmpty ? "?" : letters.joined().uppercased()
    }
}
