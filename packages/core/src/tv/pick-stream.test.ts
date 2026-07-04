import { describe, it, expect } from "vitest";
import { classifyProtocol, orderStreams } from "./pick-stream";

describe("classifyProtocol", () => {
  it("classifies by URL extension, ignoring query strings and case", () => {
    expect(classifyProtocol("https://cdn.example/live/index.m3u8")).toBe("hls");
    expect(classifyProtocol("https://cdn.example/live/master.M3U8?token=abc")).toBe("hls");
    expect(classifyProtocol("https://cdn.example/dash/manifest.mpd")).toBe("dash");
    expect(classifyProtocol("http://203.0.113.7:8080/stream.ts")).toBe("other");
    expect(classifyProtocol("rtmp://cdn.example/live")).toBe("other");
  });
});

describe("orderStreams", () => {
  const streams = [
    { id: "dead", priority: 0, status: "dead", protocol: "hls" },
    { id: "dash", priority: 0, status: "ok", protocol: "dash" },
    { id: "degraded", priority: 0, status: "degraded", protocol: "hls" },
    { id: "unknown-p1", priority: 1, status: "unknown", protocol: "hls" },
    { id: "ok-p2", priority: 2, status: "ok", protocol: "hls" },
    { id: "ok-p1", priority: 1, status: "ok", protocol: "hls" },
  ];

  it("excludes dead and non-HLS, ranks ok > unknown > degraded, then priority asc", () => {
    expect(orderStreams(streams).map((s) => s.id)).toEqual([
      "ok-p1",
      "ok-p2",
      "unknown-p1",
      "degraded",
    ]);
  });

  it("does not mutate its input", () => {
    const before = streams.map((s) => s.id);
    orderStreams(streams);
    expect(streams.map((s) => s.id)).toEqual(before);
  });
});
