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

    private static let displayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.timeStyle = .short
        f.dateStyle = .none
        return f
    }()

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

    /// Localized short time for an ISO timestamp; echoes the raw string back
    /// if it can't be parsed (defensive — the guide chip still renders).
    static func time(_ iso: String) -> String {
        let date = isoFractional.date(from: iso) ?? isoPlain.date(from: iso)
        guard let date else { return iso }
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
