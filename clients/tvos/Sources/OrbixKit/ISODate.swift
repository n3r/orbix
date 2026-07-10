import Foundation

/// The server sends timestamps via `Date.toISOString()` (always fractional
/// ".000Z"). Try fractional first, then plain, so either shape parses.
/// Shared two-formatter idiom, extracted from what was `Billboard`'s private
/// `parseISODate` — `Billboard.isNew` and `TvGridLayout.tvParseMs` both
/// delegate here now, so there is exactly one ISO-8601 parsing
/// implementation in `OrbixKit`. `nil` on unparseable input.
public func orbixParseISODate(_ iso: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: iso) { return date }
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    return plain.date(from: iso)
}
