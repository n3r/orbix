import OrbixKit
import SwiftUI

struct MyListView: View {
    let model: AppModel
    @Binding var path: NavigationPath

    @State private var listModel = MyListModel()
    @State private var imageLoader = ImageLoader()

    private let columns = [
        GridItem(.adaptive(minimum: 126, maximum: 150), spacing: 14)
    ]

    var body: some View {
        Group {
            if let client = model.client {
                content(client: client)
                    .task { await listModel.load(client: client) }
                    .refreshable { await listModel.reload(client: client) }
            } else {
                ProgressView()
            }
        }
        .background(OrbixScreenBackground())
        .navigationTitle("My List")
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private func content(client: OrbixClient) -> some View {
        switch listModel.loadState {
        case .loading:
            ProgressView("Loading")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .empty:
            ContentUnavailableView(
                "No saved titles",
                systemImage: "checkmark.plus",
                description: Text("Save movies and series from title pages to find them here.")
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .error(let message):
            ContentUnavailableView {
                Label("Couldn't load My List", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Retry") { Task { await listModel.reload(client: client) } }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .loaded(let items):
            results(items)
        }
    }

    private func results(_ items: [MediaCard]) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(alignment: .lastTextBaseline) {
                    VStack(alignment: .leading, spacing: 7) {
                        OrbixEyebrow(text: "Saved")
                        Text("My List")
                            .font(.system(size: 31, weight: .black))
                            .foregroundStyle(.white)
                    }
                    Spacer(minLength: 12)
                    OrbixPill(text: "\(items.count)", systemImage: "checkmark.plus")
                }

                LazyVGrid(columns: columns, alignment: .leading, spacing: 18) {
                    ForEach(items, id: \.id) { card in
                        PosterCard(
                            card: card,
                            baseURL: model.baseURL,
                            imageLoader: imageLoader,
                            accessibilityIdentifier: "my-list-card-\(card.id)"
                        ) {
                            path.append(TitleRoute(itemId: card.id, resume: card.resume))
                        }
                    }
                }
                .accessibilityIdentifier("my-list-grid")
            }
            .padding(.horizontal, 20)
            .padding(.top, 18)
            .padding(.bottom, 126)
        }
        .scrollIndicators(.hidden)
    }
}

@MainActor
@Observable
final class MyListModel {
    enum LoadState: Equatable {
        case loading
        case empty
        case error(String)
        case loaded([MediaCard])
    }

    private(set) var items: [MediaCard] = []
    private(set) var isLoading = false
    private(set) var loadError: String?
    private(set) var hasLoaded = false

    var loadState: LoadState {
        guard !items.isEmpty else {
            if isLoading || !hasLoaded { return .loading }
            if let loadError { return .error(loadError) }
            return .empty
        }
        return .loaded(items)
    }

    func load(client: OrbixClient) async {
        guard !hasLoaded else { return }
        await reload(client: client)
    }

    func reload(client: OrbixClient) async {
        guard !isLoading else { return }
        isLoading = true
        loadError = nil
        do {
            items = try await client.wishlist()
        } catch {
            loadError = "Couldn't load My List: \(error)"
        }
        isLoading = false
        hasLoaded = true
    }
}
