import OrbixKit
import SwiftUI

/// Full-screen live-TV cinema — tvOS port of `apps/web/src/components/tv/
/// LiveTvOverlay.tsx`, presented by a page via `.fullScreenCover(item:)` over
/// a `LivePlayContext`. Hosts `LiveTvPlayerView` plus the zap OSD (auto-hide
/// 4 s), the mini-guide drawer, the offline panel, and the tvOS remote
/// surface. Owns the `LiveTvController` (`@State`) and tunes `initialId` on
/// appear. Public API mirrors the web:
/// `LiveTvOverlay(channels:initialId:model:onClose:)`.
///
/// ## Remote mapping (web keyboard → tvOS remote)
///
/// ### OSD-gated focus arbitration (Phase 4 review fix)
/// The persistent control cluster (right edge) and the focusable player
/// surface both want the same directional presses, so which one wins is
/// gated on `osdVisible` — the same "show controls, then navigate them"
/// convention as tvOS's native video-player transport bar:
///
/// - **OSD hidden** (normal viewing): the surface is focusable and holds
///   focus; its `.onMoveCommand` intercepts all four directions (zap /
///   guide-toggle, below). Select shows the OSD.
/// - **OSD visible**: the surface is made **non-focusable**
///   (`surfaceFocusable` excludes `osdVisible`), so native tvOS spatial
///   navigation takes the arrow presses instead, moving focus around the
///   always-focusable control cluster (+ close button); Select activates
///   whichever control has focus. Focus is driven onto the cluster's first
///   button (`.chUp`) the instant the OSD appears while the surface held
///   focus (`onChange(of: osdVisible)`), and `.defaultFocus` picks the same
///   target for the OSD-visible-at-launch case.
///
///   **Why toggle `focusable` instead of gating the `.onMoveCommand` closure
///   body:** SwiftUI's `.onMoveCommand` fully intercepts a directional press
///   for whatever view currently holds focus — it does not defer to native
///   spatial navigation for that same press even when the closure body is a
///   no-op. This was confirmed empirically in the Phase 4 Task 4 live smoke:
///   the always-focusable cluster was still unreachable via swipe purely
///   because the surface held focus and had `.onMoveCommand` attached (see
///   `p4-task-4-report.md` §3e). The closure below keeps a defensive
///   `guard !osdVisible else { return }` for documentation/belt-and-braces,
///   but the real gate is `.focusable(surfaceFocusable)` dropping the
///   surface out of the focus chain entirely while the OSD is up.
///
///   When the OSD auto-hides (4 s) — and neither the mini-guide nor the
///   offline panel owns focus — focus returns to the surface
///   (`onChange(of: osdVisible)`'s `else` branch, guarded the same way the
///   existing `guideOpen`/`isOffline` focus handlers are), restoring
///   swipe-zap. Zapping from the cluster re-shows (and keeps alive) the OSD
///   via the existing tune-triggered `showOSD()`
///   (`onChange(of: controller.channelId)`), so repeated cluster taps don't
///   lose cluster focus mid-stream.
///
/// Two coexisting input paths mirror the web's keyboard + pointer-cluster:
///
/// - **Focusable player surface** (default focus while the OSD is hidden):
///   - Swipe **up** → `zap(-1)` (previous channel)   — web PageUp / Shift+↑
///   - Swipe **down** → `zap(+1)` (next channel)      — web PageDown / Shift+↓
///   - Swipe **left / right** → toggle the mini-guide — web `g`
///   - **Select** → re-show the OSD                    — web `i` (and `l`; there
///     is no custom live-edge catch-up in v1 per spec §7.10 — AVPlayer's live
///     defaults hold the window)
/// - **Persistent, always-focusable on-screen control cluster** (right edge),
///   reachable via native spatial navigation whenever the OSD is visible:
///   channel-up (`zap(-1)`) · guide (toggle) · channel-down (`zap(+1)`) ·
///   last-channel jump; plus a top-left **close**.
/// - **Mini-guide drawer**: native up/down focus moves between rows; **Select
///   tunes in place** (the drawer stays open); the current channel is
///   accent-tinted. Opening moves focus into the current row; closing returns
///   focus to the surface (or the offline Retry).
/// - **Menu (`onExitCommand`)**: closes the mini-guide first, else `onClose()`.
///   The handler lives **only on the overlay root** — safe here because the
///   overlay is a `.fullScreenCover` with no `NavigationStack` (Phase 3
///   lesson: any `onExitCommand` near a stack kills native pop).
struct LiveTvOverlay: View {
    let channels: [TvChannelCard]
    let initialId: String
    let model: AppModel
    let onClose: () -> Void

    @State private var controller: LiveTvController
    @State private var imageLoader = ImageLoader()
    @State private var osdVisible = true
    @State private var osdHideTask: Task<Void, Never>?
    @State private var guideOpen = false
    /// Previous channel id for the last-channel jump (web `prevIdRef`).
    @State private var prevChannelId: String?
    @FocusState private var focus: FocusTarget?

    private enum FocusTarget: Hashable {
        case surface
        case chUp, guide, chDown, last, close
        case offlineRetry, offlineNext
        case guideRow(String)
    }

    init(channels: [TvChannelCard], initialId: String, model: AppModel, onClose: @escaping () -> Void) {
        self.channels = channels
        self.initialId = initialId
        self.model = model
        self.onClose = onClose
        _controller = State(
            initialValue: LiveTvController(channelId: initialId, client: model.client, baseURL: model.baseURL)
        )
    }

    // MARK: - Derived state

    private var current: TvChannelCard? {
        channels.first { $0.id == controller.channelId } ?? channels.first
    }

    private var isOffline: Bool {
        if case .offline = controller.loadState { return true }
        return false
    }

    /// The surface only holds focus (and its move commands only fire) during
    /// normal playback with the OSD hidden — the offline panel and mini-guide
    /// own focus otherwise, and the OSD-visible control cluster owns it while
    /// the OSD is up (see the type doc comment's "OSD-gated focus
    /// arbitration" section).
    private var surfaceFocusable: Bool { !guideOpen && !isOffline && !osdVisible }

    // MARK: - Body

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if !isOffline, let url = controller.streamURL {
                LiveTvPlayerView(streamURL: url, generation: controller.playGeneration, controller: controller)
                    .ignoresSafeArea()
            }

            playerSurface

            if isOffline {
                offlinePanel
            }

            if let toast = controller.toast {
                toastView(toast)
            }

            if osdVisible {
                osdView
            }

            if guideOpen {
                miniGuide
            }

            controlCluster
            closeButton
        }
        // OSD-visible-at-launch picks the cluster's first button; hidden-at-launch
        // (not currently reachable, since `osdVisible` starts `true`) would pick
        // the surface. Kept dynamic rather than hardcoded to `.surface` so the
        // invariant ("OSD visible ⇒ default focus is the cluster") holds even if
        // that initial value ever changes.
        .defaultFocus($focus, osdVisible ? .chUp : .surface)
        .task { await controller.tune(to: initialId) }
        .onAppear { showOSD() }
        .onChange(of: controller.channelId) { _, _ in showOSD() }
        .onChange(of: isOffline) { _, offline in
            if offline { focus = .offlineRetry }
            else if !guideOpen { focus = osdVisible ? .chUp : .surface }
        }
        .onChange(of: guideOpen) { _, open in
            focus = open ? .guideRow(controller.channelId) : (isOffline ? .offlineRetry : (osdVisible ? .chUp : .surface))
        }
        .onChange(of: osdVisible) { _, visible in
            // The offline panel and mini-guide already own focus in their own
            // states (handled above) — don't fight them here.
            guard !guideOpen, !isOffline else { return }
            if visible {
                // OSD just appeared: if the surface was holding focus, hand it to
                // the cluster's first button so arrows navigate controls instead
                // of re-firing the surface's zap/guide-toggle `onMoveCommand`.
                if focus == .surface { focus = .chUp }
            } else {
                // OSD just auto-hid: return focus to the surface so swipe-zap
                // resumes, regardless of which control last held it.
                focus = .surface
            }
        }
        .onExitCommand {
            if guideOpen { guideOpen = false } else { onClose() }
        }
        .accessibilityIdentifier("liveTvOverlay")
    }

    // MARK: - Player surface (move/select gestures)

    private var playerSurface: some View {
        Color.clear
            .contentShape(Rectangle())
            .focusable(surfaceFocusable)
            .focused($focus, equals: .surface)
            .onMoveCommand { direction in
                // Defensive only: `surfaceFocusable` (which excludes `osdVisible`)
                // means the surface shouldn't hold focus — and thus shouldn't
                // receive this callback at all — whenever the OSD is visible. See
                // the type doc comment's "OSD-gated focus arbitration" section.
                guard !osdVisible else { return }
                switch direction {
                case .up: zap(-1)
                case .down: zap(1)
                case .left, .right: guideOpen.toggle()
                @unknown default: break
                }
            }
            .onTapGesture { showOSD() }
            .accessibilityIdentifier("livePlayerSurface")
    }

    // MARK: - Zap OSD

    @ViewBuilder
    private var osdView: some View {
        if let current {
            HStack(alignment: .top, spacing: 16) {
                Text("\(current.number)")
                    .font(.system(size: 40, weight: .bold).monospacedDigit())
                    .foregroundStyle(.white.opacity(0.8))

                ChannelLogoView(
                    logo: current.logo,
                    name: current.name,
                    channelId: current.id,
                    baseURL: model.baseURL,
                    imageLoader: imageLoader
                )
                .frame(width: 84, height: 60)
                .background(.white.opacity(0.1))
                .clipShape(RoundedRectangle(cornerRadius: OrbixRadius.sm))

                VStack(alignment: .leading, spacing: 6) {
                    Text(current.name)
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(.white)
                        .lineLimit(1)

                    HStack(spacing: 8) {
                        if let quality = current.quality {
                            QualityChip(label: quality)
                        }
                        if controller.sourceIndex > 0, let total = controller.play?.sources.count {
                            Text("Source \(controller.sourceIndex + 1)/\(total)")
                                .font(.caption)
                                .foregroundStyle(.white.opacity(0.6))
                        }
                    }

                    if let now = controller.play?.nowNext.now {
                        Text(now.title)
                            .font(.caption)
                            .foregroundStyle(.white.opacity(0.8))
                            .lineLimit(1)
                        NowProgressBar(fraction: tvNowProgressFraction(startISO: now.start, stopISO: now.stop))
                            .frame(maxWidth: 260)
                    }
                    if let next = controller.play?.nowNext.next {
                        Text("Next · \(next.title)")
                            .font(.caption2)
                            .foregroundStyle(.white.opacity(0.5))
                            .lineLimit(1)
                    }
                }
            }
            .padding(20)
            .frame(maxWidth: 640, alignment: .leading)
            .background(.black.opacity(0.7), in: RoundedRectangle(cornerRadius: OrbixRadius.md))
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding(.leading, 48)
            .padding(.top, 130)
            .allowsHitTesting(false) // OSD is informational (web pointer-events-none)
        }
    }

    private func toastView(_ text: String) -> some View {
        Text(text)
            .font(.callout)
            .foregroundStyle(.white)
            .padding(.horizontal, 20)
            .padding(.vertical, 10)
            .background(.black.opacity(0.7), in: Capsule())
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .padding(.top, 44)
            .allowsHitTesting(false)
    }

    // MARK: - Offline panel

    private var offlinePanel: some View {
        VStack(spacing: 24) {
            Text("Channel appears offline")
                .font(.title2.weight(.medium))
                .foregroundStyle(.white)
            HStack(spacing: 20) {
                Button("Retry") { controller.retry() }
                    .buttonStyle(OrbixButtonStyle(.primary))
                    .focused($focus, equals: .offlineRetry)
                    .accessibilityIdentifier("liveOfflineRetry")
                Button("Next channel") { zap(1) }
                    .buttonStyle(OrbixButtonStyle(.ghost))
                    .focused($focus, equals: .offlineNext)
                    .accessibilityIdentifier("liveOfflineNext")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Mini-guide drawer

    private var miniGuide: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 0) {
                Text("Channels")
                    .font(.caption.weight(.semibold))
                    .textCase(.uppercase)
                    .foregroundStyle(.white.opacity(0.5))
                    .padding(.horizontal, 24)
                    .padding(.top, 40)
                    .padding(.bottom, 12)

                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(channels, id: \.id) { channel in
                                miniGuideRow(channel).id(channel.id)
                            }
                        }
                    }
                    .onChange(of: focus) { _, newFocus in
                        if case .guideRow(let id) = newFocus {
                            withAnimation { proxy.scrollTo(id, anchor: .center) }
                        }
                    }
                }
            }
            .frame(width: 540)
            .frame(maxHeight: .infinity)
            .background(.black.opacity(0.9))

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .transition(.move(edge: .leading))
        .accessibilityIdentifier("liveMiniGuide")
    }

    private func miniGuideRow(_ channel: TvChannelCard) -> some View {
        Button { tune(to: channel.id) } label: {
            HStack(alignment: .top, spacing: 12) {
                Text("\(channel.number)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.white.opacity(0.5))
                    .frame(width: 44, alignment: .trailing)
                VStack(alignment: .leading, spacing: 4) {
                    Text(channel.name)
                        .font(.body)
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    ChannelNowNextView(now: channel.now, next: channel.next)
                }
                Spacer(minLength: 8)
                if let quality = channel.quality {
                    Text(quality)
                        .font(.caption2)
                        .foregroundStyle(.white.opacity(0.4))
                }
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(MiniGuideRowStyle(isCurrent: channel.id == controller.channelId))
        .focused($focus, equals: .guideRow(channel.id))
        .accessibilityIdentifier("guideRow_\(channel.id)")
    }

    // MARK: - Control cluster + close

    private var controlCluster: some View {
        VStack(spacing: 16) {
            clusterButton(systemName: "chevron.up", target: .chUp, id: "liveClusterChannelUp") { zap(-1) }
            clusterButton(systemName: "tv", target: .guide, id: "liveClusterGuide") { guideOpen.toggle() }
            clusterButton(systemName: "chevron.down", target: .chDown, id: "liveClusterChannelDown") { zap(1) }
            clusterButton(systemName: "arrow.uturn.backward", target: .last, id: "liveClusterLastChannel") { lastChannel() }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
        .padding(.trailing, 48)
    }

    private var closeButton: some View {
        Button(action: onClose) {
            Image(systemName: "xmark")
                .font(.system(size: 26, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 60, height: 60)
        }
        .buttonStyle(LiveControlButtonStyle())
        .focused($focus, equals: .close)
        .accessibilityLabel("Close player")
        .accessibilityIdentifier("liveCloseButton")
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(.leading, 48)
        .padding(.top, 44)
    }

    private func clusterButton(
        systemName: String,
        target: FocusTarget,
        id: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 64, height: 64)
        }
        .buttonStyle(LiveControlButtonStyle())
        .focused($focus, equals: target)
        .accessibilityIdentifier(id)
    }

    // MARK: - Actions

    /// Tune a channel, remembering the previous id for the last-channel jump.
    private func tune(to id: String) {
        if id != controller.channelId { prevChannelId = controller.channelId }
        Task { await controller.tune(to: id) }
    }

    /// Step through the passed channel list, wrapping (web `zap`, lines 82-90).
    private func zap(_ delta: Int) {
        guard !channels.isEmpty else { return }
        let idx = channels.firstIndex { $0.id == controller.channelId } ?? 0
        let count = channels.count
        let next = ((idx + delta) % count + count) % count
        tune(to: channels[next].id)
    }

    private func lastChannel() {
        guard let prev = prevChannelId else { return }
        tune(to: prev)
    }

    /// OSD: shown on mount and every tune (web `OSD_MS` = 4 s), auto-hides.
    private func showOSD() {
        osdVisible = true
        osdHideTask?.cancel()
        osdHideTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            if !Task.isCancelled { osdVisible = false }
        }
    }
}

// MARK: - Focus-treated button styles (own treatment, no system platter)

/// Circular translucent control (cluster + close). Follows the focus-platter
/// rule (`.focusEffectDisabled()` + own treatment, `BoxArtCardStyle`
/// precedent): a ring + scale on focus rather than tvOS's default platter.
private struct LiveControlButtonStyle: ButtonStyle {
    @Environment(\.isFocused) private var isFocused

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(Circle().fill(.black.opacity(isFocused ? 0.85 : 0.4)))
            .overlay(Circle().stroke(.white.opacity(isFocused ? 0.9 : 0), lineWidth: 3))
            .scaleEffect(isFocused ? 1.1 : 1.0)
            .animation(.easeOut(duration: 0.15), value: isFocused)
            .focusEffectDisabled()
    }
}

/// Mini-guide row: accent-tint the current channel, accent ring on focus
/// (own treatment, no system platter — same precedent as above).
private struct MiniGuideRowStyle: ButtonStyle {
    let isCurrent: Bool
    @Environment(\.isFocused) private var isFocused

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(background)
            .overlay(
                RoundedRectangle(cornerRadius: OrbixRadius.sm, style: .continuous)
                    .stroke(OrbixColor.accent, lineWidth: isFocused ? 4 : 0)
            )
            .clipShape(RoundedRectangle(cornerRadius: OrbixRadius.sm, style: .continuous))
            .animation(.easeOut(duration: 0.15), value: isFocused)
            .focusEffectDisabled()
    }

    @ViewBuilder
    private var background: some View {
        if isFocused {
            OrbixColor.accent.opacity(0.25)
        } else if isCurrent {
            OrbixColor.accent.opacity(0.2)
        } else {
            Color.clear
        }
    }
}

/// Identifiable presentation context for `.fullScreenCover(item:)` — the exact
/// channel list the opener was showing (zap context) + the initial channel.
/// `id` is a fresh `UUID` per instance so re-presenting always starts a brand-
/// new overlay/controller (same convention as the VOD `PlaybackTarget`s).
struct LivePlayContext: Identifiable {
    let id = UUID()
    let channels: [TvChannelCard]
    let initialId: String
}

#Preview("Live overlay (nil-client → offline panel)") {
    let sample: [TvChannelCard] = [
        TvChannelCard(
            id: "bbc-one", number: 101, name: "BBC One HD", country: "GB",
            categories: ["general"], quality: "HD", logo: nil, healthy: true, favorite: false,
            now: TvProgrammeSlot(
                title: "The Ten O'Clock News",
                start: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-600)),
                stop: ISO8601DateFormatter().string(from: Date().addingTimeInterval(1200))
            ),
            next: TvProgrammeSlot(
                title: "Match of the Day",
                start: ISO8601DateFormatter().string(from: Date().addingTimeInterval(1200)),
                stop: ISO8601DateFormatter().string(from: Date().addingTimeInterval(4800))
            )
        ),
        TvChannelCard(
            id: "cnn", number: 202, name: "CNN International", country: "US",
            categories: ["news"], quality: "HD", logo: nil, healthy: true, favorite: false
        ),
        TvChannelCard(
            id: "disco", number: 303, name: "Discovery Science", country: "US",
            categories: ["science"], quality: "4K", logo: nil, healthy: false, favorite: false
        ),
    ]
    return LiveTvOverlay(channels: sample, initialId: "bbc-one", model: AppModel(), onClose: {})
}
