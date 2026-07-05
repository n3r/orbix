import Foundation
import OrbixKit
@preconcurrency import TVServices

/// Principal class of the Top Shelf content extension (`NSExtensionPrincipalClass`
/// in `Info.plist`). Runs in a **separate process** from the app: it reads the
/// server `baseURL` the app published to the shared App Group and the device
/// token from the shared Keychain access group, fetches `/api/home/rows`, and
/// renders the profile's "Continue Watching" + "Recommended" rows above the app
/// icon on the Apple TV home screen.
///
/// Every failure mode returns `nil` so tvOS falls back to the static Top Shelf
/// image rather than an error: not onboarded (no `baseURL`), not paired (no
/// token), offline (`homeRows` throws), or running on the Simulator — where the
/// App Group / Keychain entitlements are inert (the same limitation that stops
/// device tokens persisting in the Simulator; see `OrbixSharedStore` and the
/// tvOS README). The pure row→section mapping (`buildTopShelfContent`) lives in
/// OrbixKit and is unit-tested there; this class only bridges it to TVServices.
///
/// `@preconcurrency import TVServices`: the Obj-C completion-handler API predates
/// Swift 6 `Sendable` annotation, so this keeps the async bridge below free of
/// spurious strict-concurrency diagnostics without weakening the app's own code.
@objc(TopShelfContentProvider)
final class TopShelfContentProvider: TVTopShelfContentProvider {
    /// Wraps the Top Shelf completion handler so the async `Task` below can
    /// capture it under Swift 6 strict concurrency. Apple documents the
    /// handler as safe to call "on any queue" (see `TVTopShelfContentProvider.h`),
    /// which is exactly what `@unchecked Sendable` asserts here.
    private struct Completion: @unchecked Sendable {
        let call: ((any TVTopShelfContent)?) -> Void
    }

    override func loadTopShelfContent(completionHandler: @escaping ((any TVTopShelfContent)?) -> Void) {
        let completion = Completion(call: completionHandler)
        // The `Task` closure captures only the `Sendable` box; all the work —
        // including building the non-`Sendable` TVServices object graph and
        // calling the handler — happens inside `deliver`, a single main-actor
        // region, so nothing non-`Sendable` ever crosses a concurrency boundary.
        Task { @MainActor in await Self.deliver(to: completion) }
    }

    /// Runs the whole load on the main actor: fetches the pure (`Sendable`)
    /// content, bridges it to TVServices, and calls the completion handler.
    @MainActor
    private static func deliver(to completion: Completion) async {
        let content = await fetchContent()
        completion.call(content.flatMap { makeSectionedContent($0) })
    }

    /// The async, network-facing half: reads the shared `baseURL` + token and
    /// fetches `/api/home/rows`, returning the pure (`Sendable`) mapping — or
    /// `nil` for any missing prerequisite / failure.
    private static func fetchContent() async -> TopShelfContent? {
        guard let baseURL = OrbixSharedStore.loadBaseURL() else { return nil }

        let tokenStore = TokenStore(accessGroup: OrbixSharedStore.keychainAccessGroup)
        guard let token = await tokenStore.load() else { return nil }

        let client = OrbixClient(baseURL: baseURL)
        await client.setToken(token)

        guard let rows = try? await client.homeRows() else { return nil }
        return buildTopShelfContent(from: rows, baseURL: baseURL)
    }

    /// Bridges the pure `TopShelfContent` into the TVServices object graph.
    /// `nil` when there are no non-empty sections, so tvOS shows the static
    /// image instead of an empty shelf.
    private static func makeSectionedContent(_ content: TopShelfContent) -> TVTopShelfSectionedContent? {
        guard !content.sections.isEmpty else { return nil }

        let sections = content.sections.map { section -> TVTopShelfItemCollection<TVTopShelfSectionedItem> in
            let items = section.items.map { item -> TVTopShelfSectionedItem in
                let shelfItem = TVTopShelfSectionedItem(identifier: item.id)
                shelfItem.title = item.title
                shelfItem.imageShape = .poster
                if let posterURL = item.posterURL {
                    shelfItem.setImageURL(posterURL, for: [.screenScale1x, .screenScale2x])
                }
                if let progress = item.playbackProgress {
                    shelfItem.playbackProgress = progress
                }
                // Selecting the item (or pressing play on it) deep-links into
                // the app's title page — see `RootView`'s `.onOpenURL`.
                let action = TVTopShelfAction(url: item.displayURL)
                shelfItem.displayAction = action
                shelfItem.playAction = action
                return shelfItem
            }

            let collection = TVTopShelfItemCollection(items: items)
            collection.title = section.kind.localizedTitle
            return collection
        }

        return TVTopShelfSectionedContent(sections: sections)
    }
}
