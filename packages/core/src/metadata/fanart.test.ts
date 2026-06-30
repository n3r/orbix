import { describe, it, expect } from "vitest";
import { pickFanartLogoUrl, fetchFanartLogoUrl } from "./fanart";

describe("pickFanartLogoUrl", () => {
  it("prefers HD logo in the requested language by likes", () => {
    const url = pickFanartLogoUrl({
      hdmovielogo: [
        { url: "en-low", lang: "en", likes: "3" },
        { url: "en-high", lang: "en", likes: "9" },
        { url: "de", lang: "de", likes: "20" },
      ],
    });
    expect(url).toBe("en-high");
  });

  it("falls back to English then to most-liked any when language is absent", () => {
    expect(pickFanartLogoUrl({ movielogo: [{ url: "en", lang: "en", likes: "1" }] }, "fr")).toBe("en");
    expect(
      pickFanartLogoUrl({ hdmovielogo: [{ url: "jp", lang: "jp", likes: "5" }, { url: "ru", lang: "ru", likes: "2" }] }, "fr"),
    ).toBe("jp");
  });

  it("returns undefined when there are no logos", () => {
    expect(pickFanartLogoUrl({})).toBeUndefined();
  });
});

describe("fetchFanartLogoUrl", () => {
  it("returns undefined without a key", async () => {
    const fetchImpl = (() => {
      throw new Error("nope");
    }) as unknown as typeof fetch;
    expect(await fetchFanartLogoUrl({ tmdbId: 1 }, { fetchImpl, apiKey: "" })).toBeUndefined();
  });

  it("fetches and picks a logo by tmdbId", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => ({ hdmovielogo: [{ url: "best", lang: "en", likes: "10" }] }),
    })) as unknown as typeof fetch;
    expect(await fetchFanartLogoUrl({ tmdbId: 603 }, { fetchImpl, apiKey: "k" })).toBe("best");
  });
});
