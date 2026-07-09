import OrbixKit
import SwiftUI

/// Now/next line shared by the (future) guide rows and the `LiveTvOverlay`
/// mini-guide — tvOS port of `apps/web/src/components/tv/ChannelNowNext.tsx`.
/// Renders the current programme's title + `HH:MM–HH:MM` range + a red
/// elapsed-progress bar; the "No guide data" copy when nothing is airing; and
/// a compact "Next · HH:MM Title" line when a next slot exists.
///
/// Web→tvOS notes:
/// - Progress uses `tvNowProgressFraction(startISO:stopISO:)` (OrbixKit port of
///   `nowProgressPercent`) feeding the `NowProgressBar(fraction:)` primitive
///   (red `OrbixColor.live` fill).
/// - Times are formatted locale-aware short (`hour: "2-digit", minute:
///   "2-digit"` on web → `DateFormatter.timeStyle = .short` here), parsed with
///   the same fractional-then-plain ISO idiom OrbixKit uses.
/// - Copy is resolved via `L10n.t` against the `tv.guidePage.noEpg` /
///   `tv.guidePage.nextLine` catalog keys (Phase 5 Task 4), mirroring the web
///   English strings (`tv:guidePage.noEpg` / `tv:guidePage.next`) verbatim
///   for `en`.
struct ChannelNowNextView: View {
    let now: TvProgrammeSlot?
    let next: TvProgrammeSlot?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let now {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(now.title)
                        .font(.caption)
                        .foregroundStyle(OrbixColor.textDim)
                        .lineLimit(1)
                    Text("\(Self.time(now.start))–\(Self.time(now.stop))")
                        .font(.caption2)
                        .foregroundStyle(OrbixColor.textDim)
                        .layoutPriority(1)
                }
                NowProgressBar(fraction: tvNowProgressFraction(startISO: now.start, stopISO: now.stop))
                    .frame(maxWidth: 220)
            } else {
                Text(L10n.t("tv.guidePage.noEpg"))
                    .font(.caption)
                    .foregroundStyle(OrbixColor.textDim)
                    .lineLimit(1)
            }

            if let next {
                Text(L10n.t("tv.guidePage.nextLine", Self.time(next.start), next.title))
                    .font(.caption2)
                    .foregroundStyle(OrbixColor.textDim)
                    .lineLimit(1)
            }
        }
    }

    // MARK: - ISO → local HH:MM

    /// Locale-keyed cache, not a bare `static let`: a single cached formatter
    /// would capture whatever `L10n.locale` was at first access and outlive
    /// any later profile language change, since `RootView`'s `.id(uiLanguage)`
    /// rebuild recreates *views*, not this type's static storage — see
    /// `displayFormatter` below. P5 Task 6: there's one `ChannelNowNextView`
    /// per guide row, each calling `time(_:)` once or twice per render, so
    /// rebuilding a fresh `DateFormatter` on *every* call (the simpler
    /// correctness-only fix) allocated dozens of them per guide render.
    /// Keying by locale identifier keeps the same correctness (a language
    /// change gets its own fresh entry, never a stale reused instance) while
    /// making the steady state — unchanged locale, the overwhelmingly common
    /// case — reuse one instance: at most a handful of entries, one per
    /// language the app ships (6 today).
    private static var displayFormatterCache: [String: DateFormatter] = [:]

    private static var displayFormatter: DateFormatter {
        let key = L10n.locale.identifier
        if let cached = displayFormatterCache[key] { return cached }
        let f = DateFormatter()
        f.locale = L10n.locale
        f.timeStyle = .short
        f.dateStyle = .none
        displayFormatterCache[key] = f
        return f
    }

    /// Localized short time for an ISO timestamp; echoes the raw string back
    /// if it can't be parsed (defensive — the guide chip still renders).
    /// Parsing delegates to `OrbixKit`'s `orbixParseISODate` (the shared
    /// fractional-then-plain two-formatter idiom) rather than this view
    /// keeping its own private formatter pair.
    static func time(_ iso: String) -> String {
        guard let date = orbixParseISODate(iso) else { return iso }
        return displayFormatter.string(from: date)
    }
}

#Preview("Now/next present, no-guide, next-only") {
    let now = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-600))
    let end = ISO8601DateFormatter().string(from: Date().addingTimeInterval(1800))
    let nextStart = ISO8601DateFormatter().string(from: Date().addingTimeInterval(1800))
    let nextEnd = ISO8601DateFormatter().string(from: Date().addingTimeInterval(5400))

    return VStack(alignment: .leading, spacing: 32) {
        ChannelNowNextView(
            now: TvProgrammeSlot(title: "The Evening News at Ten", start: now, stop: end),
            next: TvProgrammeSlot(title: "Late Film: Arrival", start: nextStart, stop: nextEnd)
        )
        ChannelNowNextView(now: nil, next: nil)
        ChannelNowNextView(
            now: nil,
            next: TvProgrammeSlot(title: "Breakfast", start: nextStart, stop: nextEnd)
        )
    }
    .frame(width: 340, alignment: .leading)
    .padding(40)
    .background(OrbixColor.bg)
}
