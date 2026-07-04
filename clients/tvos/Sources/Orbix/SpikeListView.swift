import AVFoundation
import OrbixKit
import SwiftUI
import UIKit

/// SP2 M1 playback spike: loads the home rows, renders a focusable grid of
/// titles with posters, and on selection resolves a playable file + stream
/// URL and presents `PlayerViewController`. This is the UI half of the M1
/// gate — the automated half is `PlaybackReadinessTests` in
/// `OrbixKitTests`, which proves AVFoundation itself accepts the same kind
/// of `playbackInfo` response this view consumes.
struct SpikeListView: View {
    let model: AppModel

    @State private var homeRows: HomeRows?
    @State private var loadError: String?
    @State private var selectingId: String?
    @State private var selectionError: String?
    @State private var playback: PlaybackPresentation?
    @State private var imageLoader = ImageLoader()

    var body: some View {
        content
            .task { await loadHomeRows() }
            .fullScreenCover(item: $playback) { presentation in
                PlayerViewController(player: presentation.player, videoTitle: presentation.title)
                    .ignoresSafeArea()
                    .onDisappear { presentation.player.pause() }
            }
            .alert(
                "Playback error",
                isPresented: Binding(
                    get: { selectionError != nil },
                    set: { isPresented in if !isPresented { selectionError = nil } }
                ),
                actions: { Button("OK", role: .cancel) {} },
                message: { Text(selectionError ?? "") }
            )
    }

    @ViewBuilder
    private var content: some View {
        if let homeRows {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 48) {
                    ForEach(homeRows.rows, id: \.key) { row in
                        rowView(row)
                    }
                }
                .padding(.horizontal, 64)
                .padding(.vertical, 48)
            }
        } else if let loadError {
            ContentUnavailableView(
                "Couldn't load Orbix",
                systemImage: "exclamationmark.triangle",
                description: Text(loadError)
            )
        } else {
            ProgressView("Loading…")
        }
    }

    @ViewBuilder
    private func rowView(_ row: HomeRow) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(row.title)
                .font(.title3.bold())
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 32) {
                    ForEach(row.items, id: \.id) { card in
                        posterButton(card)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func posterButton(_ card: MediaCard) -> some View {
        Button {
            select(card)
        } label: {
            VStack(alignment: .leading, spacing: 10) {
                PosterImageView(url: posterURL(for: card), imageLoader: imageLoader)
                    .frame(width: 280, height: 158)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                // Title text is always shown under the poster, so a
                // missing/failed poster image still leaves the title
                // readable (the "title text fallback" from the brief).
                Text(card.title)
                    .font(.callout)
                    .lineLimit(1)
                    .frame(maxWidth: 280, alignment: .leading)
            }
        }
        .buttonStyle(.card)
        .disabled(selectingId == card.id)
    }

    private func posterURL(for card: MediaCard) -> URL? {
        guard let posterPath = card.posterPath, let baseURL = model.baseURL else { return nil }
        return baseURL.appending(path: "api/images/\(posterPath)")
    }

    private func loadHomeRows() async {
        guard let client = model.client else {
            loadError = "No client configured"
            return
        }
        do {
            homeRows = try await client.homeRows()
        } catch {
            loadError = "Failed to load titles: \(error)"
        }
    }

    /// Item detail → `files[0].id` → `playbackInfo` → resolve `streamUrl`
    /// against `baseURL` → present the player. The server embeds `&token=`
    /// into `streamUrl` (and echoes it into every playlist URI), so the
    /// resolved URL is used verbatim — no header/query rebuilding needed
    /// for `AVPlayer` to authenticate.
    private func select(_ card: MediaCard) {
        guard let client = model.client, let baseURL = model.baseURL else { return }
        guard selectingId == nil else { return }
        selectingId = card.id

        Task {
            defer { selectingId = nil }
            do {
                let fileIds = try await client.itemFileIds(id: card.id)
                guard let fileId = fileIds.first else {
                    selectionError = "\(card.title) has no playable file"
                    return
                }

                let info = try await client.playbackInfo(fileId: fileId, capabilities: .appleTV)
                guard let streamURL = URL(string: info.streamUrl, relativeTo: baseURL)?.absoluteURL else {
                    selectionError = "Couldn't resolve stream URL for \(card.title)"
                    return
                }

                let player = AVPlayer(url: streamURL)
                player.play()
                playback = PlaybackPresentation(player: player, title: card.title)
            } catch {
                selectionError = "Playback failed for \(card.title): \(error)"
            }
        }
    }
}

/// Wraps the constructed `AVPlayer` + title so `fullScreenCover(item:)` has
/// an `Identifiable` binding target — a fresh id per selection forces the
/// cover to present even if the same title is played twice in a row.
private struct PlaybackPresentation: Identifiable {
    let id = UUID()
    let player: AVPlayer
    let title: String
}

/// Poster art fetched via `ImageLoader` (memory + disk cache); falls back
/// to a placeholder glyph on a missing `posterPath` or a failed fetch.
private struct PosterImageView: View {
    let url: URL?
    let imageLoader: ImageLoader

    @State private var uiImage: UIImage?

    var body: some View {
        ZStack {
            Rectangle().fill(.secondary.opacity(0.2))
            if let uiImage {
                Image(uiImage: uiImage)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } else {
                Image(systemName: "film")
                    .font(.largeTitle)
                    .foregroundStyle(.secondary)
            }
        }
        .clipped()
        .task(id: url) {
            uiImage = nil
            guard let url else { return }
            if let data = await imageLoader.image(for: url) {
                uiImage = UIImage(data: data)
            }
        }
    }
}

#Preview {
    SpikeListView(model: AppModel())
}
