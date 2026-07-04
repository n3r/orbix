import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { LookupFunction } from "node:net";
import { makeTvUpstream, BROWSER_UA } from "./tv-upstream";

const FIXTURE_HOST = "tv-upstream.fixture";

let origin: http.Server;
let port = 0;
let lastHeaders: http.IncomingHttpHeaders = {};

beforeAll(async () => {
  origin = http.createServer((req, res) => {
    lastHeaders = req.headers;
    if (req.url === "/ok") {
      res.writeHead(200, { "content-type": "text/plain", "x-fixture": "1" });
      res.end("hello");
      return;
    }
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/ok" });
      res.end();
      return;
    }
    if (req.url === "/loop") {
      res.writeHead(302, { location: "/loop" });
      res.end();
      return;
    }
    if (req.url === "/to-metadata") {
      // Redirects off-host to a link-local address (the cloud-metadata SSRF
      // pivot) — the private-IP pre-check must re-run on this hop.
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
      return;
    }
    if (req.url === "/huge") {
      // Streams past the 16 MiB text cap without ever holding it all in
      // memory here: one 1 MiB buffer, written repeatedly with backpressure.
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.on("error", () => {}); // client cancels once the cap trips; ignore the reset
      const chunk = Buffer.alloc(1024 * 1024, "a");
      const totalBytes = 17 * 1024 * 1024; // > MAX_TEXT_BYTES (16 MiB)
      let sent = 0;
      const writeMore = () => {
        while (sent < totalBytes) {
          if (res.destroyed || res.writableEnded) return;
          let ok: boolean;
          try {
            ok = res.write(chunk);
          } catch {
            return;
          }
          sent += chunk.length;
          if (!ok) {
            res.once("drain", writeMore);
            return;
          }
        }
        if (!res.destroyed && !res.writableEnded) res.end();
      };
      writeMore();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  port = (origin.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => origin.close(() => resolve()));
});

// Test-only lookup: maps the fixture hostname to loopback WITHOUT the private
// check (the real guard would rightly refuse it). Honors options.all because
// Node's happy-eyeballs connector calls lookup with { all: true }.
const fixtureLookup: LookupFunction = (hostname, options, callback) => {
  const cb = callback as (err: Error | null, address: unknown, family?: number) => void;
  if (hostname !== FIXTURE_HOST) return cb(new Error(`unexpected host ${hostname}`), null);
  if ((options as { all?: boolean }).all) return cb(null, [{ address: "127.0.0.1", family: 4 }]);
  return cb(null, "127.0.0.1", 4);
};

function fixtureUpstream() {
  return makeTvUpstream({ lookup: fixtureLookup });
}

describe("makeTvUpstream (fixture lookup)", () => {
  it("fetches text with the pinned browser UA when userAgent is null", async () => {
    const upstream = fixtureUpstream();
    const res = await upstream.fetchUpstream(`http://${FIXTURE_HOST}:${port}/ok`, {
      userAgent: null,
      referrer: null,
      wantText: true,
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe("hello");
    expect(res.body).toBeNull();
    expect(res.finalUrl).toBe(`http://${FIXTURE_HOST}:${port}/ok`);
    expect(res.headers["x-fixture"]).toBe("1");
    expect(lastHeaders["user-agent"]).toBe(BROWSER_UA);
    expect(lastHeaders["referer"]).toBeUndefined();
    await upstream.close();
  });

  it("sends the stream's own userAgent and referrer when set", async () => {
    const upstream = fixtureUpstream();
    await upstream.fetchUpstream(`http://${FIXTURE_HOST}:${port}/ok`, {
      userAgent: "MyPlayer/1.0",
      referrer: "http://portal.example/",
      wantText: true,
    });
    expect(lastHeaders["user-agent"]).toBe("MyPlayer/1.0");
    expect(lastHeaders["referer"]).toBe("http://portal.example/");
    await upstream.close();
  });

  it("follows redirects manually and reports the FINAL url", async () => {
    const upstream = fixtureUpstream();
    const res = await upstream.fetchUpstream(`http://${FIXTURE_HOST}:${port}/redirect`, {
      userAgent: null,
      referrer: null,
      wantText: true,
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe("hello");
    expect(res.finalUrl).toBe(`http://${FIXTURE_HOST}:${port}/ok`);
    await upstream.close();
  });

  it("rejects a redirect loop after 5 hops", async () => {
    const upstream = fixtureUpstream();
    await expect(
      upstream.fetchUpstream(`http://${FIXTURE_HOST}:${port}/loop`, {
        userAgent: null,
        referrer: null,
        wantText: true,
      }),
    ).rejects.toThrow(/redirect/i);
    await upstream.close();
  });

  it("rejects a redirect that lands on a private/link-local IP (metadata SSRF pivot)", async () => {
    const upstream = fixtureUpstream();
    // /to-metadata 302s to http://169.254.169.254/... — a literal IP, so this
    // is caught by the pre-dial private-IP check re-running on the redirect
    // hop, not by the injected lookup (which only ever answers FIXTURE_HOST).
    let error: unknown;
    try {
      await upstream.fetchUpstream(`http://${FIXTURE_HOST}:${port}/to-metadata`, {
        userAgent: null,
        referrer: null,
        wantText: true,
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/private/i);
    // Confirms the redirect was actually followed to that hop, not rejected
    // for some unrelated reason before ever leaving the fixture host.
    expect((error as Error).message).toContain("169.254.169.254");
    await upstream.close();
  });

  it("returns a readable byte stream when wantText is false", async () => {
    const upstream = fixtureUpstream();
    const res = await upstream.fetchUpstream(`http://${FIXTURE_HOST}:${port}/ok`, {
      userAgent: null,
      referrer: null,
      wantText: false,
    });
    expect(res.text).toBeUndefined();
    expect(res.body).not.toBeNull();
    const text = await new Response(res.body as unknown as BodyInit).text();
    expect(text).toBe("hello");
    await upstream.close();
  });

  it("rejects a wantText body larger than the 16 MiB cap", async () => {
    const upstream = fixtureUpstream();
    await expect(
      upstream.fetchUpstream(`http://${FIXTURE_HOST}:${port}/huge`, {
        userAgent: null,
        referrer: null,
        wantText: true,
      }),
    ).rejects.toThrow(/too large/i);
    await upstream.close();
  });

  it("rejects non-http(s) schemes", async () => {
    const upstream = fixtureUpstream();
    await expect(
      upstream.fetchUpstream("file:///etc/passwd", { userAgent: null, referrer: null, wantText: true }),
    ).rejects.toThrow();
    await upstream.close();
  });
});

describe("makeTvUpstream (REAL guard — no lookup override)", () => {
  it("blocks a literal loopback IP before any dial", async () => {
    const upstream = makeTvUpstream();
    await expect(
      upstream.fetchUpstream(`http://127.0.0.1:${port}/ok`, {
        userAgent: null,
        referrer: null,
        wantText: true,
      }),
    ).rejects.toThrow(/private/i);
    await upstream.close();
  });

  it("blocks a hostname that resolves to a private address (localhost)", async () => {
    const upstream = makeTvUpstream();
    await expect(
      upstream.fetchUpstream(`http://localhost:${port}/ok`, {
        userAgent: null,
        referrer: null,
        wantText: true,
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringMatching(/private/i) }),
    });
    await upstream.close();
  });
});
