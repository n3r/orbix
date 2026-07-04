import { describe, it, expect, vi } from "vitest";
import { fetchIptvOrgFile, type IptvOrgDeps } from "./iptv-org";

function memoryDeps(fetchImpl: typeof fetch) {
  const etags = new Map<string, string>();
  const cache = new Map<string, string>();
  const deps: IptvOrgDeps = {
    fetchImpl,
    readEtag: async (f) => etags.get(f) ?? null,
    writeEtag: async (f, tag) => {
      etags.set(f, tag);
    },
    readCache: async (f) => cache.get(f) ?? null,
    writeCache: async (f, text) => {
      cache.set(f, text);
    },
  };
  return { deps, etags, cache };
}

describe("fetchIptvOrgFile", () => {
  it("fetches unconditionally the first time, stores the ETag + body cache, and parses", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify([{ id: "ChannelOne.ru" }]), {
          status: 200,
          headers: { etag: 'W/"v1"' },
        }),
    ) as unknown as typeof fetch;
    const { deps, etags, cache } = memoryDeps(fetchImpl);

    const data = await fetchIptvOrgFile<{ id: string }[]>("channels.json", deps);
    expect(data).toEqual([{ id: "ChannelOne.ru" }]);
    expect(etags.get("channels.json")).toBe('W/"v1"');
    expect(cache.get("channels.json")).toBe(JSON.stringify([{ id: "ChannelOne.ru" }]));
    const firstInit = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(firstInit).toBeUndefined(); // no If-None-Match without a stored ETag
  });

  it("sends If-None-Match and short-circuits to the parsed cache on 304", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 304 })) as unknown as typeof fetch;
    const { deps, etags, cache } = memoryDeps(fetchImpl);
    etags.set("streams.json", 'W/"v7"');
    cache.set("streams.json", JSON.stringify([{ url: "https://x/live.m3u8" }]));

    const data = await fetchIptvOrgFile<{ url: string }[]>("streams.json", deps);
    expect(data).toEqual([{ url: "https://x/live.m3u8" }]);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toBe("https://iptv-org.github.io/api/streams.json");
    expect((init as RequestInit).headers).toEqual({ "if-none-match": 'W/"v7"' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refetches unconditionally when a 304 hits a lost cache", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) return new Response(null, { status: 304 });
      return new Response(JSON.stringify([1, 2]), { status: 200, headers: { etag: 'W/"v8"' } });
    }) as unknown as typeof fetch;
    const { deps, etags } = memoryDeps(fetchImpl);
    etags.set("logos.json", 'W/"v7"'); // the ETag survived but the disk cache did not

    const data = await fetchIptvOrgFile<number[]>("logos.json", deps);
    expect(data).toEqual([1, 2]);
    expect(calls).toBe(2);
    const secondInit = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1][1];
    expect(secondInit).toBeUndefined(); // the retry carries no If-None-Match
    expect(etags.get("logos.json")).toBe('W/"v8"');
  });

  it("throws on a non-OK response", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    const { deps } = memoryDeps(fetchImpl);
    await expect(fetchIptvOrgFile("blocklist.json", deps)).rejects.toThrow(/503/);
  });
});
