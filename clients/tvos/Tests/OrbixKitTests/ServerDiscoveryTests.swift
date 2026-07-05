import XCTest
@testable import OrbixKit

final class ServerDiscoveryTests: XCTestCase {

    // MARK: - Subnet math

    func testHostIPsForSlash24() {
        let hosts = ServerDiscovery.hostIPs(ipv4: "192.168.1.90", netmask: "255.255.255.0")
        XCTAssertEqual(hosts.count, 254)
        XCTAssertEqual(hosts.first, "192.168.1.1")
        XCTAssertEqual(hosts.last, "192.168.1.254")
        XCTAssertFalse(hosts.contains("192.168.1.0"), "network address excluded")
        XCTAssertFalse(hosts.contains("192.168.1.255"), "broadcast address excluded")
    }

    func testHostIPsClampsWideMaskToLocalSlash24() {
        // A /16 must not explode into 65k probes — scan only the device's /24.
        let hosts = ServerDiscovery.hostIPs(ipv4: "10.0.5.42", netmask: "255.255.0.0")
        XCTAssertEqual(hosts.count, 254)
        XCTAssertEqual(hosts.first, "10.0.5.1")
        XCTAssertEqual(hosts.last, "10.0.5.254")
    }

    func testHostIPsForSlash25() {
        let hosts = ServerDiscovery.hostIPs(ipv4: "192.168.1.10", netmask: "255.255.255.128")
        XCTAssertEqual(hosts.count, 126)
        XCTAssertEqual(hosts.first, "192.168.1.1")
        XCTAssertEqual(hosts.last, "192.168.1.126")
    }

    func testHostIPsInvalidInputIsEmpty() {
        XCTAssertTrue(ServerDiscovery.hostIPs(ipv4: "nope", netmask: "255.255.255.0").isEmpty)
        XCTAssertTrue(ServerDiscovery.hostIPs(ipv4: "1.2.3.4", netmask: "0.0.0.0").isEmpty)
    }

    func testIPv4RoundTrip() {
        XCTAssertEqual(ServerDiscovery.ipv4ToUInt32("192.168.1.90"), 0xC0A8_015A)
        XCTAssertEqual(ServerDiscovery.uint32ToIPv4(0xC0A8_015A), "192.168.1.90")
    }

    // MARK: - Health marker parsing

    func testServerNameMatchesOrbixMarker() {
        let data = Data(#"{"status":"ok","db":true,"service":"orbix","name":"Living Room"}"#.utf8)
        XCTAssertEqual(ServerDiscovery.serverName(fromHealth: data), "Living Room")
    }

    func testServerNameDefaultsWhenMissingOrBlank() {
        XCTAssertEqual(ServerDiscovery.serverName(fromHealth: Data(#"{"service":"orbix"}"#.utf8)), "Orbix")
        XCTAssertEqual(ServerDiscovery.serverName(fromHealth: Data(#"{"service":"orbix","name":"  "}"#.utf8)), "Orbix")
    }

    func testServerNameNilForNonOrbix() {
        XCTAssertNil(ServerDiscovery.serverName(fromHealth: Data(#"{"status":"ok","db":true}"#.utf8)))
    }

    func testServerNameNilForGarbage() {
        XCTAssertNil(ServerDiscovery.serverName(fromHealth: Data("not json at all".utf8)))
    }
}
