import XCTest
@testable import OrbixKit

/// Ported vectors from apps/web/src/lib/tv-grid-layout.test.ts,
/// apps/web/src/lib/tv-time.test.ts (`nowProgressPercent`/`tvDayString`), and
/// apps/web/src/lib/tv.test.ts (`regionName`). The window/geometry tests
/// assert the *same numbers* as the web (timezone-free epoch-ms math); the
/// local-calendar tests build inputs via `DateComponents` in a fixed,
/// non-UTC `Calendar` (Asia/Kolkata, UTC+5:30, no DST) so they pass
/// regardless of the test runner's system timezone, mirroring the web
/// tests' `new Date(2026,6,3,14,37,...)` local-time construction.
final class TvGridLayoutTests: XCTestCase {
    /// Fixed non-UTC, DST-free calendar so local-hour/day assertions are
    /// deterministic on any CI machine.
    private func fixedCalendar() -> Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Asia/Kolkata")!
        return cal
    }

    private func localDate(
        _ year: Int, _ month: Int, _ day: Int,
        _ hour: Int = 0, _ minute: Int = 0, _ second: Int = 0, _ nanosecond: Int = 0,
        calendar: Calendar
    ) -> Date {
        calendar.date(from: DateComponents(
            year: year, month: month, day: day,
            hour: hour, minute: minute, second: second, nanosecond: nanosecond
        ))!
    }

    // MARK: floorToHour

    func testFloorToHourZeroesMinutesSecondsMsKeepsHour() {
        let cal = fixedCalendar()
        let d = localDate(2026, 7, 3, 14, 37, 22, 500_000_000, calendar: cal)
        let floored = tvFloorToHour(d, calendar: cal)
        let comps = cal.dateComponents([.hour, .minute, .second, .nanosecond], from: floored)
        XCTAssertEqual(comps.hour, 14)
        XCTAssertEqual(comps.minute, 0)
        XCTAssertEqual(comps.second, 0)
        XCTAssertEqual(comps.nanosecond, 0)
    }

    func testFloorToHourDoesNotMutateInput() {
        // Adaptation: `Date` is a Swift value type, so in-place mutation
        // (unlike the web's `Date.setMinutes`) is structurally impossible.
        // Kept as a documentation-parity assertion mirroring the web test's
        // intent — the original `d` is untouched after the call.
        let cal = fixedCalendar()
        let d = localDate(2026, 7, 3, 14, 37, calendar: cal)
        _ = tvFloorToHour(d, calendar: cal)
        XCTAssertEqual(cal.component(.minute, from: d), 37)
    }

    // MARK: shiftHours

    func testShiftHoursForwardAndBackwardWithinDay() {
        let cal = fixedCalendar()
        let d = localDate(2026, 7, 3, 14, 0, calendar: cal)
        XCTAssertEqual(cal.component(.hour, from: tvShiftHours(d, 4)), 18)
        XCTAssertEqual(cal.component(.hour, from: tvShiftHours(d, -4)), 10)
    }

    func testShiftHoursRollsOverDayBoundary() {
        let cal = fixedCalendar()
        let d = localDate(2026, 7, 3, 22, 0, calendar: cal)
        let shifted = tvShiftHours(d, 4)
        XCTAssertEqual(cal.component(.day, from: shifted), 4)
        XCTAssertEqual(cal.component(.hour, from: shifted), 2)
    }

    // MARK: primeTimeOnDay

    func testPrimeTimeOnDayReturnsGivenLocalHourOnOffsetDay() {
        let cal = fixedCalendar()
        let from = localDate(2026, 7, 3, 9, 15, calendar: cal)
        let tomorrow6pm = tvPrimeTimeOnDay(offsetDays: 1, hour: 18, from: from, calendar: cal)
        XCTAssertEqual(cal.component(.day, from: tomorrow6pm), 4)
        XCTAssertEqual(cal.component(.hour, from: tomorrow6pm), 18)
        XCTAssertEqual(cal.component(.minute, from: tomorrow6pm), 0)
    }

    func testPrimeTimeOnDayOffsetZeroStaysOnSameDay() {
        let cal = fixedCalendar()
        let from = localDate(2026, 7, 3, 9, 15, calendar: cal)
        let today = tvPrimeTimeOnDay(offsetDays: 0, hour: 18, from: from, calendar: cal)
        XCTAssertEqual(cal.component(.day, from: today), 3)
    }

    // MARK: computeBlockRect

    func testComputeBlockRectInsideWindow() {
        let start = tvParseMs("2026-07-03T14:00:00.000Z")!
        let rect = tvComputeBlockRect(
            startISO: "2026-07-03T15:00:00.000Z",
            stopISO: "2026-07-03T16:00:00.000Z",
            windowStartMs: start, windowMs: 4 * 3_600_000
        )
        XCTAssertEqual(rect.left, 25, accuracy: 0.001)
        XCTAssertEqual(rect.width, 25, accuracy: 0.001)
    }

    func testComputeBlockRectClampsStartBeforeWindow() {
        let start = tvParseMs("2026-07-03T14:00:00.000Z")!
        let rect = tvComputeBlockRect(
            startISO: "2026-07-03T13:00:00.000Z",
            stopISO: "2026-07-03T15:00:00.000Z",
            windowStartMs: start, windowMs: 4 * 3_600_000
        )
        XCTAssertEqual(rect.left, 0)
        XCTAssertEqual(rect.width, 25, accuracy: 0.001) // only the 14:00-15:00 sliver is in-window
    }

    func testComputeBlockRectClampsEndAfterWindow() {
        let start = tvParseMs("2026-07-03T14:00:00.000Z")!
        let rect = tvComputeBlockRect(
            startISO: "2026-07-03T17:00:00.000Z",
            stopISO: "2026-07-03T19:00:00.000Z",
            windowStartMs: start, windowMs: 4 * 3_600_000
        )
        XCTAssertEqual(rect.left, 75, accuracy: 0.001)
        XCTAssertEqual(rect.left + rect.width, 100, accuracy: 0.001)
    }

    func testComputeBlockRectSpanningWholeWindowClampsToFullRange() {
        let start = tvParseMs("2026-07-03T14:00:00.000Z")!
        let rect = tvComputeBlockRect(
            startISO: "2026-07-03T10:00:00.000Z",
            stopISO: "2026-07-03T22:00:00.000Z",
            windowStartMs: start, windowMs: 4 * 3_600_000
        )
        XCTAssertEqual(rect.left, 0)
        XCTAssertEqual(rect.width, 100)
    }

    func testComputeBlockRectEntirelyBeforeWindowCollapsesToZeroWidth() {
        let start = tvParseMs("2026-07-03T14:00:00.000Z")!
        let rect = tvComputeBlockRect(
            startISO: "2026-07-03T10:00:00.000Z",
            stopISO: "2026-07-03T11:00:00.000Z",
            windowStartMs: start, windowMs: 4 * 3_600_000
        )
        XCTAssertEqual(rect.width, 0)
    }

    func testComputeBlockRectEntirelyAfterWindowCollapsesToZeroWidth() {
        let start = tvParseMs("2026-07-03T14:00:00.000Z")!
        let rect = tvComputeBlockRect(
            startISO: "2026-07-03T19:00:00.000Z",
            stopISO: "2026-07-03T20:00:00.000Z",
            windowStartMs: start, windowMs: 4 * 3_600_000
        )
        XCTAssertEqual(rect.width, 0)
    }

    // MARK: generateTimeTicks

    func testGenerateTimeTicksEveryThirtyMinutesInclusiveOfBothEdges() {
        let ticks = tvGenerateTimeTicks(windowStartMs: 0, windowMs: 4 * 3_600_000)
        XCTAssertEqual(ticks.count, 9) // 0,30,...,240
        XCTAssertEqual(ticks[0], TvTimeTick(ms: 0, leftPct: 0))
        XCTAssertEqual(ticks[ticks.count - 1], TvTimeTick(ms: 4 * 3_600_000, leftPct: 100))
        XCTAssertEqual(ticks[1].leftPct, 12.5, accuracy: 0.001) // 30 min of a 4h window
    }

    func testGenerateTimeTicksRespectsCustomStep() {
        let ticks = tvGenerateTimeTicks(windowStartMs: 0, windowMs: 2 * 3_600_000, stepMs: 3_600_000)
        XCTAssertEqual(ticks.count, 3) // 0, 60, 120
    }

    // MARK: nowLinePercent

    func testNowLinePercentPositionsInsideWindow() {
        let start = tvParseMs("2026-07-03T14:00:00.000Z")!
        let at = tvParseMs("2026-07-03T15:00:00.000Z")!
        XCTAssertEqual(tvNowLinePercent(windowStartMs: start, windowMs: 4 * 3_600_000, atMs: at)!, 25, accuracy: 0.001)
    }

    func testNowLinePercentNilBeforeWindowStarts() {
        let start = tvParseMs("2026-07-03T14:00:00.000Z")!
        let at = tvParseMs("2026-07-03T13:59:00.000Z")!
        XCTAssertNil(tvNowLinePercent(windowStartMs: start, windowMs: 4 * 3_600_000, atMs: at))
    }

    func testNowLinePercentNilAtOrAfterWindowEndHalfOpen() {
        let start = tvParseMs("2026-07-03T14:00:00.000Z")!
        let windowMs = 4.0 * 3_600_000
        XCTAssertNil(tvNowLinePercent(windowStartMs: start, windowMs: windowMs, atMs: start + windowMs))
    }

    func testNowLinePercentZeroAtExactInclusiveLowerBound() {
        let start = tvParseMs("2026-07-03T14:00:00.000Z")!
        XCTAssertEqual(tvNowLinePercent(windowStartMs: start, windowMs: 4 * 3_600_000, atMs: start), 0)
    }

    // MARK: windowMs<=0 guard

    func testComputeBlockRectAndNowLinePercentGuardDegenerateWindow() {
        let start = tvParseMs("2026-07-03T14:00:00.000Z")!
        let rect = tvComputeBlockRect(
            startISO: "2026-07-03T15:00:00.000Z",
            stopISO: "2026-07-03T16:00:00.000Z",
            windowStartMs: start, windowMs: 0
        )
        XCTAssertEqual(rect, TvBlockRect(left: 0, width: 0))
        XCTAssertNil(tvNowLinePercent(windowStartMs: start, windowMs: 0, atMs: start))
    }

    // MARK: nowProgressFraction (tv-time.ts nowProgressPercent, ported as a 0-1 fraction)

    func testNowProgressFractionIsElapsedFractionOfSlot() {
        let at = tvParseMs("2026-07-03T16:30:00.000Z")!
        let fraction = tvNowProgressFraction(
            startISO: "2026-07-03T16:00:00.000Z",
            stopISO: "2026-07-03T17:00:00.000Z",
            atMs: at
        )
        XCTAssertEqual(fraction, 0.5, accuracy: 0.0001)
    }

    func testNowProgressFractionClampsToZeroToOne() {
        let before = tvParseMs("2026-07-03T15:00:00.000Z")!
        let after = tvParseMs("2026-07-03T18:00:00.000Z")!
        XCTAssertEqual(tvNowProgressFraction(
            startISO: "2026-07-03T16:00:00.000Z", stopISO: "2026-07-03T17:00:00.000Z", atMs: before
        ), 0)
        XCTAssertEqual(tvNowProgressFraction(
            startISO: "2026-07-03T16:00:00.000Z", stopISO: "2026-07-03T17:00:00.000Z", atMs: after
        ), 1)
    }

    func testNowProgressFractionDegenerateSlotIsZero() {
        let start = "2026-07-03T16:00:00.000Z"
        let atMs = tvParseMs(start)!
        XCTAssertEqual(tvNowProgressFraction(startISO: start, stopISO: start, atMs: atMs), 0)
    }

    // MARK: tvDayString

    func testTvDayStringFormatsLocalCalendarDayWithOffset() {
        let cal = fixedCalendar()
        let base = localDate(2026, 7, 3, 23, 30, calendar: cal) // crosses local midnight with +1
        XCTAssertEqual(tvDayString(offsetDays: 0, from: base, calendar: cal), "2026-07-03")
        XCTAssertEqual(tvDayString(offsetDays: 1, from: base, calendar: cal), "2026-07-04")
    }

    // MARK: regionName

    func testRegionNameMapsIptvOrgUKToISOGBDisplayName() {
        let enUS = Locale(identifier: "en_US")
        XCTAssertEqual(tvRegionName("UK", locale: enUS), "United Kingdom")
        XCTAssertEqual(tvRegionName("uk", locale: enUS), "United Kingdom")
    }

    func testRegionNameResolvesNormalCodesInGivenLocale() {
        let enUS = Locale(identifier: "en_US")
        XCTAssertEqual(tvRegionName("RU", locale: enUS), "Russia")
        XCTAssertEqual(tvRegionName("DE", locale: enUS), "Germany")
    }

    func testRegionNameNilForNilAndEmptyEchoesJunkCodes() {
        let enUS = Locale(identifier: "en_US")
        XCTAssertNil(tvRegionName(nil, locale: enUS))
        XCTAssertNil(tvRegionName("", locale: enUS))
        XCTAssertEqual(tvRegionName("ZZZZ", locale: enUS), "ZZZZ")
    }
}
