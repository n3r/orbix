import AVFoundation
import AVKit
import SwiftUI

/// `UIViewControllerRepresentable` wrapping a stock `AVPlayerViewController`.
///
/// SP2 M1's central bet: the platform's own AVPlayer/AVPlayerViewController
/// stack — not a custom player UI — can drive HLS playback against Orbix's
/// `playbackInfo` responses, with native subtitle/audio pickers sourced for
/// free from the in-manifest renditions the server embeds
/// (`subtitleDelivery: "hls"` in `Capabilities.appleTV`). This view is
/// intentionally a thin wrapper: it neither constructs the `AVPlayer` nor
/// starts playback — see `SpikeListView.select(_:)` for that — it only
/// presents whatever player it's given.
struct PlayerViewController: UIViewControllerRepresentable {
    let player: AVPlayer

    /// Shown via `AVPlayerItem.externalMetadata` so tvOS's transport/info UI
    /// displays a real title instead of the raw stream URL. Nice-to-have
    /// per the brief — not load-bearing for the M1 gate.
    var videoTitle: String?

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let controller = AVPlayerViewController()
        controller.player = player
        applyExternalMetadata()
        return controller
    }

    func updateUIViewController(_ uiViewController: AVPlayerViewController, context: Context) {
        if uiViewController.player !== player {
            uiViewController.player = player
        }
        applyExternalMetadata()
    }

    private func applyExternalMetadata() {
        guard let videoTitle, let item = player.currentItem else { return }
        let titleItem = AVMutableMetadataItem()
        titleItem.identifier = .commonIdentifierTitle
        titleItem.extendedLanguageTag = "und"
        titleItem.value = videoTitle as NSString
        item.externalMetadata = [titleItem]
    }
}
