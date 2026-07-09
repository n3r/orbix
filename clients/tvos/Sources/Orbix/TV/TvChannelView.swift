import OrbixKit
import SwiftUI

/// Phase 4 Task 7 TV Channel detail page, reached by pushing `TvChannelRoute`
/// from a guide list row's info action (`TvGuideView.row`'s `.contextMenu`,
/// which already pushes this route as of Task 5) onto the shared TV
/// `NavigationStack` — see `TvHomeView`'s
/// `.navigationDestination(for: TvChannelRoute.self)`, which now renders this
/// view instead of the Task-7 bridge placeholder. tvOS port of
/// `apps/web/src/pages/TvChannelPage.tsx`.
///
/// Renders: a hero (large `ChannelLogoView`, "Channel N", name, a badge row —
/// `QualityChip`, region (`tvRegionName`), each category capitalized, an
/// "● Offline" dot when unhealthy — plus an optimistic favorite heart), a
/// **Watch** button (opens `LiveTvOverlay` with this channel alone as the zap
/// context), and a Today/Tomorrow day schedule with the currently-airing
/// programme highlighted "ON NOW".
///
/// Pushed destination — no `NavigationStack`/`path` of its own (`TitlePage`'s
/// convention; unlike `TitlePage` this page never pushes further routes, so
/// it doesn't need a `path` binding at all).
struct TvChannelView: View {
    let channelId: String
    let model: AppModel

    @State private var channelModel = TvChannelModel()
    @State private var imageLoader = ImageLoader()
    /// The schedule's `?day=` offset — 0 = Today, 1 = Tomorrow (web
    /// `dayOffset`); converted to the wire day string via `tvDayString`.
    @State private var dayOffset = 0
    /// Drives the `.fullScreenCover` live-TV cinema — `nil` when closed.
    @State private var liveContext: LivePlayContext?

    init(channelId: String, model: AppModel) {
        self.channelId = channelId
        self.model = model
    }

    #if DEBUG
    /// Preview/snapshot init — injects a pre-seeded model so the real hero
    /// and schedule (including the ON-NOW highlight) render deterministically
    /// from synthetic data, without a network round-trip. DEBUG-only.
    ///
    /// `model` defaults to a bare, unconfigured `AppModel()` for a plain
    /// `#Preview` (where `body`'s `ProgressView()` fallback — `model.client
    /// == nil` — is an acceptable static preview). A caller that actually
    /// needs `content(client:)` to render (e.g. an `ImageRenderer` snapshot
    /// test capturing the loaded hero/schedule) must instead pass a `model`
    /// whose `client` is already non-nil (`AppModel.configure(baseURLString:)`
    /// against any URL — even an unreachable one sets `client` synchronously
    /// before its reachability check's `Task` starts, and this view's own
    /// `.task`/`.task(id:)` network calls racing against that unreachable
    /// host can only ever overwrite the seed *after* the fact, never before
    /// a render that happens immediately).
    init(seeded: TvChannelModel, channelId: String = "bbc-one", model: AppModel = AppModel()) {
        self.channelId = channelId
        self.model = model
        _channelModel = State(initialValue: seeded)
    }
    #endif

    var body: some View {
        Group {
            if let client = model.client {
                content(client: client)
                    .task { await channelModel.load(id: channelId, client: client) }
                    .task(id: dayOffset) {
                        await channelModel.loadProgrammes(
                            id: channelId,
                            day: tvDayString(offsetDays: dayOffset),
                            client: client
                        )
                    }
            } else {
                // Defensive only: reached solely via a push from
                // `TvGuideView`/`TvHomeView`, both of which only render once
                // `model.client` is already non-nil — same invariant every
                // other pushed destination's fallback documents.
                ProgressView()
            }
        }
        .fullScreenCover(item: $liveContext) { context in
            LiveTvOverlay(
                channels: context.channels,
                initialId: context.initialId,
                model: model,
                onClose: { liveContext = nil }
            )
        }
        .accessibilityIdentifier("tvChannelView_\(channelId)")
    }

    // MARK: - Content (loadState machine)

    @ViewBuilder
    private func content(client: OrbixClient) -> some View {
        switch channelModel.loadState {
        case .loading:
            ProgressView("Loading…")
                .font(.title3)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .notFound:
            notFoundView
        case .error(let message):
            errorView(message: message, client: client)
        case .loaded(let detail):
            detailView(detail, client: client)
        }
    }

    private func detailView(_ detail: TvChannelDetail, client: OrbixClient) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 40) {
                VStack(alignment: .leading, spacing: 40) {
                    hero(detail, client: client)
                    watchButton(detail)
                }
                // Own focus section for the hero's favorite heart + Watch
                // button — the `dayTabs` idiom applied here as a mitigation
                // attempt for the focus-lockup finding documented on
                // `favoriteButton` below (see its doc comment for the live
                // result of this specific change).
                .focusSection()
                scheduleSection(client: client)
            }
            .padding(.horizontal, 64)
            .padding(.top, 140)
            .padding(.bottom, 80)
        }
        .accessibilityIdentifier("tvChannelScroll")
    }

    // MARK: - Hero (web lines 42-79)

    private func hero(_ detail: TvChannelDetail, client: OrbixClient) -> some View {
        HStack(alignment: .top, spacing: 32) {
            ChannelLogoView(
                logo: detail.logo,
                name: detail.name,
                channelId: detail.id,
                baseURL: model.baseURL,
                imageLoader: imageLoader
            )
            .frame(width: 160, height: 96)
            .background(OrbixColor.surface)
            .clipShape(RoundedRectangle(cornerRadius: OrbixRadius.md, style: .continuous))

            VStack(alignment: .leading, spacing: 8) {
                Text(L10n.t("tv.channel.number", detail.number))
                    .font(.callout)
                    .foregroundStyle(OrbixColor.textDim)
                Text(detail.name)
                    .font(.largeTitle.bold())
                    .foregroundStyle(OrbixColor.text)
                    .lineLimit(2)
                badgeRow(detail)
            }

            Spacer(minLength: 24)

            favoriteButton(detail, client: client)
        }
        // Deliberately **no** container-level `.accessibilityIdentifier` on
        // this `HStack` — the exact cascade defect `TvGuideView.viewToggle`'s
        // doc comment documents (confirmed live for this view too): a plain
        // `HStack` has no accessibility traits of its own, so an identifier
        // applied here doesn't stay local — it cascades onto every plain
        // `Text`/`Image` descendant (including, critically, overwriting
        // `favoriteButton`'s own required `tvChannelFavoriteButton` id).
    }

    private func badgeRow(_ detail: TvChannelDetail) -> some View {
        HStack(spacing: 10) {
            if let quality = detail.quality {
                QualityChip(label: quality)
            }
            if let region = tvRegionName(detail.country) {
                badgeChip(region)
            }
            ForEach(detail.categories, id: \.self) { category in
                badgeChip(Self.categoryLabel(category))
            }
            if !detail.healthy {
                Text(L10n.t("tv.channel.offlineDot"))
                    .font(.callout)
                    .foregroundStyle(OrbixColor.textDim)
                    .accessibilityIdentifier("tvChannelOfflineDot")
            }
        }
        // No container-level identifier here either — same cascade
        // reasoning as `hero`'s doc comment above (this row nests inside
        // `hero`'s HStack, so it inherits the same hazard).
    }

    /// Bordered `surface2`-stroke pill — web's region/category badge
    /// (`rounded-full border border-[var(--surface-2)] px-2 py-0.5`).
    private func badgeChip(_ label: String) -> some View {
        Text(label)
            .font(.callout)
            .foregroundStyle(OrbixColor.textDim)
            .padding(.horizontal, 14)
            .padding(.vertical, 6)
            .overlay(Capsule().strokeBorder(OrbixColor.surface2, lineWidth: 1))
    }

    /// Localized category display name (`tv.categories.<id>`) — replaces the
    /// old capitalize-the-id fallback with the full category map (mirrors
    /// `TvHomeView.categoryLabel`/`TvGuideView.categoryLabel`). Falls back to
    /// capitalizing the id for any category not yet in the catalog (a future
    /// server-side category the catalog hasn't caught up with).
    private static func categoryLabel(_ id: String) -> String {
        let key = "tv.categories.\(id)"
        let localized = L10n.t(key)
        guard localized == key else { return localized }
        guard let first = id.first else { return id }
        return first.uppercased() + id.dropFirst()
    }

    // MARK: - Favorite toggle (web lines 68-78, optimistic)

    /// **Focus-lockup finding (p4-task-7 live smoke, `.superpowers/sdd/p4-task-7-report.md`
    /// §5):** after Select toggled this heart on, every further directional
    /// press (Up/Down/Left+Down/Right×6) was a no-op until Menu — only
    /// documented in a since-reverted XCUITest harness, no trace in source
    /// until this comment. Hypothesis: the optimistic flip
    /// (`TvChannelModel.toggleFavorite`) re-renders this button's label
    /// (`Image(systemName:)` + `foregroundStyle` both key off `detail.favorite`)
    /// off the main render pass that installed the current focus, which is a
    /// known SwiftUI/tvOS class of bug where the focus engine's currently-
    /// focused item goes stale across a state-driven (not gesture-driven)
    /// view update. **Mitigations applied this pass (p4-task-7/8 follow-up):**
    /// (1) `detailView` now wraps this hero + `watchButton` in their own
    /// `.focusSection()` (the `dayTabs` idiom) so a stale/lost focus can't
    /// escape into the schedule below or the nav bar above; (2) `.id(
    /// "favoriteButton")` below pins this button's identity across the
    /// re-render so SwiftUI can't treat the post-toggle label as a new view.
    /// **Live-reverify result (p4-task-8 gate, vs the NAS):** the lockup
    /// STILL reproduces with both mitigations in place — Select toggles
    /// (server round-trip confirmed both ways, heart re-renders correctly)
    /// but every directional press afterwards is a no-op until Menu. The two
    /// mitigations above are therefore cosmetic; kept because they are
    /// harmless and scope focus correctly. **The `@FocusState` re-assert
    /// predicted below was ALSO attempted at the gate** (bind
    /// `.focused($favoriteFocused)`, drop + re-assert across a 50 ms tick
    /// after `toggleFavorite` returns) **and equally failed** — press events
    /// kept reaching the heart (Select toggled on/off repeatedly) while the
    /// focus engine ignored directional input, so the stale item is not the
    /// (only) problem; the engine's spatial search itself goes dead around
    /// this button after the state-driven re-render. Reverted to avoid
    /// shipping an ineffective behavior change. Root-cause candidates for the
    /// Phase 6 hardware pass: restructure so the toggle does not re-render the
    /// focused subtree (e.g. move `favorite` presentation out of the Button
    /// label), or debounce the optimistic flip until focus moves.
    private func favoriteButton(_ detail: TvChannelDetail, client: OrbixClient) -> some View {
        Button {
            Task { await channelModel.toggleFavorite(client: client) }
        } label: {
            Image(systemName: detail.favorite ? "heart.fill" : "heart")
                .font(.system(size: 26, weight: .semibold))
                .foregroundStyle(detail.favorite ? OrbixColor.accent : OrbixColor.textDim)
                .frame(width: 60, height: 60)
        }
        .buttonStyle(TvChannelFavoriteButtonStyle())
        .id("favoriteButton")
        .accessibilityIdentifier("tvChannelFavoriteButton")
        .accessibilityLabel(detail.favorite ? L10n.t("tv.card.unfavorite") : L10n.t("tv.card.favorite"))
    }

    // MARK: - Watch (web lines 81-85)

    private func watchButton(_ detail: TvChannelDetail) -> some View {
        Button {
            liveContext = LivePlayContext(channels: [Self.bridgeToCard(detail)], initialId: detail.id)
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "play.fill")
                Text(L10n.t("tv.channel.watch"))
            }
        }
        .buttonStyle(OrbixButtonStyle(.primary))
        .accessibilityIdentifier("tvChannelWatchButton")
    }

    /// Bridges the loaded `TvChannelDetail` to the `TvChannelCard` shape
    /// `LiveTvOverlay`'s zap context expects (`now`/`next` nil, every other
    /// field one-to-one) — a single-channel zap context, mirroring web's
    /// `channels={[c]}`. Same idiom as `TvGuideView.bridgeToCard`.
    private static func bridgeToCard(_ detail: TvChannelDetail) -> TvChannelCard {
        TvChannelCard(
            id: detail.id,
            number: detail.number,
            name: detail.name,
            country: detail.country,
            categories: detail.categories,
            quality: detail.quality,
            logo: detail.logo,
            healthy: detail.healthy,
            favorite: detail.favorite,
            now: nil,
            next: nil
        )
    }

    // MARK: - Schedule (web lines 87-156)

    private func scheduleSection(client: OrbixClient) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(L10n.t("tv.channel.schedule"))
                .font(.title3.bold())
                .foregroundStyle(OrbixColor.text)

            dayTabs

            scheduleBody
        }
    }

    private var dayTabs: some View {
        HStack(spacing: 12) {
            dayTab(offset: 0, label: L10n.t("tv.channel.today"), id: "tvChannelScheduleTab_today")
            dayTab(offset: 1, label: L10n.t("tv.channel.tomorrow"), id: "tvChannelScheduleTab_tomorrow")
        }
        // Own focus section so left/right steps between the two day tabs
        // instead of escaping to the hero above or the schedule list below —
        // same convention as `SeasonEpisodeListView.seasonTabs`.
        .focusSection()
    }

    private func dayTab(offset: Int, label: String, id: String) -> some View {
        let isSelected = dayOffset == offset
        return Button {
            guard offset != dayOffset else { return }
            // Clear the stale day's programmes synchronously so the very
            // next render shows the skeleton, not the previous day's rows,
            // before `.task(id: dayOffset)` starts the new load — the
            // `SeasonEpisodeListView.seasonTab` idiom, ported verbatim.
            channelModel.clearForDaySwitch()
            dayOffset = offset
        } label: {
            Text(label)
                .font(.system(size: 22, weight: isSelected ? .semibold : .regular))
        }
        .buttonStyle(DayTabChipStyle(isSelected: isSelected))
        .accessibilityIdentifier(id)
    }

    @ViewBuilder
    private var scheduleBody: some View {
        switch channelModel.scheduleLoadState {
        case .loading:
            scheduleSkeleton
        case .error(let message):
            scheduleErrorView(message: message)
        case .empty:
            noScheduleView
        case .loaded(let programmes):
            scheduleList(programmes)
        }
    }

    /// One shared snapshot for the whole render, so every row's on-air check
    /// agrees (web's `nowMs = Date.now()`, `TvChannelPage.tsx` line 38).
    private func scheduleList(_ programmes: [TvProgramme]) -> some View {
        let now = Date()
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(programmes, id: \.id) { programme in
                programmeRow(programme, now: now)
            }
        }
        .accessibilityIdentifier("tvChannelScheduleList")
    }

    private func programmeRow(_ programme: TvProgramme, now: Date) -> some View {
        let onAir = isAiring(programme, at: now)
        return HStack(alignment: .top, spacing: 20) {
            Text("\(Self.timeLabel(programme.start))–\(Self.timeLabel(programme.stop))")
                .font(.callout.monospacedDigit())
                .foregroundStyle(OrbixColor.textDim)
                .frame(width: 160, alignment: .leading)

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 10) {
                    Text(programme.title)
                        .font(.body.weight(.medium))
                        .foregroundStyle(OrbixColor.text)
                        .lineLimit(1)
                    if onAir {
                        onNowBadge
                    }
                }
                if let description = programme.description, !description.isEmpty {
                    Text(description)
                        .font(.callout)
                        .foregroundStyle(OrbixColor.textDim)
                        .lineLimit(2)
                }
            }
        }
        .padding(.vertical, 14)
        .padding(.horizontal, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: OrbixRadius.sm, style: .continuous)
                .fill(onAir ? OrbixColor.surface2 : Color.clear)
        )
        .overlay(
            RoundedRectangle(cornerRadius: OrbixRadius.sm, style: .continuous)
                .strokeBorder(OrbixColor.live, lineWidth: onAir ? 2 : 0)
        )
        .overlay(alignment: .bottom) {
            if !onAir {
                Rectangle().fill(OrbixColor.surface2).frame(height: 1)
            }
        }
        .accessibilityIdentifier("tvChannelProgrammeRow_\(programme.id)")
    }

    /// Web `tv:channel.onNow` ("On now"), CSS-`uppercase`d at render — the
    /// catalog stores the base value "On now" (`tv.channel.onNow`) and
    /// `.textCase(.uppercase)` applies the same transform the web's CSS does,
    /// so a future translation only needs the natural-case string.
    private var onNowBadge: some View {
        Text(L10n.t("tv.channel.onNow"))
            .textCase(.uppercase)
            .font(.caption2.bold())
            .foregroundStyle(.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(OrbixColor.live, in: RoundedRectangle(cornerRadius: OrbixRadius.chip, style: .continuous))
    }

    /// `start <= now < stop` — the web's exact containment test
    /// (`Date.parse(p.start) <= nowMs && nowMs < Date.parse(p.stop)`).
    private func isAiring(_ programme: TvProgramme, at now: Date) -> Bool {
        guard let start = Self.parseISO(programme.start), let stop = Self.parseISO(programme.stop) else {
            return false
        }
        return start <= now && now < stop
    }

    /// Locale HH:MM — reuses `ChannelNowNextView.time`'s formatter/parsing
    /// idiom rather than duplicating a third copy of the same
    /// `DateFormatter`/`ISO8601DateFormatter` pair.
    private static func timeLabel(_ iso: String) -> String {
        ChannelNowNextView.time(iso)
    }

    /// `OrbixKit`'s own ISO parser (`tvParseMs`) is `internal` to that
    /// module, so the on-air boolean test needs its own `Date`-returning
    /// parse here — the same fractional-then-plain two-formatter idiom every
    /// other ISO parse site in this app already duplicates (`tvParseMs`,
    /// `ChannelNowNextView.time`, `Billboard.parseISODate`).
    private static func parseISO(_ iso: String) -> Date? {
        isoFractional.date(from: iso) ?? isoPlain.date(from: iso)
    }

    private static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let isoPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    // MARK: - Schedule skeleton / empty / error

    /// 5 skeleton rows while the day's schedule loads (including on a
    /// day-tab switch, once `clearForDaySwitch` has cleared the stale grid).
    private var scheduleSkeleton: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(0..<5, id: \.self) { _ in
                SkeletonView()
                    .frame(height: 64)
            }
        }
        .allowsHitTesting(false)
        .accessibilityIdentifier("tvChannelScheduleSkeleton")
    }

    /// Web `tv:channel.noSchedule` verbatim.
    private var noScheduleView: some View {
        Text(L10n.t("tv.channel.noSchedule"))
            .font(.callout)
            .foregroundStyle(OrbixColor.textDim)
            .padding(.vertical, 24)
            .accessibilityIdentifier("tvChannelScheduleEmptyState")
    }

    private func scheduleErrorView(message: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(message)
                .font(.callout)
                .foregroundStyle(OrbixColor.textDim)
            Button(L10n.t("common.actions.retry")) {
                guard let client = model.client else { return }
                Task {
                    await channelModel.loadProgrammes(
                        id: channelId,
                        day: tvDayString(offsetDays: dayOffset),
                        client: client
                    )
                }
            }
            .accessibilityIdentifier("tvChannelScheduleRetryButton")
        }
        .padding(.vertical, 24)
        .accessibilityIdentifier("tvChannelScheduleErrorState")
    }

    // MARK: - Page-level loading / not-found / error (web `channel.isLoading`/not-found)

    /// Web `tv:channel.notFound` ("Channel not found.").
    private var notFoundView: some View {
        ContentUnavailableView(
            L10n.t("tv.channel.notFound"),
            systemImage: "tv.slash",
            description: Text(L10n.t("tv.channel.notFoundBody"))
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("tvChannelNotFound")
    }

    private func errorView(message: String, client: OrbixClient) -> some View {
        ContentUnavailableView {
            Label(L10n.t("tv.channel.errorTitle"), systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            Button(L10n.t("common.actions.retry")) {
                Task { await channelModel.load(id: channelId, client: client) }
            }
            .accessibilityIdentifier("tvChannelRetryButton")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("tvChannelErrorState")
    }
}

// MARK: - Button styles (own focus treatment, `.focusEffectDisabled()` —
// same precedent as `TvGuideView.GuideChipStyle`/`SeasonEpisodeListView.SeasonTabChipStyle`).

/// The hero's favorite heart: a bordered circle (`surface2` stroke), no fill
/// when idle; focused = white ring + subtle surface tint + scale.
private struct TvChannelFavoriteButtonStyle: ButtonStyle {
    @Environment(\.isFocused) private var isFocused

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(Circle().fill(isFocused ? OrbixColor.surface2 : Color.clear))
            .overlay(Circle().strokeBorder(OrbixColor.surface2, lineWidth: 1))
            .overlay(Circle().strokeBorder(Color.white, lineWidth: isFocused ? 3 : 0))
            .scaleEffect(isFocused ? 1.08 : 1.0)
            .animation(.easeOut(duration: 0.15), value: isFocused)
            .focusEffectDisabled()
    }
}

/// Today/Tomorrow day tab — same treatment as
/// `SeasonEpisodeListView.SeasonTabChipStyle`: focused = fully white
/// fill/text + scale, selected-but-unfocused = accent tint, idle = `surface`
/// with a thin `surface2` border.
private struct DayTabChipStyle: ButtonStyle {
    let isSelected: Bool
    @Environment(\.isFocused) private var isFocused

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(isFocused ? Color.white : (isSelected ? Color.white : OrbixColor.textDim))
            .padding(.horizontal, 24)
            .padding(.vertical, 12)
            .background(background, in: RoundedRectangle(cornerRadius: OrbixRadius.sm, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: OrbixRadius.sm, style: .continuous)
                    .strokeBorder(OrbixColor.surface2, lineWidth: isSelected || isFocused ? 0 : 1)
            )
            .overlay(
                RoundedRectangle(cornerRadius: OrbixRadius.sm, style: .continuous)
                    .strokeBorder(Color.white, lineWidth: isFocused ? 3 : 0)
            )
            .scaleEffect(isFocused ? 1.06 : 1.0)
            .animation(.easeOut(duration: 0.15), value: isFocused)
            .focusEffectDisabled()
    }

    private var background: Color {
        isFocused ? Color.white.opacity(0.25) : (isSelected ? OrbixColor.accent : OrbixColor.surface)
    }
}

// MARK: - Model

/// Drives `TvChannelView`: the channel detail load (`GET /api/tv/channels/:id`)
/// and the day schedule load (`GET /api/tv/channels/:id/programmes?day=`),
/// plus the optimistic favorite toggle. Two independent `loadState`s —
/// `loadState` for the page itself (loading/notFound/error/loaded) and
/// `scheduleLoadState` for the day schedule region (loading/error/empty/
/// loaded) — mirroring the `TitleModel` + `SeasonEpisodeModel` split
/// (`TitlePage`/`SeasonEpisodeListView`): the channel detail is this page's
/// "does the page exist at all" gate, while the schedule is a sub-region that
/// reloads independently on every day-tab switch without disturbing the hero.
@MainActor
@Observable
final class TvChannelModel {
    enum LoadState: Equatable {
        case loading
        case notFound
        case error(String)
        case loaded(TvChannelDetail)
    }

    enum ScheduleLoadState: Equatable {
        case loading
        case error(String)
        case empty
        case loaded([TvProgramme])
    }

    private(set) var channel: TvChannelDetail?
    private(set) var isLoading = false
    private(set) var loadError: String?
    private(set) var notFound = false
    private(set) var hasLoaded = false

    private(set) var programmes: [TvProgramme] = []
    private(set) var isLoadingProgrammes = false
    private(set) var programmesError: String?
    private(set) var hasLoadedProgrammes = false

    /// The day `programmes` currently correspond to, so `loadProgrammes` can
    /// tell a day *switch* (clear the stale rows so the skeleton shows) from
    /// a same-day refresh, and so a slow response for a day the user has
    /// since switched away from can't clobber the newer day's rows — same
    /// role as `SeasonEpisodeModel.loadedSeason`.
    private var loadedDay: String?

    init() {}

    #if DEBUG
    /// Preview/snapshot seed — bypasses the network so `#Preview` can
    /// exercise the loaded hero + schedule (including the ON-NOW highlight)
    /// with synthetic data. DEBUG-only.
    init(seedChannel: TvChannelDetail, seedProgrammes: [TvProgramme]) {
        self.channel = seedChannel
        self.programmes = seedProgrammes
        self.hasLoaded = true
        self.hasLoadedProgrammes = true
        // Matches the day `TvChannelView`'s `.task(id: dayOffset)` requests
        // for `dayOffset == 0` on first appearance — without this, `loadedDay`
        // stays `nil`, so that very first real `loadProgrammes` call sees
        // `day != loadedDay` (`"…" != nil`) and synchronously wipes the
        // just-seeded `programmes` back to `[]` before its (harmless, since
        // it targets an unreachable host in a snapshot context) network
        // fetch even starts.
        self.loadedDay = tvDayString(offsetDays: 0)
    }
    #endif

    var loadState: LoadState {
        if let channel { return .loaded(channel) }
        if isLoading || !hasLoaded { return .loading }
        if notFound { return .notFound }
        return .error(loadError ?? L10n.t("errors.unknown"))
    }

    var scheduleLoadState: ScheduleLoadState {
        guard programmes.isEmpty else { return .loaded(programmes) }
        if isLoadingProgrammes || !hasLoadedProgrammes { return .loading }
        if let programmesError { return .error(programmesError) }
        return .empty
    }

    /// The view's initial `.task` and the error state's Retry button.
    func load(id: String, client: OrbixClient) async {
        guard !isLoading else { return }
        isLoading = true
        loadError = nil
        notFound = false

        do {
            channel = try await client.tvChannel(id: id)
        } catch {
            if let orbixError = error as? OrbixError, case .http(404, _) = orbixError {
                notFound = true
            } else if let orbixError = error as? OrbixError, case .http(_, let code) = orbixError, let code {
                loadError = L10n.errorMessage(code)
            } else {
                loadError = L10n.t("errors.network")
            }
        }
        isLoading = false
        hasLoaded = true
    }

    /// Clears the schedule immediately (called synchronously from a day-tab
    /// tap, before `dayOffset` changes) so the switch shows the skeleton
    /// rather than a frame of the previous day's rows — the
    /// `SeasonEpisodeModel.clearForSeasonSwitch` idiom, ported verbatim.
    func clearForDaySwitch() {
        programmes = []
        hasLoadedProgrammes = false
        isLoadingProgrammes = false
        programmesError = nil
    }

    /// Fetches one day's schedule. A day *switch* clears the previous day's
    /// rows (so `scheduleLoadState` reads `.loading` → the skeleton shows); a
    /// same-day refresh keeps them. Stale/cancelled responses (a day the user
    /// switched away from mid-flight) are discarded rather than written —
    /// same shape as `SeasonEpisodeModel.load`, driven by `TvChannelView`'s
    /// `.task(id: dayOffset)` (which cancels the previous iteration for free
    /// on every day change).
    func loadProgrammes(id: String, day: String, client: OrbixClient) async {
        if day != loadedDay {
            programmes = []
            hasLoadedProgrammes = false
        }
        loadedDay = day
        isLoadingProgrammes = true
        programmesError = nil

        do {
            let fetched = try await client.tvProgrammes(id: id, day: day)
            guard !Task.isCancelled, loadedDay == day else { return }
            programmes = fetched
        } catch {
            guard !Task.isCancelled, loadedDay == day else { return }
            if case OrbixError.http(_, let code) = error, let code {
                programmesError = L10n.errorMessage(code)
            } else {
                programmesError = L10n.t("errors.network")
            }
        }

        guard !Task.isCancelled, loadedDay == day else { return }
        isLoadingProgrammes = false
        hasLoadedProgrammes = true
    }

    /// Optimistic favorite toggle (the `TitleModel.toggleWishlist`
    /// flip-then-revert-on-throw idiom): flip `channel.favorite` immediately,
    /// call the server, and restore the pre-toggle value on failure.
    func toggleFavorite(client: OrbixClient) async {
        guard let current = channel else { return }
        let newValue = !current.favorite
        channel?.favorite = newValue
        do {
            try await client.setTvFavorite(channelId: current.id, on: newValue)
        } catch {
            channel?.favorite = current.favorite
        }
    }
}

#Preview {
    TvChannelView(channelId: "bbc-one", model: AppModel())
}

#if DEBUG
/// Synthetic channel + schedule for previews — one programme straddles
/// "now" so the ON-NOW highlight (live ring + surface tint + red badge)
/// renders deterministically without a network round-trip (the live NAS
/// currently carries no EPG data to exercise this against).
private enum TvChannelPreviewData {
    static func healthyDetail() -> TvChannelDetail {
        TvChannelDetail(
            id: "bbc-one",
            number: 101,
            name: "BBC One HD",
            country: "GB",
            languages: ["en"],
            categories: ["general", "news"],
            quality: "1080p",
            logo: nil,
            healthy: true,
            favorite: true,
            streams: []
        )
    }

    static func offlineDetail() -> TvChannelDetail {
        TvChannelDetail(
            id: "disco",
            number: 303,
            name: "Discovery Science",
            country: "US",
            languages: ["en"],
            categories: ["science"],
            quality: "4K",
            logo: nil,
            healthy: false,
            favorite: false,
            streams: []
        )
    }

    static func programmes() -> [TvProgramme] {
        let now = Date()
        let iso = ISO8601DateFormatter()
        func at(_ minutes: Int) -> String { iso.string(from: now.addingTimeInterval(Double(minutes) * 60)) }
        return [
            TvProgramme(
                id: "p1", start: at(-150), stop: at(-90),
                title: "Morning News",
                description: "The latest headlines from around the world, with sport and weather."
            ),
            TvProgramme(
                id: "p2", start: at(-90), stop: at(-15),
                title: "Morning Docs",
                description: "A documentary strand exploring science and nature."
            ),
            TvProgramme(
                id: "p3", start: at(-15), stop: at(45),
                title: "The Big Show",
                description: "A live magazine show covering today's top stories in depth."
            ),
            TvProgramme(
                id: "p4", start: at(45), stop: at(120),
                title: "Afternoon Film",
                description: nil
            ),
        ]
    }
}

#Preview("Loaded — favorite, healthy, ON NOW") {
    TvChannelView(
        seeded: TvChannelModel(
            seedChannel: TvChannelPreviewData.healthyDetail(),
            seedProgrammes: TvChannelPreviewData.programmes()
        )
    )
}

#Preview("Offline channel, no schedule") {
    TvChannelView(
        seeded: TvChannelModel(
            seedChannel: TvChannelPreviewData.offlineDetail(),
            seedProgrammes: []
        ),
        channelId: "disco"
    )
}
#endif
