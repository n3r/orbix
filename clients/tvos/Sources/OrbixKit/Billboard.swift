import Foundation

/// Deterministic billboard pick — 1:1 port of apps/web/src/lib/billboard.ts.
///   1. a backdrop-bearing card of the first non-"continue" row (the billboard
///      is a discovery surface, not a resume prompt); `seed` rotates which one,
///      so it changes day to day but is stable within a day,
///   2. else the first backdrop-bearing card in any row,
///   3. else the first card of the first non-empty row (tiny libraries),
///   4. else nil.
/// The continue-watching row key is "continue" (packages/core/src/discovery/rows.ts).
public func pickBillboard(rows: [HomeRow], seed: Int = 0) -> MediaCard? {
    if let discovery = rows.first(where: { $0.key != "continue" && !$0.items.isEmpty }) {
        let candidates = discovery.items.filter { $0.backdropPath != nil }
        if !candidates.isEmpty {
            return candidates[abs(seed) % candidates.count]
        }
    }
    for row in rows {
        if let hit = row.items.first(where: { $0.backdropPath != nil }) {
            return hit
        }
    }
    return rows.first(where: { !$0.items.isEmpty })?.items.first
}

/// Day index used to rotate the billboard pick once per day — port of
/// billboard.ts `dailySeed`: floor(now_ms / 86_400_000).
public func dailySeed(now: Date = Date()) -> Int {
    Int((now.timeIntervalSince1970 * 1000) / 86_400_000)
}

/// 14 days, in seconds — port of spotlight.ts NEW_WINDOW_MS.
private let newWindowSeconds: TimeInterval = 14 * 24 * 60 * 60

/// True when `addedAt` (ISO-8601) is within the last 14 days of `now` — port of
/// spotlight.ts `isNew`. No lower bound (a future addedAt still reads as new,
/// matching the web); an unparseable/absent date is never new.
public func isNew(addedAt: String?, now: Date) -> Bool {
    guard let addedAt, let added = orbixParseISODate(addedAt) else { return false }
    return now.timeIntervalSince(added) <= newWindowSeconds
}

/// "S3 E4 · Old Friends" / "S1 E2"; nil for a movie (nil resume) — port of
/// spotlight.ts `resumeLabel`. An empty episodeTitle is treated as absent.
public func resumeLabel(_ resume: MediaCard.Resume?) -> String? {
    guard let resume else { return nil }
    let base = "S\(resume.seasonNumber) E\(resume.episodeNumber)"
    if let title = resume.episodeTitle, !title.isEmpty { return "\(base) · \(title)" }
    return base
}
