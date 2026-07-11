import OrbixKit
import Observation
import SwiftUI

struct BrowseView: View {
    let model: AppModel

    @State private var browseModel = BrowseModel()
    @State private var imageLoader = ImageLoader()
    @State private var path = NavigationPath()
    @State private var query = ""

    private let columns = [
        GridItem(.adaptive(minimum: 126, maximum: 150), spacing: 12)
    ]

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if let client = model.client {
                    content(client: client)
                        .task { await browseModel.load(client: client) }
                        .refreshable { await browseModel.reload(client: client) }
                } else {
                    ProgressView()
                }
            }
            .onChange(of: query) { _, newValue in
                guard let client = model.client else { return }
                browseModel.queryChanged(newValue, client: client)
            }
            .background(OrbixScreenBackground())
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
            .toolbar(.hidden, for: .navigationBar)
        }
    }

    @ViewBuilder
    private func content(client: OrbixClient) -> some View {
        switch browseModel.loadState {
        case .loading:
            ProgressView("Loading libraries")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .empty:
            ContentUnavailableView(
                "No libraries",
                systemImage: "rectangle.stack",
                description: Text("Add a library on the server to browse titles here.")
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .error(let message):
            ContentUnavailableView {
                Label("Couldn't load Browse", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Retry") { Task { await browseModel.reload(client: client) } }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .loaded:
            browseContent(client: client)
        }
    }

    private func browseContent(client: OrbixClient) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                browseHeader
                libraryPicker(client: client)
                sortPicker(client: client)
                filterField(client: client)

                if browseModel.isLoadingItems && browseModel.items.isEmpty {
                    ProgressView("Loading titles")
                        .frame(maxWidth: .infinity, minHeight: 260)
                } else if browseModel.items.isEmpty {
                    ContentUnavailableView(
                        query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "No titles" : "No matching titles",
                        systemImage: "film.stack",
                        description: Text("Try another library, sort, or filter.")
                    )
                    .frame(maxWidth: .infinity, minHeight: 300)
                } else {
                    LazyVGrid(columns: columns, alignment: .leading, spacing: 18) {
                        ForEach(browseModel.items, id: \.id) { card in
                            PosterCard(
                                card: card,
                                baseURL: model.baseURL,
                                imageLoader: imageLoader,
                                accessibilityIdentifier: "browse-card-\(card.id)"
                            ) {
                                path.append(TitleRoute(itemId: card.id, resume: card.resume))
                            }
                        }
                    }
                    .padding(.top, 4)
                    .accessibilityIdentifier("browse-grid")
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 18)
            .padding(.bottom, 120)
        }
        .scrollIndicators(.hidden)
    }

    private var browseHeader: some View {
        VStack(alignment: .leading, spacing: 8) {
            OrbixEyebrow(text: "Library")
            HStack(alignment: .lastTextBaseline) {
                Text(selectedLibraryName)
                    .font(.system(size: 31, weight: .black))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .minimumScaleFactor(0.78)
                Spacer()
                OrbixPill(text: "\(browseModel.items.count)", systemImage: "square.grid.2x2")
            }
            Text("Switch sources, sort the current library, or filter inside it without leaving the page.")
                .font(.callout)
                .foregroundStyle(OrbixMobileStyle.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func libraryPicker(client: OrbixClient) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(browseModel.libraries, id: \.libraryId) { library in
                    let selected = browseModel.selectedLibraryId == library.libraryId
                    Button {
                        Task { await browseModel.selectLibrary(library.libraryId, client: client) }
                    } label: {
                        OrbixPill(text: library.name, systemImage: "rectangle.stack", selected: selected)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("browse-library-\(library.libraryId)")
                }
            }
            .padding(.vertical, 2)
        }
        .accessibilityIdentifier("browse-library-picker")
    }

    private func sortPicker(client: OrbixClient) -> some View {
        HStack(spacing: 10) {
            ForEach(LibrarySort.allCases, id: \.self) { sort in
                Button {
                    Task { await browseModel.setSort(sort, client: client) }
                } label: {
                    OrbixPill(text: sort.displayTitle, systemImage: sort.systemImage, selected: browseModel.sort == sort)
                }
                .buttonStyle(.plain)
            }
        }
        .accessibilityIdentifier("browse-sort-picker")
    }

    private func filterField(client: OrbixClient) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(OrbixMobileStyle.secondaryText)

            TextField("Filter this library", text: $query)
                .font(.callout.weight(.semibold))
                .foregroundStyle(.white)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .accessibilityIdentifier("browse-filter-field")

            if !query.isEmpty {
                Button {
                    query = ""
                    browseModel.queryChanged("", client: client)
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.subheadline.weight(.bold))
                }
                .buttonStyle(.plain)
                .foregroundStyle(OrbixMobileStyle.secondaryText)
                .accessibilityLabel("Clear filter")
            }
        }
        .padding(.horizontal, 14)
        .frame(height: 46)
        .background(OrbixMobileStyle.panelStrong, in: RoundedRectangle(cornerRadius: 8))
        .overlay {
            RoundedRectangle(cornerRadius: 8)
                .stroke(OrbixMobileStyle.stroke, lineWidth: 1)
        }
    }

    private var selectedLibraryName: String {
        guard let selectedLibraryId = browseModel.selectedLibraryId,
              let library = browseModel.libraries.first(where: { $0.libraryId == selectedLibraryId }) else {
            return "Browse"
        }
        return library.name
    }
}

private extension LibrarySort {
    var displayTitle: String {
        switch self {
        case .title:
            "Title"
        case .added:
            "Added"
        case .year:
            "Year"
        }
    }

    var systemImage: String {
        switch self {
        case .title:
            "textformat"
        case .added:
            "clock"
        case .year:
            "calendar"
        }
    }
}

@MainActor
@Observable
final class BrowseModel {
    enum LoadState: Equatable {
        case loading
        case empty
        case error(String)
        case loaded
    }

    private static let debounceNanoseconds: UInt64 = 300_000_000

    private(set) var libraries: [MenuLibrary] = []
    private(set) var selectedLibraryId: String?
    private(set) var items: [MediaCard] = []
    private(set) var sort: LibrarySort = .title
    private(set) var query = ""
    private(set) var isLoadingMenu = false
    private(set) var isLoadingItems = false
    private(set) var loadError: String?
    private(set) var hasLoaded = false
    @ObservationIgnored private var pendingSearchTask: Task<Void, Never>?
    @ObservationIgnored private var itemLoadGeneration = 0

    deinit {
        pendingSearchTask?.cancel()
    }

    var loadState: LoadState {
        if isLoadingMenu && libraries.isEmpty { return .loading }
        if let loadError, libraries.isEmpty { return .error(loadError) }
        if hasLoaded && libraries.isEmpty { return .empty }
        if !hasLoaded { return .loading }
        return .loaded
    }

    func load(client: OrbixClient) async {
        guard !hasLoaded else { return }
        await reload(client: client)
    }

    func reload(client: OrbixClient) async {
        guard !isLoadingMenu else { return }
        pendingSearchTask?.cancel()
        isLoadingMenu = true
        loadError = nil

        do {
            let loadedLibraries = try await client.menu()
            libraries = loadedLibraries
            if selectedLibraryId == nil || !loadedLibraries.contains(where: { $0.libraryId == selectedLibraryId }) {
                selectedLibraryId = loadedLibraries.first?.libraryId
            }
            hasLoaded = true
            isLoadingMenu = false
            await loadItems(client: client)
        } catch {
            loadError = "Couldn't load libraries: \(error)"
            hasLoaded = true
            isLoadingMenu = false
        }
    }

    func selectLibrary(_ id: String, client: OrbixClient) async {
        guard selectedLibraryId != id else { return }
        selectedLibraryId = id
        pendingSearchTask?.cancel()
        await loadItems(client: client)
    }

    func setSort(_ sort: LibrarySort, client: OrbixClient) async {
        guard self.sort != sort else { return }
        self.sort = sort
        pendingSearchTask?.cancel()
        await loadItems(client: client)
    }

    func queryChanged(_ text: String, client: OrbixClient) {
        pendingSearchTask?.cancel()
        query = text.trimmingCharacters(in: .whitespacesAndNewlines)

        pendingSearchTask = Task { [weak self] in
            do {
                try await Task.sleep(nanoseconds: Self.debounceNanoseconds)
            } catch {
                return
            }
            guard let self, !Task.isCancelled else { return }
            await self.loadItems(client: client)
        }
    }

    private func loadItems(client: OrbixClient) async {
        guard let selectedLibraryId else { return }
        itemLoadGeneration += 1
        let generation = itemLoadGeneration
        let requestedSort = sort
        let requestedQuery = query

        isLoadingItems = true
        loadError = nil
        do {
            let loadedItems = try await client.libraryItems(
                libraryId: selectedLibraryId,
                sort: requestedSort,
                query: requestedQuery
            )
            guard generation == itemLoadGeneration else { return }
            items = loadedItems
        } catch {
            guard generation == itemLoadGeneration else { return }
            loadError = "Couldn't load titles: \(error)"
            items = []
        }
        if generation == itemLoadGeneration {
            isLoadingItems = false
        }
    }
}
