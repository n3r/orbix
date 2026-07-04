import SwiftUI

struct RootView: View {
    var body: some View {
        VStack(spacing: 24) {
            Text("Orbix")
                .font(.system(size: 96, weight: .bold))
            Text("tvOS client — scaffold")
                .font(.title2)
                .foregroundStyle(.secondary)
        }
    }
}
