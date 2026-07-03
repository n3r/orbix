import { describe, it, expect } from "vitest";
import {
  signProxyPayload,
  verifyProxyPayload,
  encodeUpstream,
  decodeUpstream,
  rewritePlaylist,
  isPrivateHost,
} from "./proxy";

const SECRET = "s".repeat(32);

describe("signProxyPayload / verifyProxyPayload", () => {
  it("is deterministic, 32 chars, base64url-safe", () => {
    const a = signProxyPayload(SECRET, "st1", "http://a/x.m3u8");
    const b = signProxyPayload(SECRET, "st1", "http://a/x.m3u8");
    expect(a).toBe(b);
    expect(a).toHaveLength(32);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("changes when streamId or url changes", () => {
    const base = signProxyPayload(SECRET, "st1", "http://a/x.m3u8");
    expect(signProxyPayload(SECRET, "st2", "http://a/x.m3u8")).not.toBe(base);
    expect(signProxyPayload(SECRET, "st1", "http://a/y.m3u8")).not.toBe(base);
  });

  it("verifies its own signature and rejects tampering", () => {
    const sig = signProxyPayload(SECRET, "st1", "http://a/x.m3u8");
    expect(verifyProxyPayload(SECRET, "st1", "http://a/x.m3u8", sig)).toBe(true);
    expect(verifyProxyPayload(SECRET, "st2", "http://a/x.m3u8", sig)).toBe(false);
    expect(verifyProxyPayload(SECRET, "st1", "http://a/OTHER", sig)).toBe(false);
    expect(verifyProxyPayload(SECRET, "st1", "http://a/x.m3u8", "A".repeat(32))).toBe(false);
    expect(verifyProxyPayload(SECRET, "st1", "http://a/x.m3u8", "short")).toBe(false);
    expect(verifyProxyPayload(SECRET, "st1", "http://a/x.m3u8", "")).toBe(false);
  });
});

describe("encodeUpstream / decodeUpstream", () => {
  it("roundtrips http and https URLs", () => {
    for (const url of ["http://h:8080/a/b.ts?tok=1&x=ы", "https://cdn.example/seg/0001.m4s"]) {
      expect(decodeUpstream(encodeUpstream(url))).toBe(url);
    }
  });

  it("returns null for junk and non-http(s) schemes", () => {
    expect(decodeUpstream("!!!not-base64url!!!")).toBeNull();
    expect(decodeUpstream(encodeUpstream("file:///etc/passwd"))).toBeNull();
    expect(decodeUpstream(encodeUpstream("ftp://h/x"))).toBeNull();
    expect(decodeUpstream(encodeUpstream("not a url"))).toBeNull();
    expect(decodeUpstream("")).toBeNull();
  });
});

describe("rewritePlaylist", () => {
  const base = "http://origin.example/live/master.m3u8";
  const toProxy = (abs: string, kind: "playlist" | "bytes") =>
    `/api/tv/proxy/st1/${kind === "playlist" ? "p" : "s"}?u=${encodeUpstream(abs)}`;

  it("rewrites relative URI lines against the FINAL base url", () => {
    const out = rewritePlaylist("#EXTM3U\nmedia.m3u8\n", base, toProxy);
    expect(out).toContain(`/api/tv/proxy/st1/p?u=${encodeUpstream("http://origin.example/live/media.m3u8")}`);
  });

  it("routes playlists to /p and everything else to /s by extension", () => {
    const text = "#EXTM3U\nvariant.M3U8\n#EXTINF:6.0,\n../seg/00001.ts\n";
    const out = rewritePlaylist(text, base, toProxy);
    expect(out).toContain(`/p?u=${encodeUpstream("http://origin.example/live/variant.M3U8")}`);
    expect(out).toContain(`/s?u=${encodeUpstream("http://origin.example/seg/00001.ts")}`);
  });

  it("rewrites absolute URI lines untouched by the base", () => {
    const out = rewritePlaylist("#EXTM3U\nhttps://other.example/x.m3u8\n", base, toProxy);
    expect(out).toContain(`/p?u=${encodeUpstream("https://other.example/x.m3u8")}`);
  });

  it("rewrites URI attributes: KEY/MAP → bytes, MEDIA/I-FRAME → playlist", () => {
    const text = [
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0xabc',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="alt",URI="audio/alt.m3u8"',
      '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1000,URI="iframe.m3u8"',
    ].join("\n");
    const out = rewritePlaylist(text, base, toProxy);
    expect(out).toContain(`URI="/api/tv/proxy/st1/s?u=${encodeUpstream("http://origin.example/live/key.bin")}"`);
    expect(out).toContain(`URI="/api/tv/proxy/st1/s?u=${encodeUpstream("http://origin.example/live/init.mp4")}"`);
    expect(out).toContain(`URI="/api/tv/proxy/st1/p?u=${encodeUpstream("http://origin.example/live/audio/alt.m3u8")}"`);
    expect(out).toContain(`URI="/api/tv/proxy/st1/p?u=${encodeUpstream("http://origin.example/live/iframe.m3u8")}"`);
    // Non-URI attributes survive verbatim.
    expect(out).toContain("METHOD=AES-128");
    expect(out).toContain('BYTERANGE="720@0"');
  });

  it("tolerates CRLF input and passes comments/blank lines through", () => {
    const text = "#EXTM3U\r\n#EXT-X-TARGETDURATION:6\r\n\r\nseg1.ts\r\n";
    const out = rewritePlaylist(text, base, toProxy);
    expect(out).toContain("#EXT-X-TARGETDURATION:6");
    expect(out).toContain(`/s?u=${encodeUpstream("http://origin.example/live/seg1.ts")}`);
    expect(out).not.toContain("\r");
  });
});

describe("isPrivateHost", () => {
  it.each([
    "127.0.0.1", "127.9.9.9", "10.0.0.1", "172.16.0.1", "172.31.255.255",
    "192.168.1.95", "169.254.10.10", "0.0.0.0", "0.1.2.3",
    "::1", "::", "fe80::1", "febf::1", "fc00::1", "fd12:3456::1",
    "::ffff:10.0.0.1", "::ffff:127.0.0.1",
  ])("blocks %s", (ip) => {
    expect(isPrivateHost(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "193.168.1.1",
    "2a00:1450:4001::1", "2001:db8::1", "::ffff:8.8.8.8",
  ])("allows %s", (ip) => {
    expect(isPrivateHost(ip)).toBe(false);
  });

  it("fails safe (true) on unparsable input", () => {
    expect(isPrivateHost("not-an-ip")).toBe(true);
    expect(isPrivateHost("1.2.3")).toBe(true);
    expect(isPrivateHost("999.1.1.1")).toBe(true);
  });
});
