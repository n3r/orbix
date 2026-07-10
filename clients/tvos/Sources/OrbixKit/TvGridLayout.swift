import Foundation

// Pure EPG-grid layout + TV time-display math — 1:1 port of
// apps/web/src/lib/tv-grid-layout.ts, apps/web/src/lib/tv-time.ts, and
// `regionName` from apps/web/src/lib/tv.ts. The window/geometry math
// (computeBlockRect/generateTimeTicks/nowLinePercent/nowProgressPercent)
// operates on epoch-ms + ISO-with-`Z` timestamps, so it is timezone-free and
// reuses the web's exact numeric vectors. The calendar helpers
// (floorToHour/shiftHours/primeTimeOnDay/tvDayString) mirror the web's local
// `Date` semantics via a `Calendar` parameter (defaulting to `.current`).

// MARK: - Local calendar/day nav (TvGuideGrid window model)

/// Floors a Date to the start of its local hour (zeroes minute/second/ns),
/// keeping the local hour — port of tv-grid-layout.ts `floorToHour`.
public func tvFloorToHour(_ d: Date, calendar: Calendar = .current) -> Date {
    var comps = calendar.dateComponents([.year, .month, .day, .hour], from: d)
    comps.minute = 0
    comps.second = 0
    comps.nanosecond = 0
    return calendar.date(from: comps) ?? d
}

/// Shifts a Date by a (possibly negative) number of hours — the Prev/Next
/// nav. Pure epoch-ms shift (timezone-free) — port of tv-grid-layout.ts
/// `shiftHours`.
public func tvShiftHours(_ d: Date, _ hours: Int) -> Date {
    d.addingTimeInterval(Double(hours) * 3_600)
}

/// A given local day (offset from `from`'s day) at a fixed local hour. Used
/// for the Tomorrow day chip: the grid opens at prime time (18:00 local)
/// rather than midnight so it lands on useful content instead of an empty
/// early-morning window — port of tv-grid-layout.ts `primeTimeOnDay`.
public func tvPrimeTimeOnDay(
    offsetDays: Int,
    hour: Int,
    from: Date = Date(),
    calendar: Calendar = .current
) -> Date {
    var comps = calendar.dateComponents([.year, .month, .day], from: from)
    comps.day = (comps.day ?? 1) + offsetDays
    comps.hour = hour
    comps.minute = 0
    comps.second = 0
    comps.nanosecond = 0
    return calendar.date(from: comps) ?? from
}

/// Local calendar day as "YYYY-MM-DD" (what the Today/Tomorrow schedule tabs
/// send as the `?day=` param) — port of tv-time.ts `tvDayString`.
public func tvDayString(offsetDays: Int, from: Date = Date(), calendar: Calendar = .current) -> String {
    var comps = calendar.dateComponents([.year, .month, .day], from: from)
    comps.day = (comps.day ?? 1) + offsetDays
    let d = calendar.date(from: comps) ?? from
    let ymd = calendar.dateComponents([.year, .month, .day], from: d)
    let year = ymd.year ?? 0
    let month = ymd.month ?? 0
    let day = ymd.day ?? 0
    return String(format: "%04d-%02d-%02d", year, month, day)
}

// MARK: - Grid geometry (window-relative percentages)

/// A programme's rect within the time track, as percentages of the window.
public struct TvBlockRect: Equatable, Sendable {
    public let left: Double
    public let width: Double

    public init(left: Double, width: Double) {
        self.left = left
        self.width = width
    }
}

/// Port of tv-grid-layout.ts `computeBlockRect`: a programme's rect as
/// percentages of the window, both edges clamped to [0,100] (partial blocks at
/// the window edges render flush, never spill). Degenerate window → {0,0}.
public func tvComputeBlockRect(
    startISO: String,
    stopISO: String,
    windowStartMs: Double,
    windowMs: Double
) -> TvBlockRect {
    guard windowMs > 0, let startMs = tvParseMs(startISO), let stopMs = tvParseMs(stopISO) else {
        return TvBlockRect(left: 0, width: 0)
    }
    let rawLeft = ((startMs - windowStartMs) / windowMs) * 100
    let rawRight = ((stopMs - windowStartMs) / windowMs) * 100
    let left = min(100, max(0, rawLeft))
    let right = min(100, max(0, rawRight))
    return TvBlockRect(left: left, width: max(0, right - left))
}

/// One ruler tick: its timestamp and left position as a window-relative percentage.
public struct TvTimeTick: Equatable, Sendable {
    public let ms: Double
    public let leftPct: Double

    public init(ms: Double, leftPct: Double) {
        self.ms = ms
        self.leftPct = leftPct
    }
}

/// Tick marks spanning the window at a fixed step (default 30 min), inclusive
/// of both edges (a tick at 0% and one at 100%) — port of tv-grid-layout.ts
/// `generateTimeTicks`.
public func tvGenerateTimeTicks(
    windowStartMs: Double,
    windowMs: Double,
    stepMs: Double = 30 * 60_000
) -> [TvTimeTick] {
    guard windowMs > 0, stepMs > 0 else { return [] }
    var ticks: [TvTimeTick] = []
    var t: Double = 0
    while t <= windowMs {
        ticks.append(TvTimeTick(ms: windowStartMs + t, leftPct: (t / windowMs) * 100))
        t += stepMs
    }
    return ticks
}

/// The now-line's left position as a window-relative percentage, or `nil`
/// when "now" falls outside the half-open window `[windowStart, windowEnd)`
/// (the line is hidden entirely rather than clamped to an edge) — port of
/// tv-grid-layout.ts `nowLinePercent`.
public func tvNowLinePercent(
    windowStartMs: Double,
    windowMs: Double,
    atMs: Double = Date().timeIntervalSince1970 * 1000
) -> Double? {
    guard windowMs > 0 else { return nil }
    guard atMs >= windowStartMs, atMs < windowStartMs + windowMs else { return nil }
    return ((atMs - windowStartMs) / windowMs) * 100
}

// MARK: - Now/next progress

/// Elapsed fraction of an airing slot, clamped to [0,1] — port of
/// tv-time.ts `nowProgressPercent` (there expressed as a 0-100 percent;
/// here as the 0-1 fraction `NowProgressBar(fraction:)` consumes).
public func tvNowProgressFraction(
    startISO: String,
    stopISO: String,
    atMs: Double = Date().timeIntervalSince1970 * 1000
) -> Double {
    guard let startMs = tvParseMs(startISO), let stopMs = tvParseMs(stopISO), stopMs > startMs else {
        return 0
    }
    return min(1, max(0, (atMs - startMs) / (stopMs - startMs)))
}

// MARK: - Region display name

/// Localized region display name — port of tv.ts `regionName`: the iptv-org
/// `UK` → ISO `GB` fix, then `Locale.localizedString(forRegionCode:)`.
/// `nil` for a nil/empty code; junk codes that don't resolve are echoed back
/// unchanged (guide chips still render).
public func tvRegionName(_ code: String?, locale: Locale = .current) -> String? {
    guard let code, !code.isEmpty else { return nil }
    let iso = code.uppercased() == "UK" ? "GB" : code.uppercased()
    return locale.localizedString(forRegionCode: iso) ?? code
}

// MARK: - ISO parsing

/// The server sends timestamps via `Date.toISOString()` (always fractional
/// ".000Z"). Delegates to the shared two-formatter idiom in
/// `ISODate.swift`'s `orbixParseISODate`. `nil` on unparseable input,
/// mirroring the web's `Date.parse` → `NaN` guard (callers here guard on the
/// `Optional` instead).
func tvParseMs(_ iso: String) -> Double? {
    orbixParseISODate(iso).map { $0.timeIntervalSince1970 * 1000 }
}
