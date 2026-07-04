import Foundation
#if canImport(Darwin)
import Darwin
#endif

/// An Orbix server found on the LAN by `ServerDiscovery`.
public struct DiscoveredServer: Sendable, Equatable, Identifiable {
    public let name: String
    public let host: String
    public let port: Int

    public init(name: String, host: String, port: Int) {
        self.name = name
        self.host = host
        self.port = port
    }

    public var id: String { "\(host):\(port)" }
    public var baseURL: String { "http://\(host):\(port)" }
}

/// Discovers Orbix servers on the device's local subnet by probing
/// `GET /health` across it and matching the `service: "orbix"` marker that
/// `apps/api/src/routes/health.ts` emits. Stateless and `Sendable`; the
/// subnet math and marker parsing are pure (and unit-tested), the address
/// lookup + probing are the only side effects.
public struct ServerDiscovery: Sendable {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    /// `service`/`name` fields of an Orbix `/health` body.
    private struct HealthInfo: Decodable {
        let service: String?
        let name: String?
    }

    /// Scans the local /24 (see `hostIPs`) for Orbix servers on `port`.
    /// Probes run in bounded-concurrency batches so a subnet full of dead
    /// addresses (each costing a full `timeoutPerHost`) still finishes in a
    /// few seconds. Returns the matches sorted by host, numerically.
    public func scan(port: Int = 8080, timeoutPerHost: TimeInterval = 1.5, concurrency: Int = 64) async -> [DiscoveredServer] {
        guard let (ip, netmask) = Self.localIPv4AndNetmask() else { return [] }
        let hosts = Self.hostIPs(ipv4: ip, netmask: netmask)
        let session = self.session
        let batchSize = max(1, concurrency)

        var found: [DiscoveredServer] = []
        var index = 0
        while index < hosts.count {
            let end = min(index + batchSize, hosts.count)
            let batch = Array(hosts[index..<end])
            await withTaskGroup(of: DiscoveredServer?.self) { group in
                for host in batch {
                    group.addTask {
                        await Self.probe(host: host, port: port, timeout: timeoutPerHost, session: session)
                    }
                }
                for await result in group {
                    if let server = result { found.append(server) }
                }
            }
            index = end
        }
        return found.sorted { $0.host.compare($1.host, options: .numeric) == .orderedAscending }
    }

    private static func probe(host: String, port: Int, timeout: TimeInterval, session: URLSession) async -> DiscoveredServer? {
        guard let url = URL(string: "http://\(host):\(port)/health") else { return nil }
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.timeoutInterval = timeout
        do {
            let (data, resp) = try await session.data(for: req)
            guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else { return nil }
            return serverName(fromHealth: data).map { DiscoveredServer(name: $0, host: host, port: port) }
        } catch {
            return nil
        }
    }

    /// Pure: the server name if `data` is an Orbix `/health` body
    /// (`service == "orbix"`), else `nil`. A missing/blank name defaults to
    /// "Orbix".
    static func serverName(fromHealth data: Data) -> String? {
        guard let info = try? JSONDecoder().decode(HealthInfo.self, from: data),
              info.service == "orbix" else { return nil }
        let name = info.name?.trimmingCharacters(in: .whitespaces)
        return (name?.isEmpty == false) ? name : "Orbix"
    }

    // MARK: - Subnet math (pure)

    /// The scannable host addresses for the device's subnet, clamped to at
    /// most the local /24 so a wide netmask (e.g. /16) never explodes into a
    /// 65k-host scan. Excludes the network and broadcast addresses.
    static func hostIPs(ipv4 ip: String, netmask: String) -> [String] {
        guard let ipInt = ipv4ToUInt32(ip),
              let maskInt = ipv4ToUInt32(netmask), maskInt != 0 else { return [] }
        let effectiveMask = max(maskInt, UInt32(0xFFFF_FF00)) // never wider than /24
        let network = ipInt & effectiveMask
        let broadcast = network | ~effectiveMask
        guard broadcast > network + 1 else { return [] }

        var hosts: [String] = []
        var addr = network + 1
        while addr < broadcast {
            hosts.append(uint32ToIPv4(addr))
            addr += 1
        }
        return hosts
    }

    static func ipv4ToUInt32(_ s: String) -> UInt32? {
        let parts = s.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        var result: UInt32 = 0
        for part in parts {
            guard let octet = UInt8(part) else { return nil }
            result = (result << 8) | UInt32(octet)
        }
        return result
    }

    static func uint32ToIPv4(_ n: UInt32) -> String {
        "\((n >> 24) & 0xFF).\((n >> 16) & 0xFF).\((n >> 8) & 0xFF).\(n & 0xFF)"
    }

    // MARK: - Interface address (syscall)

    /// The device's primary IPv4 address + netmask (prefers `en0`), or `nil`
    /// when there's no usable non-loopback IPv4 interface.
    static func localIPv4AndNetmask() -> (ip: String, netmask: String)? {
        #if canImport(Darwin)
        var ifaddrPtr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddrPtr) == 0, let first = ifaddrPtr else { return nil }
        defer { freeifaddrs(ifaddrPtr) }

        var fallback: (String, String)?
        for ptr in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let flags = Int32(ptr.pointee.ifa_flags)
            guard (flags & IFF_UP) == IFF_UP, (flags & IFF_LOOPBACK) == 0,
                  let addr = ptr.pointee.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET),
                  let maskAddr = ptr.pointee.ifa_netmask,
                  let ip = numericHost(addr), let mask = numericHost(maskAddr) else { continue }
            let name = String(cString: ptr.pointee.ifa_name)
            if name == "en0" { return (ip, mask) }
            if name.hasPrefix("en"), fallback == nil { fallback = (ip, mask) }
        }
        return fallback
        #else
        return nil
        #endif
    }

    #if canImport(Darwin)
    private static func numericHost(_ sa: UnsafeMutablePointer<sockaddr>) -> String? {
        var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
        let status = getnameinfo(sa, socklen_t(sa.pointee.sa_len), &buffer, socklen_t(buffer.count), nil, 0, NI_NUMERICHOST)
        guard status == 0 else { return nil }
        return String(cString: buffer)
    }
    #endif
}
