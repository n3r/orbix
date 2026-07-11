import OrbixKit
import Observation
import SwiftUI

struct SearchView: View {
    let model: AppModel

    @State private var searchModel = SearchModel()
    @State private var imageLoader = ImageLoader()
    @State private var path = NavigationPath()
    @State private var query = ""

    private let columns = [
        GridItem(.adaptive(minimum: 126, maximum: 150), spacing: 14)
    ]

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if let client = model.client {
                    content(client: client)
                } else {
                    ProgressView()
                }
            }
            .navigationTitle("Search")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, prompt: "Titles, genres, moods")
            .onChange(of: query) { _, newValue in
                guard let client = model.client else { return }
                searchModel.queryChanged(newValue, client: client)
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
        }
    }

    @ViewBuilder
    private func content(client: OrbixClient) -> some View {
        switch searchModel.loadState(for: query) {
        case .prompt:
            promptContent(client: client)
        case .loading:
            searchingContent()
        case .noResults(let searchedQuery):
            noResultsContent(searchedQuery, client: client)
        case .error(let message):
            ContentUnavailableView {
                Label("Couldn't search", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Retry") { searchModel.queryChanged(query, client: client) }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .loaded(let items):
            results(items, client: client)
        }
    }

    private func promptContent(client: OrbixClient) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                searchHeader(title: "Find a title", detail: "Mood search")
                    .padding(.top, 18)

                if !searchModel.recentQueries.isEmpty {
                    suggestionSection(
                        title: "Recent Searches",
                        suggestions: searchModel.recentQueries.map { SearchSuggestion(title: $0, query: $0) },
                        identifierPrefix: "recent-search",
                        client: client
                    )
                }

                suggestionSection(
                    title: "Try a mood or genre",
                    suggestions: SearchSuggestion.defaults,
                    identifierPrefix: "search-suggestion",
                    client: client
                )
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 120)
        }
        .scrollIndicators(.hidden)
    }

    private func searchingContent() -> some View {
        VStack(spacing: 18) {
            ProgressView()
                .controlSize(.large)
            Text("Searching")
                .font(.headline)
                .foregroundStyle(OrbixMobileStyle.secondaryText)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func noResultsContent(_ searchedQuery: String, client: OrbixClient) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                ContentUnavailableView(
                    "No results for \"\(searchedQuery)\"",
                    systemImage: "magnifyingglass",
                    description: Text("Try a different title, genre, or mood.")
                )
                .frame(maxWidth: .infinity, minHeight: 260)

                suggestionSection(
                    title: "Try instead",
                    suggestions: SearchSuggestion.defaults,
                    identifierPrefix: "search-suggestion",
                    client: client
                )
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 120)
        }
        .scrollIndicators(.hidden)
    }

    private func results(_ items: [MediaCard], client: OrbixClient) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                searchHeader(title: "Top results", detail: "\(items.count) matches")
                    .padding(.horizontal, 20)

                if !searchModel.recentQueries.isEmpty {
                    compactRecentSearches(client: client)
                }

                LazyVGrid(columns: columns, alignment: .leading, spacing: 18) {
                    ForEach(items, id: \.id) { card in
                        PosterCard(
                            card: card,
                            baseURL: model.baseURL,
                            imageLoader: imageLoader,
                            accessibilityIdentifier: "search-card-\(card.id)"
                        ) {
                            path.append(TitleRoute(itemId: card.id))
                        }
                    }
                }
                .padding(.horizontal, 20)
                .accessibilityIdentifier("search-results-grid")
            }
            .padding(.top, 18)
            .padding(.bottom, 120)
        }
        .scrollIndicators(.hidden)
    }

    private func compactRecentSearches(client: OrbixClient) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(searchModel.recentQueries, id: \.self) { query in
                    suggestionButton(
                        SearchSuggestion(title: query, query: query),
                        identifierPrefix: "recent-search",
                        client: client
                    )
                }
            }
            .padding(.horizontal, 20)
        }
        .accessibilityIdentifier("recent-searches-strip")
    }

    private func suggestionSection(
        title: String,
        suggestions: [SearchSuggestion],
        identifierPrefix: String,
        client: OrbixClient
    ) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            OrbixSectionHeader(title: title)

            FlowLayout(spacing: 10, rowSpacing: 10) {
                ForEach(suggestions, id: \.query) { suggestion in
                    suggestionButton(suggestion, identifierPrefix: identifierPrefix, client: client)
                }
            }
        }
    }

    private func suggestionButton(
        _ suggestion: SearchSuggestion,
        identifierPrefix: String,
        client: OrbixClient
    ) -> some View {
        Button {
            query = suggestion.query
            searchModel.queryChanged(suggestion.query, client: client, immediate: true)
        } label: {
            OrbixPill(text: suggestion.title, systemImage: suggestion.systemImage)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("\(identifierPrefix)-\(suggestion.accessibilityKey)")
    }

    private func searchHeader(title: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            OrbixEyebrow(text: "Search")

            HStack(alignment: .lastTextBaseline) {
                Text(title)
                    .font(.system(size: 31, weight: .black))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .minimumScaleFactor(0.78)
                Spacer(minLength: 12)
                OrbixPill(text: detail, systemImage: "magnifyingglass")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

@MainActor
@Observable
final class SearchModel {
    enum LoadState: Equatable {
        case prompt
        case loading
        case noResults(String)
        case error(String)
        case loaded([MediaCard])
    }

    private static let debounceNanoseconds: UInt64 = 350_000_000
    private static let recentQueriesKey = "dev.orbix.ios.search.recentQueries"

    private(set) var results: [MediaCard] = []
    private(set) var recentQueries: [String]
    private(set) var loadError: String?
    private(set) var isSearching = false
    private(set) var searchedQuery = ""
    @ObservationIgnored private var pendingTask: Task<Void, Never>?
    @ObservationIgnored private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.recentQueries = defaults.stringArray(forKey: Self.recentQueriesKey) ?? []
    }

    deinit {
        pendingTask?.cancel()
    }

    func loadState(for currentText: String) -> LoadState {
        let trimmed = currentText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .prompt }
        if isSearching { return .loading }
        if let loadError { return .error(loadError) }
        if results.isEmpty { return .noResults(searchedQuery) }
        return .loaded(results)
    }

    func queryChanged(_ text: String, client: OrbixClient, immediate: Bool = false) {
        pendingTask?.cancel()

        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            isSearching = false
            loadError = nil
            results = []
            searchedQuery = ""
            return
        }

        isSearching = true
        loadError = nil

        pendingTask = Task { [weak self] in
            if !immediate {
                do {
                    try await Task.sleep(nanoseconds: Self.debounceNanoseconds)
                } catch {
                    return
                }
            }
            guard let self, !Task.isCancelled else { return }
            await self.performSearch(query: trimmed, client: client)
        }
    }

    private func performSearch(query: String, client: OrbixClient) async {
        do {
            let items = try await client.search(query: query)
            guard !Task.isCancelled else { return }
            results = items
            searchedQuery = query
            remember(query: query)
            loadError = nil
        } catch {
            guard !Task.isCancelled else { return }
            loadError = "Couldn't search: \(error)"
            results = []
            searchedQuery = query
        }
        isSearching = false
    }

    private func remember(query: String) {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        var updated = recentQueries.filter { $0.caseInsensitiveCompare(trimmed) != .orderedSame }
        updated.insert(trimmed, at: 0)
        recentQueries = Array(updated.prefix(6))
        defaults.set(recentQueries, forKey: Self.recentQueriesKey)
    }
}

private struct SearchSuggestion: Equatable {
    let title: String
    let query: String
    var systemImage = "sparkle.magnifyingglass"

    var accessibilityKey: String {
        query
            .lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }
            .joined(separator: "-")
    }

    static let defaults: [SearchSuggestion] = [
        SearchSuggestion(title: "Comedies", query: "Comedy", systemImage: "face.smiling"),
        SearchSuggestion(title: "Sci-Fi", query: "Science Fiction", systemImage: "sparkles"),
        SearchSuggestion(title: "Mysteries", query: "Mystery", systemImage: "eye"),
        SearchSuggestion(title: "Something tense", query: "Thriller", systemImage: "bolt.fill"),
        SearchSuggestion(title: "Under 2 hours", query: "under 2 hours", systemImage: "clock"),
    ]
}

private struct FlowLayout: Layout {
    var spacing: CGFloat = 8
    var rowSpacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? 320
        let rows = Rows(maxWidth: maxWidth, subviews: subviews, spacing: spacing)
        return CGSize(width: maxWidth, height: rows.height(rowSpacing: rowSpacing))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let rows = Rows(maxWidth: bounds.width, subviews: subviews, spacing: spacing)
        var y = bounds.minY
        for (rowIndex, row) in rows.values.enumerated() {
            var x = bounds.minX
            for element in row {
                element.subview.place(
                    at: CGPoint(x: x, y: y),
                    proposal: ProposedViewSize(width: element.size.width, height: element.size.height)
                )
                x += element.size.width + spacing
            }
            y += row.map(\.size.height).max() ?? 0
            y += rowIndex == rows.values.count - 1 ? 0 : rowSpacing
        }
    }

    private struct Rows {
        struct Element: Equatable {
            let index: Int
            let size: CGSize
            let subview: LayoutSubview

            static func == (lhs: Element, rhs: Element) -> Bool {
                lhs.index == rhs.index
            }
        }

        var values: [[Element]] = []

        init(maxWidth: CGFloat, subviews: LayoutSubviews, spacing: CGFloat) {
            var currentRow: [Element] = []
            var currentWidth: CGFloat = 0

            for index in subviews.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                let nextWidth = currentRow.isEmpty ? size.width : currentWidth + spacing + size.width
                if nextWidth > maxWidth && !currentRow.isEmpty {
                    values.append(currentRow)
                    currentRow = []
                    currentWidth = 0
                }

                currentRow.append(Element(index: index, size: size, subview: subviews[index]))
                currentWidth = currentRow.count == 1 ? size.width : currentWidth + spacing + size.width
            }

            if !currentRow.isEmpty {
                values.append(currentRow)
            }
        }

        func height(rowSpacing: CGFloat) -> CGFloat {
            let rowHeights = values.map { row in row.map(\.size.height).max() ?? 0 }
            return rowHeights.reduce(0, +) + rowSpacing * CGFloat(max(0, rowHeights.count - 1))
        }
    }
}
