import { describe, it, expect, vi } from "vitest";
import { TvdbClient, TvdbError } from "./tvdb";

/** Build a fake fetch that returns queued JSON responses by URL substring. */
function fakeFetch(routes: { match: string; status?: number; body: unknown }[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const route = routes.find((r) => url.includes(r.match));
    if (!route) throw new Error(`no fake route for ${url}`);
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("TvdbClient auth + searchSeries", () => {
  it("logs in lazily and searches series", async () => {
    const fetchImpl = fakeFetch([
      { match: "/login", body: { status: "success", data: { token: "jwt-1" } } },
      {
        match: "/search",
        body: {
          status: "success",
          data: [{ tvdb_id: "121361", name: "Game of Thrones", year: "2011", image_url: "https://x/p.jpg" }],
        },
      },
    ]);
    const client = new TvdbClient("api-key", fetchImpl, "pin-1");
    const res = await client.searchSeries("Game of Thrones", 2011);
    expect(res).toEqual({ tvdbId: 121361, title: "Game of Thrones", year: 2011 });

    // login called once with apikey + pin; search carried the Bearer token
    const loginCall = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).includes("/login"),
    );
    expect(JSON.parse((loginCall![1] as RequestInit).body as string)).toEqual({ apikey: "api-key", pin: "pin-1" });
    const searchCall = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).includes("/search"),
    );
    expect((searchCall![1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer jwt-1" });
  });

  it("returns null when there are no results", async () => {
    const fetchImpl = fakeFetch([
      { match: "/login", body: { status: "success", data: { token: "jwt-1" } } },
      { match: "/search", body: { status: "success", data: [] } },
    ]);
    const client = new TvdbClient("k", fetchImpl);
    expect(await client.searchSeries("Nope")).toBeNull();
  });

  it("re-logs in once on a 401 and retries", async () => {
    let searchHits = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/login")) {
        return new Response(JSON.stringify({ status: "success", data: { token: "jwt-fresh" } }), { status: 200 });
      }
      searchHits++;
      if (searchHits === 1) return new Response("unauthorized", { status: 401 });
      return new Response(
        JSON.stringify({ status: "success", data: [{ tvdb_id: "9", name: "X", year: "2000" }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new TvdbClient("k", fetchImpl);
    const res = await client.searchSeries("X");
    expect(res?.tvdbId).toBe(9);
    expect(searchHits).toBe(2); // retried once
  });

  it("throws TvdbError on a non-401 error", async () => {
    const fetchImpl = fakeFetch([
      { match: "/login", body: { status: "success", data: { token: "t" } } },
      { match: "/search", status: 500, body: {} },
    ]);
    const client = new TvdbClient("k", fetchImpl);
    await expect(client.searchSeries("X")).rejects.toBeInstanceOf(TvdbError);
  });
});
