import OrbixKit
import SwiftUI

/// Phase 4 Task 6 — the TiviMate-style time×channel EPG grid, reached by
/// flipping `TvGuideView`'s List/Grid toggle to **Grid**. tvOS port of
/// `apps/web/src/components/tv/TvGuideGrid.tsx`.
///
/// ## Scroll / focus architecture (the load-bearing decision, spec §13)
///
/// The web scrolls **one 2D canvas** with a CSS-`sticky` time ruler + `sticky`
/// channel column and a fixed-pixel track whose blocks/ticks/now-line are all
/// window-relative percentages (never DOM-measured). CSS `position: sticky`
/// has **no clean equivalent under the tvOS focus engine**: focus *drives* the
/// scroll (there is no scroll offset to observe/counter-translate without the
/// "manual sticky-scroll offset math" the brief rules out), and a second
/// same-axis nested `ScrollView` (a vertical grid scroll inside this screen's
/// own page `ScrollView`) would create a vertical-on-vertical focus
/// scroll-capture conflict.
///
/// **Chosen structure — orthogonal, single shared horizontal offset:**
/// - The screen's existing page `ScrollView` (in `TvGuideView.content`) owns
///   the **vertical** axis — the grid adds **no** vertical `ScrollView`, so
///   there is no same-axis nesting. Focus moving row→row scrolls the page
///   exactly as it already does for the list.
/// - The grid wraps the ruler **and every channel row** in **one**
///   `ScrollView(.horizontal)`. Because all rows plus the ruler live in that
///   single horizontal scroll, they **share one horizontal offset for free**:
///   scrolling right on row 5 leaves the ruler and rows 1–4/6+ at the same
///   hour (the "rows share one horizontal offset (synced)" outcome the brief
///   calls out — achieved by construction, not by syncing N scroll views).
/// - Alignment is **guaranteed** rather than measured: the ruler's ticks and
///   each row's blocks are positioned against the *same* fixed `trackWidth`
///   from the *same* `channelColWidth` leading offset, inside the *same*
///   horizontal scroll coordinate space — so a tick at `leftPct` always sits
///   directly above a block at that percentage (the gate's spot-check).
///
/// **Documented tradeoff vs web:** the ruler is **not** pinned to the top and
/// the channel column is **not** pinned to the left — both scroll with the
/// canvas (the ruler vertically with the page, the channel column
/// horizontally with the track). Pinning either would require the same-axis
/// nested scroll / offset-observation this architecture deliberately avoids.
/// Mitigations: every row is a `.focusSection()` and the channel cell is the
/// row's **leading** focusable, so a Left press always returns to the channel
/// (scrolling the column back into view); the ruler sits at the very top of
/// the canvas. This is the accepted tvOS adaptation of a CSS-sticky grid —
/// the list remains the default guide view (spec §13 fallback stance).
///
/// ## Math wiring (all from `OrbixKit/TvGridLayout.swift`, the verified Task-2
/// port of `apps/web/src/lib/tv-grid-layout.ts`)
/// - Window: `HOURS = 4`, `start` floored to the hour; nav Now/Today →
///   `tvFloorToHour(now)`, Prev/Next → `tvShiftHours(start, ∓4)`, Tomorrow →
///   `tvPrimeTimeOnDay(offsetDays: 1, hour: 18)`.
/// - Ruler ticks: `tvGenerateTimeTicks(windowStartMs:windowMs:)` → each tick's
///   `leftPct` converted to points against `trackWidth`.
/// - Blocks: `tvComputeBlockRect(startISO:stopISO:windowStartMs:windowMs:)`
///   → `left`/`width` percentages converted to points; `width <= 0` skipped
///   (fully clipped by the window edge).
/// - Now-line: `tvNowLinePercent(windowStartMs:windowMs:atMs:)` → a 2pt
///   `OrbixColor.live` rule per row, `nil` when now is outside the window.
/// - Airing tint: a block is "on now" iff the shared `nowPct` snapshot falls
///   in `[rect.left, rect.left + rect.width)` — equivalent to the web's
///   `Date.parse(start) <= now < Date.parse(stop)` containment (both derive
///   from one `now` snapshot so the tint and the now-line always agree),
///   expressed purely in the percentages already computed so no additional
///   ISO parsing (`tvParseMs` is `internal` to OrbixKit) is needed.
struct TvGuideGridView: View {
    let model: AppModel
    let filter: GuideFilter
    let query: String
    /// Bridges the grid's (now/next-less) channels to the zap context and
    /// opens the live overlay — supplied by `TvGuideView`, mirroring web
    /// `handleGridTune` (`TvGuidePage.tsx:150-152`).
    let onTune: ([TvGridChannel], String) -> Void

    @State private var gridModel = TvGuideGridModel()
    @State private var imageLoader = ImageLoader()

    init(model: AppModel, filter: GuideFilter, query: String, onTune: @escaping ([TvGridChannel], String) -> Void) {
        self.model = model
        self.filter = filter
        self.query = query
        self.onTune = onTune
    }

    #if DEBUG
    /// Preview/snapshot init — injects a pre-seeded model so the real grid
    /// (nav row, ruler ticks, positioned blocks, airing tint, per-row now-line,
    /// channel-limit note) renders deterministically from synthetic EPG without
    /// a network round-trip. DEBUG-only.
    init(
        seeded: TvGuideGridModel,
        onTune: @escaping ([TvGridChannel], String) -> Void = { _, _ in }
    ) {
        self.model = AppModel()
        self.filter = .all
        self.query = ""
        self.onTune = onTune
        _gridModel = State(initialValue: seeded)
    }
    #endif

    // MARK: - Layout constants (web fixed-pixel widths ×~1.8-2.2 for 10-ft
    // viewing — brief figures: channel col ~360pt, per-hour ~520pt, row
    // ~100pt, ruler ~64pt).
    private static let hours = TvGuideGridModel.hours
    private static let channelColWidth: CGFloat = 360
    private static let hourWidth: CGFloat = 520
    private static var trackWidth: CGFloat { CGFloat(hours) * hourWidth } // 2080
    private static var totalWidth: CGFloat { channelColWidth + trackWidth } // 2440
    private static let rowHeight: CGFloat = 100
    private static let rulerHeight: CGFloat = 64
    /// Vertical inset (top+bottom) of a block within its row, and the trailing
    /// gap between adjacent blocks — web `top: 6, bottom: 6` + the visual
    /// break between neighbouring blocks.
    private static let blockVInset: CGFloat = 8
    private static let blockGap: CGFloat = 4

    private static let windowMs = Double(hours) * 3_600_000

    var body: some View {
        content
            // Loads on every switch-to-grid (the view is created fresh each
            // toggle, same as web's `{view === "grid" && …}` remount);
            // `.onChange` below covers filter/query edits while the grid stays
            // visible. The client gate lives here (and on each action) rather
            // than around the whole body, so a pre-seeded model can render its
            // blocks/ticks/now-line without a live client (previews/snapshots).
            .task {
                guard let client = model.client else { return }
                await gridModel.load(client: client, filter: filter, query: query)
            }
            .onChange(of: filter) { _, newValue in
                guard let client = model.client else { return }
                gridModel.filterChanged(to: newValue, query: query, client: client)
            }
            .onChange(of: query) { _, newValue in
                guard let client = model.client else { return }
                gridModel.queryChanged(newValue, filter: filter, client: client)
            }
    }

    // MARK: - Content

    private var content: some View {
        VStack(alignment: .leading, spacing: 20) {
            navRow
            gridBody
        }
    }

    // MARK: - Nav row (Now / Prev / window label / Next / Today / Tomorrow)

    private var navRow: some View {
        HStack(spacing: 16) {
            navButton(label: L10n.t("tv.grid.now"), id: "tvGridNav_now") {
                guard let client = model.client else { return }
                gridModel.showNow(client: client, filter: filter, query: query)
            }
            navIconButton(system: "chevron.left", label: L10n.t("tv.grid.prev"), id: "tvGridNav_prev") {
                guard let client = model.client else { return }
                gridModel.showPrev(client: client, filter: filter, query: query)
            }
            Text(windowLabel)
                .font(.callout.monospacedDigit())
                .foregroundStyle(OrbixColor.textDim)
                .frame(minWidth: 340)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("tvGridWindowLabel")
            navIconButton(system: "chevron.right", label: L10n.t("tv.grid.next"), id: "tvGridNav_next") {
                guard let client = model.client else { return }
                gridModel.showNext(client: client, filter: filter, query: query)
            }
            Spacer(minLength: 24)
            navButton(label: L10n.t("tv.grid.today"), id: "tvGridNav_today") {
                guard let client = model.client else { return }
                gridModel.showNow(client: client, filter: filter, query: query)
            }
            navButton(label: L10n.t("tv.grid.tomorrow"), id: "tvGridNav_tomorrow") {
                guard let client = model.client else { return }
                gridModel.showTomorrow(client: client, filter: filter, query: query)
            }
        }
        // Own focus section so left/right steps between nav controls instead
        // of escaping to the chips above or the grid below (same convention as
        // `TvGuideView.filterChipsRow`). Deliberately **no** container-level
        // `.accessibilityIdentifier` — a plain `HStack`'s identifier cascades
        // onto its static `Button` children and overwrites their own
        // `tvGridNav_*` ids (the exact defect fixed in Phase 4 Task 5's
        // `viewToggle`).
        .focusSection()
    }

    private func navButton(label: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label).font(.system(size: 22, weight: .regular))
        }
        .buttonStyle(GridNavButtonStyle())
        .accessibilityIdentifier(id)
    }

    private func navIconButton(system: String, label: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: system).font(.system(size: 22, weight: .semibold))
        }
        .buttonStyle(GridNavButtonStyle())
        .accessibilityIdentifier(id)
        .accessibilityLabel(label)
    }

    /// Web label: `start.toLocaleDateString({weekday, day, month}) · HH:MM–HH:MM`.
    private var windowLabel: String {
        let start = gridModel.start
        // NOTE: `windowMs` lives in the layout math's millisecond domain;
        // `addingTimeInterval` takes SECONDS. Feeding it ms pushed the label's
        // end ~166 days out (16 h off in time-of-day — "9:00 PM–1:00 PM").
        let end = start.addingTimeInterval(Double(Self.hours) * 3_600)
        let date = Self.dateFormatter.string(from: start)
        let from = Self.timeFormatter.string(from: start)
        let to = Self.timeFormatter.string(from: end)
        return "\(date) · \(from)–\(to)"
    }

    // MARK: - Grid body (loadState machine)

    @ViewBuilder
    private var gridBody: some View {
        switch gridModel.loadState {
        case .loading:
            HStack { Spacer(); ProgressView(); Spacer() }
                .padding(.top, 60)
                .accessibilityIdentifier("tvGuideGridLoadingState")
        case .error(let message):
            ContentUnavailableView {
                Label(L10n.t("tv.grid.errorTitle"), systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button(L10n.t("common.actions.retry")) {
                    guard let client = model.client else { return }
                    Task { await gridModel.load(client: client, filter: filter, query: query) }
                }
                .accessibilityIdentifier("tvGuideGridRetryButton")
            }
            .padding(.top, 60)
            .accessibilityIdentifier("tvGuideGridErrorState")
        case .empty:
            ContentUnavailableView {
                Label(L10n.t("tv.guidePage.empty"), systemImage: "square.grid.3x3")
            } description: {
                Text(L10n.t("tv.guidePage.emptyHint"))
            }
            .padding(.top, 60)
            .accessibilityIdentifier("tvGuideGridEmptyState")
        case .loaded(let channels):
            loadedGrid(channels)
        }
    }

    // MARK: - Loaded grid (ruler + rows in one horizontal scroll + footer)

    @ViewBuilder
    private func loadedGrid(_ channels: [TvGridChannel]) -> some View {
        // One shared snapshot for the whole render so every airing tint and
        // the now-line agree (web's single `nowMs`/`nowPct` snapshot).
        let windowStartMs = gridModel.start.timeIntervalSince1970 * 1000
        let nowMs = Date().timeIntervalSince1970 * 1000
        let nowPct = tvNowLinePercent(windowStartMs: windowStartMs, windowMs: Self.windowMs, atMs: nowMs)
        let ticks = tvGenerateTimeTicks(windowStartMs: windowStartMs, windowMs: Self.windowMs)
        let gridHeight = Self.rulerHeight + CGFloat(channels.count) * Self.rowHeight

        VStack(alignment: .leading, spacing: 12) {
            // One horizontal `ScrollView` holds the ruler + every row, so they
            // share its single horizontal offset (see the type doc comment).
            // The page owns the vertical axis — no vertical `ScrollView` here.
            // Rows render EAGERLY: laziness binds to the nearest enclosing
            // ScrollView (the horizontal one, which never clips vertically),
            // so vertical virtualization is deliberately traded away — safe
            // because the response is hard-capped at `channelLimit` (80) rows.
            ScrollView(.horizontal, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    ruler(ticks)
                    // `tvGuideGrid` lives on the rows container (which holds a
                    // `ForEach`, whose children keep their own ids — the
                    // Task-5-verified safe placement, unlike a plain-container
                    // id) so it never clobbers a block/nav id.
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(channels, id: \.id) { channel in
                            gridRow(channel, windowStartMs: windowStartMs, nowPct: nowPct)
                        }
                    }
                    .accessibilityIdentifier("tvGuideGrid")
                }
                .frame(width: Self.totalWidth, alignment: .leading)
            }
            .frame(height: gridHeight)

            // Channel-limit note (web lines 279-283) — the web string verbatim
            // ("Showing {{shown}} of {{total}} — narrow the filter", the actual
            // `tv:grid.showingOf` source, which the brief's prose paraphrased;
            // ported as-is, matching Task 5's search-placeholder precedent).
            if gridModel.total > channels.count {
                Text(L10n.t("tv.grid.showingOf", channels.count, gridModel.total))
                    .font(.callout)
                    .foregroundStyle(OrbixColor.textDim)
                    .accessibilityIdentifier("tvGuideGridLimitNote")
            }
        }
    }

    // MARK: - Ruler (corner spacer + time ticks)

    private func ruler(_ ticks: [TvTimeTick]) -> some View {
        HStack(spacing: 0) {
            Color.clear.frame(width: Self.channelColWidth, height: Self.rulerHeight)
            ZStack(alignment: .topLeading) {
                Color.clear.frame(width: Self.trackWidth, height: Self.rulerHeight)
                ForEach(ticks, id: \.ms) { tick in
                    HStack(spacing: 6) {
                        Rectangle()
                            .fill(OrbixColor.surface2)
                            .frame(width: 1, height: Self.rulerHeight)
                        Text(Self.timeFormatter.string(from: Date(timeIntervalSince1970: tick.ms / 1000)))
                            .font(.system(size: 20).monospacedDigit())
                            .foregroundStyle(OrbixColor.textDim)
                        Spacer(minLength: 0)
                    }
                    .frame(width: Self.hourWidth, alignment: .leading)
                    .offset(x: CGFloat(tick.leftPct / 100) * Self.trackWidth)
                }
            }
            .frame(width: Self.trackWidth, height: Self.rulerHeight, alignment: .topLeading)
            .clipped()
        }
        .frame(height: Self.rulerHeight)
        .overlay(alignment: .bottom) {
            Rectangle().fill(OrbixColor.surface2).frame(height: 1)
        }
    }

    // MARK: - Row (channel cell + time track)

    private func gridRow(_ channel: TvGridChannel, windowStartMs: Double, nowPct: Double?) -> some View {
        HStack(spacing: 0) {
            channelCell(channel)
            track(channel, windowStartMs: windowStartMs, nowPct: nowPct)
        }
        .frame(width: Self.totalWidth, height: Self.rowHeight)
        .overlay(alignment: .bottom) {
            Rectangle().fill(OrbixColor.surface2).frame(height: 1)
        }
        // Each row is its own focus section so up/down hands off cleanly
        // row→row while left/right stays within the row (channel cell ↔
        // blocks). No container `tvGridRow_*` id here — see `channelCell`.
        .focusSection()
    }

    /// The channel column cell — focusable, Select tunes. Carries the row's
    /// `tvGridRow_*` identifier (a real leaf `Button`, so no cascade), the
    /// closest analog to the list's whole-row tune Button.
    private func channelCell(_ channel: TvGridChannel) -> some View {
        Button {
            onTune(gridModel.channels, channel.id)
        } label: {
            HStack(spacing: 12) {
                Text("\(channel.number)")
                    .font(.callout.monospacedDigit())
                    .foregroundStyle(OrbixColor.textDim)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .frame(width: 52, alignment: .trailing)
                ChannelLogoView(
                    logo: channel.logo,
                    name: channel.name,
                    channelId: channel.id,
                    baseURL: model.baseURL,
                    imageLoader: imageLoader
                )
                .frame(width: 72, height: 44)
                .background(OrbixColor.surface)
                .clipShape(RoundedRectangle(cornerRadius: OrbixRadius.chip, style: .continuous))
                Text(channel.name)
                    .font(.callout.weight(.medium))
                    .foregroundStyle(OrbixColor.text)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .frame(width: Self.channelColWidth, height: Self.rowHeight, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(GridCellStyle())
        .accessibilityIdentifier("tvGridRow_\(channel.id)")
        .accessibilityLabel(L10n.t("tv.guidePage.play", channel.name))
    }

    @ViewBuilder
    private func track(_ channel: TvGridChannel, windowStartMs: Double, nowPct: Double?) -> some View {
        ZStack(alignment: .topLeading) {
            Color.clear.frame(width: Self.trackWidth, height: Self.rowHeight)

            if channel.programmes.isEmpty {
                // Web `tv:guidePage.noEpg` across an empty row's track.
                Text(L10n.t("tv.guidePage.noEpg"))
                    .font(.callout)
                    .foregroundStyle(OrbixColor.textDim)
                    .padding(.horizontal, 16)
                    .frame(width: Self.trackWidth, height: Self.rowHeight, alignment: .leading)
            } else {
                ForEach(channel.programmes, id: \.id) { p in
                    let rect = tvComputeBlockRect(
                        startISO: p.start,
                        stopISO: p.stop,
                        windowStartMs: windowStartMs,
                        windowMs: Self.windowMs
                    )
                    if rect.width > 0 {
                        block(p, rect: rect, channel: channel, nowPct: nowPct)
                    }
                }
            }

            // Per-row now-line, drawn last so it paints above the blocks. Every
            // row draws its 2pt segment at the same x, so together they read as
            // one continuous vertical rule (web's per-row now-line rationale).
            if let nowPct {
                Rectangle()
                    .fill(OrbixColor.live)
                    .frame(width: 2, height: Self.rowHeight)
                    .offset(x: CGFloat(nowPct / 100) * Self.trackWidth)
                    .allowsHitTesting(false)
            }
        }
        .frame(width: Self.trackWidth, height: Self.rowHeight, alignment: .topLeading)
    }

    private func block(_ p: TvGridProgramme, rect: TvBlockRect, channel: TvGridChannel, nowPct: Double?) -> some View {
        let x = CGFloat(rect.left / 100) * Self.trackWidth
        let w = max(2, CGFloat(rect.width / 100) * Self.trackWidth - Self.blockGap)
        // "On now" iff the shared now snapshot falls inside this block's
        // window-relative span — equivalent to web's timestamp containment.
        let airing = nowPct.map { rect.left <= $0 && $0 < rect.left + rect.width } ?? false

        return Button {
            onTune(gridModel.channels, channel.id)
        } label: {
            Text(p.title)
                .font(.callout)
                .foregroundStyle(OrbixColor.text)
                .lineLimit(2)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .frame(width: w, height: Self.rowHeight - Self.blockVInset * 2, alignment: .topLeading)
                .contentShape(Rectangle())
        }
        .buttonStyle(GridBlockStyle(airing: airing))
        .offset(x: x, y: Self.blockVInset)
        .accessibilityIdentifier("tvGridBlock_\(p.id)")
        .accessibilityLabel(
            airing
                ? L10n.t("tv.grid.playProgrammeOnNow", p.title, channel.name)
                : L10n.t("tv.grid.playProgramme", p.title, channel.name)
        )
    }

    // MARK: - Locale formatters

    /// Locale HH:MM (ruler ticks + window-label edges) — the `DateFormatter`
    /// analog of web `toLocaleTimeString({hour:"2-digit", minute:"2-digit"})`.
    /// Computed (not a cached `static let`) so it always reads the *current*
    /// `L10n.locale` rather than whatever was in effect at first access —
    /// see `ChannelNowNextView.displayFormatter`'s doc comment for why a
    /// `static let` would go stale across a profile language change.
    private static var timeFormatter: DateFormatter {
        let f = DateFormatter()
        f.locale = L10n.locale
        f.dateStyle = .none
        f.timeStyle = .short
        return f
    }

    /// Locale "weekday day month" (window label) — web
    /// `toLocaleDateString({weekday:"short", day:"numeric", month:"short"})`.
    /// Computed for the same reason as `timeFormatter` above.
    private static var dateFormatter: DateFormatter {
        let f = DateFormatter()
        f.locale = L10n.locale
        f.setLocalizedDateFormatFromTemplate("EEE d MMM")
        return f
    }
}

// MARK: - Button styles (own focus treatment, `.focusEffectDisabled()` — same
// precedent as `TvGuideView.GuideChipStyle`/`GuideRowStyle`).

/// Nav pill (Now/Prev/Next/Today/Tomorrow): focused = white fill + ring +
/// slight scale, matching the guide chips' focus language.
private struct GridNavButtonStyle: ButtonStyle {
    @Environment(\.isFocused) private var isFocused

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(isFocused ? Color.white : OrbixColor.textDim)
            .padding(.horizontal, 22)
            .padding(.vertical, 12)
            .background(isFocused ? Color.white.opacity(0.25) : OrbixColor.surface, in: Capsule())
            .overlay(Capsule().strokeBorder(OrbixColor.surface2, lineWidth: isFocused ? 0 : 1))
            .overlay(Capsule().strokeBorder(Color.white, lineWidth: isFocused ? 3 : 0))
            .scaleEffect(isFocused ? 1.06 : 1.0)
            .animation(.easeOut(duration: 0.15), value: isFocused)
            .focusEffectDisabled()
    }
}

/// The focusable channel-column cell: focus = surface highlight + subtle scale.
private struct GridCellStyle: ButtonStyle {
    @Environment(\.isFocused) private var isFocused

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(isFocused ? OrbixColor.surface2 : Color.clear)
            // A 4pt accent rule on the leading edge when focused (web's
            // `ring-inset ring-accent` on the sticky channel cell).
            .overlay(alignment: .leading) {
                Rectangle()
                    .fill(isFocused ? OrbixColor.accent : Color.clear)
                    .frame(width: 4)
            }
            .scaleEffect(isFocused ? 1.02 : 1.0)
            .animation(.easeOut(duration: 0.15), value: isFocused)
            .focusEffectDisabled()
    }
}

/// A programme block: base `surface2`; airing = `accent.opacity(0.2)`; focused
/// = brighter fill + white ring + scale (web base/`accent/20`/hover+ring).
private struct GridBlockStyle: ButtonStyle {
    let airing: Bool
    @Environment(\.isFocused) private var isFocused

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(background, in: RoundedRectangle(cornerRadius: OrbixRadius.chip, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: OrbixRadius.chip, style: .continuous)
                    .strokeBorder(Color.white, lineWidth: isFocused ? 3 : 0)
            )
            .scaleEffect(isFocused ? 1.04 : 1.0)
            .animation(.easeOut(duration: 0.15), value: isFocused)
            .focusEffectDisabled()
    }

    private var background: Color {
        if isFocused { return Color.white.opacity(0.22) }
        if airing { return OrbixColor.accent.opacity(0.2) }
        return OrbixColor.surface2
    }
}

// MARK: - Model

/// Drives `TvGuideGridView`: the bounded 4-hour EPG window (`GET /api/tv/grid`),
/// window nav (`start`), and a single `loadState` mirroring `TvGuideModel`.
///
/// Unlike `TvGuideModel` there is **no** pagination — the grid loads one
/// generous page (`channelLimit`) per (window, filter, query) and shows a
/// "narrow the filter" note past it (web `CHANNEL_LIMIT`/`showingOf`). So this
/// model keeps only the **reset** half of `TvGuideModel`'s machinery: the
/// FIXED cancel-previous (`pendingTask`), bump-generation (`requestId`), and
/// `defer`-flag idioms — every reload (initial, filter, query, or a window-nav
/// button) is a full reset. A response whose generation is stale (a newer
/// reset fired while it was in flight) is discarded rather than clobbering
/// fresher state; `isLoading` is cleared in a `defer` only by the *current*
/// generation's completion (the asymmetric guard from `TvGuideModel` that
/// avoids flickering the skeleton off while a newer load is still in flight).
@MainActor
@Observable
final class TvGuideGridModel {
    enum LoadState: Equatable {
        case loading
        case error(String)
        case empty
        case loaded([TvGridChannel])
    }

    static let hours = 4
    /// Web `CHANNEL_LIMIT` (`TvGuideGrid.tsx:31`): one generous page, then a
    /// "narrow the filter" note instead of silent truncation.
    static let channelLimit = 80
    /// Web `TOMORROW_HOUR` (`TvGuideGrid.tsx:26`): Tomorrow opens on prime time.
    static let primeHour = 18
    /// Same debounce as `TvGuideModel`/`SearchModel` (300ms).
    private static let debounceNanoseconds: UInt64 = 300_000_000

    private(set) var start: Date = tvFloorToHour(Date())
    private(set) var channels: [TvGridChannel] = []
    private(set) var total = 0
    private(set) var isLoading = false
    private(set) var loadError: String?
    private(set) var hasLoaded = false

    /// Bumped on every reset; a fetch stamped with a superseded generation is
    /// discarded on completion.
    private var requestId = 0
    private nonisolated(unsafe) var pendingTask: Task<Void, Never>?

    /// ISO-8601 (`…Z`, no fractional seconds) for the `?start=` param — the
    /// route parses it with `new Date(...)`. Server-side timestamps come back
    /// fractional; the layout math parses either shape (`tvParseMs`).
    private static let isoFormatter = ISO8601DateFormatter()

    init() {}

    #if DEBUG
    /// Preview/snapshot seed — bypasses the network so `#Preview` and
    /// deterministic view-render checks can exercise the real block/tick/
    /// now-line layout with synthetic EPG (the live NAS catalog currently
    /// carries no programme data). DEBUG-only, never in a release build.
    init(seedStart: Date, seedChannels: [TvGridChannel], seedTotal: Int) {
        self.start = seedStart
        self.channels = seedChannels
        self.total = seedTotal
        self.hasLoaded = true
    }
    #endif

    deinit { pendingTask?.cancel() }

    var loadState: LoadState {
        guard channels.isEmpty else { return .loaded(channels) }
        if isLoading || !hasLoaded { return .loading }
        if let loadError { return .error(loadError) }
        return .empty
    }

    // MARK: Reset / nav

    /// Initial load + Retry: fetches immediately (no debounce) and joins the
    /// task so an `await`ing caller sees the settled state.
    func load(client: OrbixClient, filter: GuideFilter, query: String) async {
        let task = restartLoad(client: client, filter: filter, query: query, debounceNs: nil)
        await task.value
    }

    /// `.onChange(of: filter)` — a discrete chip press; skips the debounce but
    /// goes through the same cancel-previous mechanism.
    func filterChanged(to filter: GuideFilter, query: String, client: OrbixClient) {
        restartLoad(client: client, filter: filter, query: query, debounceNs: nil)
    }

    /// `.onChange(of: query)` — debounced (typed text) reset.
    func queryChanged(_ text: String, filter: GuideFilter, client: OrbixClient) {
        restartLoad(client: client, filter: filter, query: text, debounceNs: Self.debounceNanoseconds)
    }

    /// Now / Today — both anchor on "now, floored to the hour" (web: Today ==
    /// Now, see `TvGuideGrid.tsx`'s TOMORROW_HOUR comment).
    func showNow(client: OrbixClient, filter: GuideFilter, query: String) {
        setWindow(tvFloorToHour(Date()), client: client, filter: filter, query: query)
    }

    func showPrev(client: OrbixClient, filter: GuideFilter, query: String) {
        setWindow(tvShiftHours(start, -Self.hours), client: client, filter: filter, query: query)
    }

    func showNext(client: OrbixClient, filter: GuideFilter, query: String) {
        setWindow(tvShiftHours(start, Self.hours), client: client, filter: filter, query: query)
    }

    func showTomorrow(client: OrbixClient, filter: GuideFilter, query: String) {
        setWindow(tvPrimeTimeOnDay(offsetDays: 1, hour: Self.primeHour), client: client, filter: filter, query: query)
    }

    private func setWindow(_ newStart: Date, client: OrbixClient, filter: GuideFilter, query: String) {
        start = newStart
        restartLoad(client: client, filter: filter, query: query, debounceNs: nil)
    }

    // MARK: Fetch plumbing (the FIXED cancel-previous + defer-flag idiom)

    @discardableResult
    private func restartLoad(
        client: OrbixClient,
        filter: GuideFilter,
        query: String,
        debounceNs: UInt64?
    ) -> Task<Void, Never> {
        pendingTask?.cancel()
        requestId += 1
        let id = requestId
        isLoading = true
        loadError = nil
        let task = Task { [weak self] in
            if let debounceNs {
                do { try await Task.sleep(nanoseconds: debounceNs) } catch { return }
            }
            guard let self, !Task.isCancelled else { return }
            await self.performLoad(client: client, filter: filter, query: query, requestId: id)
        }
        pendingTask = task
        return task
    }

    private func performLoad(client: OrbixClient, filter: GuideFilter, query: String, requestId id: Int) async {
        // `isLoading` cleared only by the current generation's completion (a
        // superseded load must not flick the skeleton off while a newer one is
        // still in flight); `hasLoaded` latches unconditionally.
        defer {
            if id == requestId { isLoading = false }
            hasLoaded = true
        }
        do {
            let response = try await fetch(client: client, filter: filter, query: query)
            guard id == requestId else { return }
            channels = response.channels
            total = response.total
            loadError = nil
        } catch {
            guard id == requestId else { return }
            if case OrbixError.http(_, let code) = error, let code {
                loadError = L10n.errorMessage(code)
            } else {
                loadError = L10n.t("errors.network")
            }
            channels = []
            total = 0
        }
    }

    private func fetch(client: OrbixClient, filter: GuideFilter, query: String) async throws -> TvGridResponse {
        let iso = Self.isoFormatter.string(from: start)
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let q = trimmed.isEmpty ? nil : trimmed
        switch filter {
        case .all:
            return try await client.tvGrid(start: iso, hours: Self.hours, q: q, limit: Self.channelLimit)
        case .favorites:
            return try await client.tvGrid(start: iso, hours: Self.hours, favorites: true, q: q, limit: Self.channelLimit)
        case .country(let code):
            return try await client.tvGrid(start: iso, hours: Self.hours, country: code, q: q, limit: Self.channelLimit)
        case .category(let category):
            return try await client.tvGrid(start: iso, hours: Self.hours, category: category, q: q, limit: Self.channelLimit)
        }
    }
}

#if DEBUG
/// Synthetic EPG for previews/snapshots — `start` floored to the hour, and
/// each channel's programmes laid out across the window so one block straddles
/// "now" (airing → accent tint, under the red now-line).
enum TvGuideGridPreviewData {
    // Anchor the window so "now" lands at ~50% (start = now − 2h of the 4h
    // window), giving a clean mid-canvas airing block under the now-line for
    // the layout spot-check.
    static let start = Date().addingTimeInterval(-2 * 3600)

    static func channels() -> [TvGridChannel] {
        let iso = ISO8601DateFormatter()
        func at(_ minutes: Int) -> String { iso.string(from: start.addingTimeInterval(Double(minutes) * 60)) }
        // Minutes into the 4h (240 min) window. "The Big Show" (110→150) spans
        // the 120-min midpoint ≈ now → airing (accent-tinted, under the line).
        func progs(_ prefix: String) -> [TvGridProgramme] {
            [
                TvGridProgramme(id: "\(prefix)-a", title: "\(prefix): Sunrise Report", start: at(0), stop: at(60)),
                TvGridProgramme(id: "\(prefix)-b", title: "\(prefix): Morning Docs", start: at(60), stop: at(110)),
                TvGridProgramme(id: "\(prefix)-c", title: "\(prefix): The Big Show", start: at(110), stop: at(150)),
                TvGridProgramme(id: "\(prefix)-d", title: "\(prefix): Afternoon Film", start: at(150), stop: at(210)),
                TvGridProgramme(id: "\(prefix)-e", title: "\(prefix): Late News", start: at(210), stop: at(270)),
            ]
        }
        return [
            TvGridChannel(id: "bbc-one", number: 101, name: "BBC One HD", country: "GB",
                          categories: ["general"], quality: "1080p", logo: nil, healthy: true, favorite: false,
                          programmes: progs("BBC One")),
            TvGridChannel(id: "cnn", number: 202, name: "CNN International", country: "US",
                          categories: ["news"], quality: "720p", logo: nil, healthy: true, favorite: false,
                          programmes: progs("CNN")),
            TvGridChannel(id: "disco", number: 303, name: "Discovery Science", country: "US",
                          categories: ["science"], quality: "4K", logo: nil, healthy: false, favorite: false,
                          programmes: progs("Discovery")),
            TvGridChannel(id: "empty", number: 404, name: "No-EPG Channel", country: "US",
                          categories: ["general"], quality: nil, logo: nil, healthy: true, favorite: false,
                          programmes: []),
        ]
    }

    @MainActor
    static func model() -> TvGuideGridModel {
        TvGuideGridModel(seedStart: start, seedChannels: channels(), seedTotal: 13025)
    }
}

#Preview {
    NavigationStack {
        ScrollView {
            TvGuideGridView(seeded: TvGuideGridPreviewData.model())
                .padding(.horizontal, 64)
        }
    }
}
#endif
