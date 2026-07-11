import OrbixKit
import SwiftUI
import UIKit

struct ProfilePickerView: View {
    let model: AppModel

    @State private var profileModel = ProfilePickerModel()
    @State private var imageLoader = ImageLoader()
    @State private var pinPromptProfile: Profile?
    @State private var pinEntry = ""
    @State private var pinError: String?

    private let columns = [
        GridItem(.adaptive(minimum: 145, maximum: 190), spacing: 14)
    ]

    var body: some View {
        Group {
            if let client = model.client {
                content(client: client)
                    .task { await profileModel.load(client: client) }
            } else {
                ProgressView()
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(OrbixScreenBackground())
        .sheet(isPresented: pinSheetBinding) {
            if let profile = pinPromptProfile, let client = model.client {
                ProfilePinPromptView(
                    profile: profile,
                    pin: $pinEntry,
                    errorMessage: pinError,
                    isSubmitting: profileModel.selectingId == profile.id,
                    onCancel: clearPinPrompt,
                    onSubmit: { submitPin(for: profile, client: client) }
                )
                .presentationDetents([.height(310)])
                .presentationDragIndicator(.visible)
            }
        }
    }

    @ViewBuilder
    private func content(client: OrbixClient) -> some View {
        VStack(alignment: .leading, spacing: 22) {
            VStack(alignment: .leading, spacing: 8) {
                OrbixEyebrow(text: "Profiles")
                Text("Who's Watching?")
                    .font(.system(size: 34, weight: .black))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("profile-picker-title")
                Text("Each profile keeps its own progress, list, and server-enforced safety rules.")
                    .font(.callout)
                    .foregroundStyle(OrbixMobileStyle.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if profileModel.isLoading && profileModel.profiles.isEmpty {
                Spacer()
                ProgressView("Loading profiles")
                    .frame(maxWidth: .infinity)
                Spacer()
            } else if let loadError = profileModel.loadError, profileModel.profiles.isEmpty {
                errorView(message: loadError, client: client)
            } else {
                ScrollView {
                    LazyVGrid(columns: columns, spacing: 24) {
                        ForEach(profileModel.profiles, id: \.id) { profile in
                            profileButton(profile, client: client)
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
        }
    }

    private func profileButton(_ profile: Profile, client: OrbixClient) -> some View {
        let isSelecting = profileModel.selectingId == profile.id
        return Button {
            select(profile, client: client)
        } label: {
            VStack(alignment: .leading, spacing: 14) {
                ZStack(alignment: .topTrailing) {
                    avatarView(for: profile)
                        .frame(width: 72, height: 72)
                        .opacity(isSelecting ? 0.45 : 1)
                        .overlay {
                            if isSelecting {
                                ProgressView()
                            }
                        }

                    if profile.kind == "kids" {
                        Text("KIDS")
                            .font(.caption2.bold())
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(.yellow, in: Capsule())
                            .foregroundStyle(.black)
                            .offset(x: 6, y: -4)
                    }
                }

                Text(profile.name)
                    .font(.headline)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)

                HStack(spacing: 6) {
                    OrbixPill(
                        text: profile.kind == "kids" ? "Kids" : "Standard",
                        systemImage: profile.kind == "kids" ? "shield.fill" : "person.fill"
                    )
                    if let cap = profile.maturityCap {
                        OrbixPill(text: "Cap \(cap)")
                    }
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity)
            .frame(height: 166, alignment: .topLeading)
            .background(OrbixMobileStyle.panel, in: RoundedRectangle(cornerRadius: 8))
            .overlay(alignment: .center) {
                RoundedRectangle(cornerRadius: 8).stroke(OrbixMobileStyle.stroke, lineWidth: 1)
            }
        }
        .buttonStyle(.plain)
        .disabled(isSelecting)
        .accessibilityIdentifier("profile-button-\(profile.id)")
    }

    @ViewBuilder
    private func avatarView(for profile: Profile) -> some View {
        if let avatarPath = profile.avatar, let baseURL = model.baseURL {
            RemoteImage(url: baseURL.appending(path: "api/images/\(avatarPath)"), imageLoader: imageLoader) {
                InitialsAvatar(initials: initials(for: profile.name))
            }
        } else {
            InitialsAvatar(initials: initials(for: profile.name))
        }
    }

    private func errorView(message: String, client: OrbixClient) -> some View {
        ContentUnavailableView {
            Label("Couldn't load profiles", systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            Button("Retry") { Task { await profileModel.load(client: client) } }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func initials(for name: String) -> String {
        let letters = name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init)
        return letters.isEmpty ? "?" : letters.joined().uppercased()
    }

    private func select(_ profile: Profile, client: OrbixClient) {
        Task { @MainActor in
            let result = await profileModel.select(profile.id, client: client)
            switch result {
            case .selected:
                model.profileSelected(profile)
            case .pinRequired:
                pinEntry = ""
                pinError = nil
                pinPromptProfile = profile
            case .failed:
                break
            }
        }
    }

    private var pinSheetBinding: Binding<Bool> {
        Binding(
            get: { pinPromptProfile != nil },
            set: { isPresented in
                if !isPresented {
                    clearPinPrompt()
                }
            }
        )
    }

    private func submitPin(for profile: Profile, client: OrbixClient) {
        let trimmed = pinEntry.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            pinError = "Enter the PIN."
            return
        }

        Task { @MainActor in
            let result = await profileModel.select(profile.id, pin: trimmed, client: client)
            switch result {
            case .selected:
                clearPinPrompt()
                model.profileSelected(profile)
            case .pinRequired:
                pinEntry = ""
                pinError = "Incorrect PIN."
            case .failed:
                pinError = profileModel.loadError ?? "Couldn't unlock this profile."
            }
        }
    }

    private func clearPinPrompt() {
        pinPromptProfile = nil
        pinEntry = ""
        pinError = nil
    }
}

struct InitialsAvatar: View {
    let initials: String

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8)
                .fill(
                    LinearGradient(
                        colors: [OrbixMobileStyle.red.opacity(0.48), OrbixMobileStyle.teal.opacity(0.26)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .overlay {
                    RoundedRectangle(cornerRadius: 8).stroke(OrbixMobileStyle.stroke, lineWidth: 1)
                }
            Text(initials)
                .font(.system(size: 28, weight: .black))
        }
    }
}

@MainActor
@Observable
final class ProfilePickerModel {
    enum SelectResult: Equatable {
        case selected
        case pinRequired
        case failed
    }

    private(set) var profiles: [Profile] = []
    private(set) var isLoading = false
    private(set) var loadError: String?
    private(set) var selectingId: String?

    func load(client: OrbixClient) async {
        guard !isLoading else { return }
        isLoading = true
        loadError = nil
        do {
            profiles = try await client.profiles()
        } catch {
            loadError = "Couldn't load profiles: \(error)"
        }
        isLoading = false
    }

    func select(_ id: String, pin: String? = nil, client: OrbixClient) async -> SelectResult {
        guard selectingId == nil else { return .failed }
        selectingId = id
        loadError = nil
        defer { selectingId = nil }
        do {
            try await client.selectProfile(id: id, pin: pin)
            return .selected
        } catch {
            if let selectionError = error as? ProfileSelectionError, selectionError == .pinRequired {
                return .pinRequired
            }
            loadError = "Couldn't select profile: \(error)"
            return .failed
        }
    }
}

private struct ProfilePinPromptView: View {
    let profile: Profile
    @Binding var pin: String
    var errorMessage: String?
    var isSubmitting: Bool
    var onCancel: () -> Void
    var onSubmit: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            OrbixEyebrow(text: "Locked Profile")
            Text("Enter Profile PIN")
                .font(.title2.bold())
                .accessibilityIdentifier("profile-pin-title")

            Text(profile.name)
                .font(.headline)
                .foregroundStyle(OrbixMobileStyle.secondaryText)

            SecureField("PIN", text: $pin)
                .keyboardType(.numberPad)
                .textContentType(.oneTimeCode)
                .font(.title3.monospacedDigit())
                .padding(.horizontal, 14)
                .frame(height: 50)
                .background(.white.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
                .disabled(isSubmitting)
                .accessibilityIdentifier("pin-entry-field")

            if let errorMessage {
                Text(errorMessage)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("pin-error-message")
            }

            HStack(spacing: 12) {
                Button("Cancel", role: .cancel, action: onCancel)
                    .frame(maxWidth: .infinity, minHeight: 46)
                    .accessibilityIdentifier("pin-cancel-button")

                Button {
                    onSubmit()
                } label: {
                    if isSubmitting {
                        ProgressView()
                    } else {
                        Text("Unlock")
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(.white)
                .foregroundStyle(.black)
                .frame(maxWidth: .infinity, minHeight: 46)
                .disabled(isSubmitting)
                .accessibilityIdentifier("pin-unlock-button")
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(OrbixScreenBackground())
        .foregroundStyle(.white)
    }
}
