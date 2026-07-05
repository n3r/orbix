import Foundation

/// Normalizes a user-typed server address into a base-URL string, or `nil` if
/// it can't be a valid `http(s)` URL with a host.
///
/// - Prepends `http://` when no scheme is present, so a viewer can type just
///   `192.168.1.95:8080` — the tvOS on-screen keyboard makes typing `http://`
///   painful, and LAN servers are almost always plain HTTP.
/// - Preserves an explicit `http://` / `https://` (scheme match is
///   case-insensitive); rejects any other scheme (`ftp://…` → `nil`).
/// - Trims surrounding whitespace and any trailing slashes (but keeps a real
///   sub-path, e.g. a reverse-proxy mount like `…/orbix`).
public func normalizeServerURL(_ raw: String) -> String? {
    var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !s.isEmpty else { return nil }

    let lower = s.lowercased()
    if lower.hasPrefix("http://") || lower.hasPrefix("https://") {
        // keep as typed
    } else if lower.contains("://") {
        return nil // some non-http(s) scheme — unsupported
    } else {
        s = "http://" + s
    }

    while s.hasSuffix("/") { s.removeLast() }

    guard let url = URL(string: s),
          let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
          let host = url.host, !host.isEmpty
    else { return nil }
    return s
}
