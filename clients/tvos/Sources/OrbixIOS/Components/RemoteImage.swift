import OrbixKit
import SwiftUI
import UIKit

struct RemoteImage<Placeholder: View>: View {
    let url: URL?
    let imageLoader: ImageLoader
    @ViewBuilder var placeholder: () -> Placeholder

    @State private var uiImage: UIImage?

    var body: some View {
        ZStack {
            if let uiImage {
                Image(uiImage: uiImage)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } else {
                placeholder()
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

struct ImagePlaceholder: View {
    let systemName: String

    var body: some View {
        ZStack {
            Rectangle().fill(.white.opacity(0.09))
            Image(systemName: systemName)
                .font(.title2)
                .foregroundStyle(.secondary)
        }
    }
}

struct ResumeProgressBar: View {
    let fraction: Double

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Rectangle().fill(.white.opacity(0.28))
                Rectangle()
                    .fill(.red)
                    .frame(width: geometry.size.width * min(1, max(0, fraction)))
            }
        }
        .frame(height: 4)
    }
}
