import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { LookupFunction } from "node:net";
import { buildApp } from "../app";
import { makeTvUpstream, BROWSER_UA } from "../lib/tv-upstream";
import { encodeUpstream, signProxyPayload } from "@orbix/core";
import type { Env } from "@orbix/config";

const env: Env = {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x",
  API_PORT: 1061, WEB_PORT: 1060, SESSION_SECRET: "x".repeat(32), WEB_ORIGIN: "http://localhost:1060",
  METADATA_DIR: "./data/metadata", TRANSCODE_DIR: "./data/transcode",
  MODELS_DIR: "./data/models", MOUNTS_DIR: "./data/mounts", EMBEDDINGS_ENABLED: true, MAX_TRANSCODE_SESSIONS: 4,
};

const FIXTURE_HOST = "tv-origin.fixture";
const SEGMENT_BYTES = Buffer.from("fake-ts-segment-bytes");

let origin: http.Server;
let port = 0;
const seenHeaders: Record<string, http.IncomingHttpHeaders> = {};

// CRLF like real iptv-org playlists; master references a variant + alt audio.
const master = () =>
  [
    "#EXTM3U",
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="alt",URI="audio.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=2000000,AUDIO="aud"',
    "media.m3u8",
    "",
  ].join("\r\n");

const media = () =>
  [
    "#EXTM3U",
    "#EXT-X-TARGETDURATION:6",
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0',
    "#EXTINF:6.0,",
    "segment.ts",
    "#EXT-X-ENDLIST",
    "",
  ].join("\n");

beforeAll(async () => {
  origin = http.createServer((req, res) => {
    seenHeaders[req.url ?? ""] = req.headers;
    if (req.url === "/master.m3u8") {
      res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
      res.end(master());
    } else if (req.url === "/media.m3u8") {
      res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
      res.end(media());
    } else if (req.url === "/segment.ts") {
      res.writeHead(200, { "content-type": "video/mp2t", "content-length": String(SEGMENT_BYTES.length) });
      res.end(SEGMENT_BYTES);
    } else if (req.url === "/key.bin") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.from("0123456789abcdef"));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  port = (origin.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => origin.close(() => resolve()));
});

const fixtureLookup: LookupFunction = (hostname, options, callback) => {
  const cb = callback as (err: Error | null, address: unknown, family?: number) => void;
  if (hostname !== FIXTURE_HOST) return cb(new Error(`unexpected host ${hostname}`), null);
  if ((options as { all?: boolean }).all) return cb(null, [{ address: "127.0.0.1", family: 4 }]);
  return cb(null, "127.0.0.1", 4);
};

const cookies = { orbix_session: "s1", orbix_profile: "p1" };
const standardProfile = { id: "p1", name: "A", avatar: null, kind: "standard", maturityCap: null, language: "en" };
const kidsProfile = { id: "p1", name: "K", avatar: null, kind: "kids", maturityCap: 0, language: "en" };

function streamRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "st1",
    url: `http://${FIXTURE_HOST}:${port}/master.m3u8`,
    referrer: null,
    userAgent: null,
    status: "unknown",
    failCount: 0,
    channel: { hidden: false },
    ...overrides,
  };
}

async function buildTvApp(profile: unknown = standardProfile, withFixtureUpstream = true) {
  const app = await buildApp(
    env,
    withFixtureUpstream ? { tvUpstream: makeTvUpstream({ lookup: fixtureLookup }) } : undefined,
  );
  (app as any).prisma.session = {
    findUnique: async () => ({ id: "s1", accountId: "a1", expiresAt: new Date(Date.now() + 3_600_000) }),
  };
  (app as any).prisma.profile = { findUnique: async () => profile };
  return app;
}

describe("GET /tv/channels/:id/play", () => {
  it("orders sources ok>unknown>degraded, skips dead/non-hls, caps at 3", async () => {
    const app = await buildTvApp();
    (app as any).prisma.tvChannel = {
      findUnique: async () => ({
        id: "ch1", number: 5, name: "One", logoPath: "channel/one.png", country: "RU", quality: "1080p", hidden: false,
        streams: [
          { id: "dead", quality: null, label: null, priority: 0, protocol: "hls", status: "dead" },
          { id: "dash", quality: null, label: null, priority: 0, protocol: "dash", status: "ok" },
          { id: "deg", quality: null, label: null, priority: 0, protocol: "hls", status: "degraded" },
          { id: "unk", quality: null, label: "Not 24/7", priority: 1, protocol: "hls", status: "unknown" },
          { id: "ok2", quality: "720p", label: null, priority: 2, protocol: "hls", status: "ok" },
          { id: "ok1", quality: "1080p", label: null, priority: 1, protocol: "hls", status: "ok" },
        ],
      }),
    };
    (app as any).prisma.tvProgramme = { findMany: async () => [] }; // no EPG rows in this test
    const res = await app.inject({ method: "GET", url: "/api/tv/channels/ch1/play", cookies });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.channel).toMatchObject({ id: "ch1", number: 5, name: "One", logo: "channel/one.png", country: "RU", quality: "1080p" });
    expect(body.nowNext).toEqual({ now: null, next: null });
    expect(body.sources.map((s: any) => s.streamId)).toEqual(["ok1", "ok2", "unk"]);
    expect(body.sources[0]).toMatchObject({ src: "/api/tv/proxy/ok1/index.m3u8", quality: "1080p", label: null });
    await app.close();
  });

  it("GET /api/tv/channels/:id/play fills nowNext from one grouped query", async () => {
    const app = await buildTvApp();
    (app as any).prisma.tvChannel = {
      findUnique: async () => ({
        id: "ch1", number: 5, name: "One", logoPath: "channel/one.png", country: "RU", quality: "1080p", hidden: false,
        streams: [{ id: "ok1", quality: "1080p", label: null, priority: 0, protocol: "hls", status: "ok" }],
      }),
    };
    const programmeCalls: unknown[] = [];
    (app as any).prisma.tvProgramme = {
      findMany: async (args: unknown) => {
        programmeCalls.push(args);
        return [
          { channelId: "ch1", title: "Время", start: new Date(Date.now() - 600_000), stop: new Date(Date.now() + 600_000) },
          { channelId: "ch1", title: "Кино", start: new Date(Date.now() + 600_000), stop: new Date(Date.now() + 4_200_000) },
        ];
      },
    };
    const res = await app.inject({ method: "GET", url: "/api/tv/channels/ch1/play", cookies });
    expect(res.statusCode).toBe(200);
    expect(programmeCalls).toHaveLength(1);
    expect(res.json().nowNext.now.title).toBe("Время");
    expect(res.json().nowNext.next.title).toBe("Кино");
    await app.close();
  });

  it("409s with no_playable_stream when nothing is playable", async () => {
    const app = await buildTvApp();
    (app as any).prisma.tvChannel = {
      findUnique: async () => ({
        id: "ch1", number: 5, name: "One", logoPath: null, country: null, quality: null, hidden: false,
        streams: [
          { id: "dead", quality: null, label: null, priority: 0, protocol: "hls", status: "dead" },
          { id: "dash", quality: null, label: null, priority: 0, protocol: "dash", status: "ok" },
        ],
      }),
    };
    const res = await app.inject({ method: "GET", url: "/api/tv/channels/ch1/play", cookies });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("no_playable_stream");
    await app.close();
  });

  it("404s unknown and hidden channels", async () => {
    const app = await buildTvApp();
    (app as any).prisma.tvChannel = { findUnique: async () => null };
    expect((await app.inject({ method: "GET", url: "/api/tv/channels/nope/play", cookies })).statusCode).toBe(404);
    (app as any).prisma.tvChannel = {
      findUnique: async () => ({ id: "ch1", number: 1, name: "H", logoPath: null, country: null, quality: null, hidden: true, streams: [] }),
    };
    expect((await app.inject({ method: "GET", url: "/api/tv/channels/ch1/play", cookies })).statusCode).toBe(404);
    await app.close();
  });

  it("403s kids profiles (server-side, before any lookup)", async () => {
    const app = await buildTvApp(kidsProfile);
    expect((await app.inject({ method: "GET", url: "/api/tv/channels/ch1/play", cookies })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/tv/proxy/st1/index.m3u8", cookies })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/tv/streams/st1/health", cookies, payload: { ok: true } })).statusCode).toBe(403);
    await app.close();
  });
});

describe("GET /tv/proxy/* (fixture HLS origin end-to-end)", () => {
  it("rewrites master → media → segment through /p and /s with valid sigs", async () => {
    const app = await buildTvApp();
    (app as any).prisma.tvStream = {
      findUnique: async () => streamRow(),
      update: async () => ({}),
    };

    // 1) Entry playlist.
    const res1 = await app.inject({ method: "GET", url: "/api/tv/proxy/st1/index.m3u8", cookies });
    expect(res1.statusCode).toBe(200);
    expect(res1.headers["content-type"]).toContain("mpegurl");
    expect(res1.headers["cache-control"]).toBe("no-store");
    expect(seenHeaders["/master.m3u8"]?.["user-agent"]).toBe(BROWSER_UA); // null userAgent → pinned browser UA
    const masterOut = res1.body;
    expect(masterOut).toMatch(/#EXT-X-MEDIA:[^\n]*URI="\/api\/tv\/proxy\/st1\/p\?u=/); // alt audio → /p
    const pLine = masterOut.split("\n").find((l) => l.startsWith("/api/tv/proxy/st1/p?"));
    expect(pLine).toBeTruthy(); // variant URI line → /p

    // 2) Nested playlist through /p.
    const res2 = await app.inject({ method: "GET", url: pLine!, cookies });
    expect(res2.statusCode).toBe(200);
    expect(res2.headers["cache-control"]).toBe("no-store");
    const mediaOut = res2.body;
    expect(mediaOut).toMatch(/#EXT-X-KEY:[^\n]*URI="\/api\/tv\/proxy\/st1\/s\?u=/); // key → /s
    const sLine = mediaOut.split("\n").find((l) => l.startsWith("/api/tv/proxy/st1/s?"));
    expect(sLine).toBeTruthy(); // segment → /s

    // 3) Opaque bytes through /s.
    const res3 = await app.inject({ method: "GET", url: sLine!, cookies });
    expect(res3.statusCode).toBe(200);
    expect(res3.rawPayload.equals(SEGMENT_BYTES)).toBe(true);
    expect(res3.headers["content-type"]).toBe("video/mp2t");
    expect(res3.headers["content-length"]).toBe(String(SEGMENT_BYTES.length));
    expect(res3.headers["cache-control"]).toBe("no-store");
    await app.close();
  });

  it("403s a bad signature and a signature minted for another stream", async () => {
    const app = await buildTvApp();
    (app as any).prisma.tvStream = { findUnique: async () => streamRow(), update: async () => ({}) };
    const target = `http://${FIXTURE_HOST}:${port}/media.m3u8`;
    const u = encodeUpstream(target);

    const bad = await app.inject({ method: "GET", url: `/api/tv/proxy/st1/p?u=${u}&sig=${"A".repeat(32)}`, cookies });
    expect(bad.statusCode).toBe(403);
    expect(bad.json().error).toBe("bad_sig");

    const foreignSig = signProxyPayload(env.SESSION_SECRET, "other-stream", target);
    const foreign = await app.inject({ method: "GET", url: `/api/tv/proxy/st1/s?u=${u}&sig=${foreignSig}`, cookies });
    expect(foreign.statusCode).toBe(403);

    const missing = await app.inject({ method: "GET", url: `/api/tv/proxy/st1/p?u=${u}`, cookies });
    expect(missing.statusCode).toBe(403);
    await app.close();
  });

  it("502s upstream_404 and bumps failCount on upstream error status", async () => {
    const app = await buildTvApp();
    let captured: { data?: Record<string, unknown> } = {};
    (app as any).prisma.tvStream = {
      findUnique: async () => streamRow({ url: `http://${FIXTURE_HOST}:${port}/missing.m3u8` }),
      update: async (args: { data: Record<string, unknown> }) => { captured = args; return {}; },
    };
    const res = await app.inject({ method: "GET", url: "/api/tv/proxy/st1/index.m3u8", cookies });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("upstream_404");
    expect(captured.data).toMatchObject({ failCount: 1, status: "unknown" });
    await app.close();
  });

  it("rejects a private upstream with 502 through the REAL lookup path", async () => {
    const app = await buildTvApp(standardProfile, false); // NO tvUpstream override
    (app as any).prisma.tvStream = {
      findUnique: async () => streamRow({ url: `http://127.0.0.1:${port}/master.m3u8` }),
      update: async () => ({}),
    };
    const res = await app.inject({ method: "GET", url: "/api/tv/proxy/st1/index.m3u8", cookies });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("upstream_unreachable");
    await app.close();
  });

  it("404s a stream whose channel is hidden", async () => {
    const app = await buildTvApp();
    (app as any).prisma.tvStream = {
      findUnique: async () => streamRow({ channel: { hidden: true } }),
      update: async () => ({}),
    };
    const res = await app.inject({ method: "GET", url: "/api/tv/proxy/st1/index.m3u8", cookies });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("POST /tv/streams/:id/health", () => {
  async function bump(failCount: number, status: string, ok: boolean) {
    const app = await buildTvApp();
    let captured: { data?: Record<string, unknown> } = {};
    (app as any).prisma.tvStream = {
      findUnique: async () => ({ id: "st1", status, failCount }),
      update: async (args: { data: Record<string, unknown> }) => { captured = args; return {}; },
    };
    const res = await app.inject({
      method: "POST", url: "/api/tv/streams/st1/health", cookies,
      payload: ok ? { ok: true } : { ok: false, code: "fragLoadError" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
    return captured.data!;
  }

  it("ok:false keeps previous status below 3 failures", async () => {
    expect(await bump(1, "unknown", false)).toMatchObject({ failCount: 2, status: "unknown" });
  });
  it("ok:false escalates to degraded at 3", async () => {
    expect(await bump(2, "unknown", false)).toMatchObject({ failCount: 3, status: "degraded" });
  });
  it("ok:false escalates to dead at 8", async () => {
    expect(await bump(7, "degraded", false)).toMatchObject({ failCount: 8, status: "dead" });
  });
  it("ok:true resets to ok with failCount 0 and stamps lastOkAt", async () => {
    const data = await bump(5, "degraded", true);
    expect(data).toMatchObject({ status: "ok", failCount: 0 });
    expect(data.lastOkAt).toBeInstanceOf(Date);
    expect(data.lastCheckAt).toBeInstanceOf(Date);
  });
  it("404s an unknown stream", async () => {
    const app = await buildTvApp();
    (app as any).prisma.tvStream = { findUnique: async () => null, update: async () => ({}) };
    const res = await app.inject({ method: "POST", url: "/api/tv/streams/nope/health", cookies, payload: { ok: true } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
