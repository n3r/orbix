import OrbixKit
import SwiftUI

/// A circular profile/channel avatar: the remote image if `imageURL` is set
/// and loads, otherwise a hue-hashed monogram — port of the web `Avatar`
/// (packages/ui/src/components/Avatar.tsx) generalized with the more robust
/// hue-hash tile from `ChannelLogo`/`tv.ts` (`channelHue`/`channelInitials`,
/// ported to OrbixKit as `avatarHue`/`avatarInitials` — see AvatarHue.swift).
///
/// Deliberately does *not* thread the shared `ImageLoader` actor through
/// (unlike `PosterCard`/`ProfilePickerView`'s `RemoteAvatarImage`, which
/// share it for memory/disk caching across a whole poster grid): the
/// `/api/images/...` route this URL points at is public/unauthenticated
/// (see `ImageLoader.swift`'s own doc comment), and an avatar is one small
/// image per view, not a scrolling grid, so `AsyncImage`'s built-in
/// per-URL cache is enough here — plain `AsyncImage` is the "trivially
/// clean" case the task brief calls for. Callers that want the shared
/// cache can still resolve `imageURL` from whatever cached path they have;
/// this view only renders it.
struct AvatarView: View {
    let name: String
    let imageURL: URL?
    let size: CGFloat

    var body: some View {
        Group {
            if let imageURL {
                AsyncImage(url: imageURL) { phase in
                    if let image = phase.image {
                        image
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                    } else {
                        initialsTile
                    }
                }
            } else {
                initialsTile
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityLabel(Text(name))
        .accessibilityAddTraits(.isImage)
    }

    private var initialsTile: some View {
        ZStack {
            Color(hue: avatarHue(name) / 360, saturation: 0.45, brightness: 0.55)
            Text(avatarInitials(name))
                .font(.system(size: size * 0.4, weight: .semibold))
                .foregroundStyle(.white)
        }
    }
}

#Preview {
    HStack(spacing: 24) {
        AvatarView(name: "Nikita Fedorov", imageURL: nil, size: 96)
        AvatarView(name: "kids", imageURL: nil, size: 96)
        AvatarView(name: "Alice", imageURL: nil, size: 96)
    }
    .padding(40)
    .background(OrbixColor.bg)
}
