import Foundation

/// Deterministic hue-hash + initials for monogram avatars/tiles — a direct
/// port of `channelHue`/`channelInitials` in apps/web/src/lib/tv.ts. The web
/// algorithm is the source of truth; keep these two functions byte-for-byte
/// equivalent (see apps/web/src/lib/tv.test.ts for the known-value pins this
/// port is checked against in AvatarHueTests.swift).

/// Deterministic hue in `0..<360` from a stable seed string (a profile
/// name, channel id, ...) — monogram/avatar tile background color.
///
/// Mirrors `channelHue` exactly: `h = 0; for each char: h = (h * 31 + code)
/// mod 2^32; return h % 360`. The web hashes over UTF-16 code units
/// (`String.charCodeAt`), so this iterates `name.utf16` (not
/// `unicodeScalars`) — the two agree for all BMP text (Latin, Cyrillic,
/// CJK, ...) and only diverge for astral-plane code points (rare emoji),
/// where matching the web means hashing each UTF-16 surrogate half
/// separately, exactly as `charCodeAt` does.
public func avatarHue(_ name: String) -> Double {
    var hash: UInt32 = 0
    for unit in name.utf16 {
        hash = hash &* 31 &+ UInt32(unit)
    }
    return Double(hash % 360)
}

/// Up to two initials from the name's first two (whitespace-trimmed, run-
/// collapsed) words, uppercased; "?" for an empty or whitespace-only name.
///
/// Mirrors `channelInitials` exactly: trims the string, splits on
/// whitespace runs (dropping empty pieces — so "  bbc  one " → ["bbc",
/// "one"]), takes the first two words, and keeps each word's first
/// *character* (not UTF-16 unit), matching the web's code-point-aware
/// `[...w][0]` spread — this is why an astral emoji like "😀 CNN" yields
/// "😀C" rather than a split surrogate half.
public func avatarInitials(_ name: String) -> String {
    let words = name.split(whereSeparator: { $0.isWhitespace }).prefix(2)
    let initials = words.compactMap { word in
        word.first.map { String($0).uppercased() }
    }.joined()
    return initials.isEmpty ? "?" : initials
}
