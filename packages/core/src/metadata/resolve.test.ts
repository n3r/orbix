import { describe, it, expect, vi } from "vitest";
import { resolveTitle, type ResolveCandidate, type ResolveDeps } from "./resolve";

/** Deps whose search returns fixed candidates per matching query substring. */
function fakeDeps(routes: { match: RegExp; results: ResolveCandidate[] }[], allTitles: Record<number, string[]> = {}) {
  const search = vi.fn(async (query: string) => {
    const route = routes.find((r) => r.match.test(query));
    return route ? route.results : [];
  });
  const deps: ResolveDeps = {
    search,
    allTitles: vi.fn(async (id: number) => allTitles[id] ?? []),
  };
  return { deps, search };
}

describe("resolveTitle — title variants", () => {
  it("matches through a variant when the primary title fails the gate", async () => {
    const hotd: ResolveCandidate = { id: 94997, title: "House of the Dragon", year: 2022, voteCount: 5000 };
    const { deps } = fakeDeps([{ match: /house of the dragon/i, results: [hotd] }]);
    const id = await resolveTitle("House of Dragons", undefined, deps, {
      variants: ["House of the Dragon"],
    });
    expect(id).toBe(94997);
  });

  it("still resolves the primary title without consulting variants when it matches", async () => {
    const dune: ResolveCandidate = { id: 90228, title: "Dune: Prophecy", year: 2024, voteCount: 500 };
    const { deps, search } = fakeDeps([{ match: /dune/i, results: [dune] }]);
    const id = await resolveTitle("Dune Prophecy", undefined, deps, { variants: ["Dune"] });
    expect(id).toBe(90228);
    const queried = search.mock.calls.map((c) => c[0]);
    expect(queried.some((q) => /prophecy/i.test(q))).toBe(true);
  });
});

describe("resolveTitle — season-shape disambiguation", () => {
  const shogun2024: ResolveCandidate = { id: 126308, title: "Shōgun", year: 2024, voteCount: 2000 };
  const shogun1980: ResolveCandidate = { id: 13862, title: "Shogun", year: 1980, voteCount: 300 };
  const shapes: Record<number, { seasonNumber: number; episodeCount: number }[]> = {
    126308: [{ seasonNumber: 1, episodeCount: 10 }],
    13862: [{ seasonNumber: 1, episodeCount: 5 }],
  };

  it("prefers the candidate whose seasons fit the local files (year unknown)", async () => {
    // Provider returns the WRONG namesake first — exactly the live TVDB trap.
    const { deps } = fakeDeps([{ match: /shogun/i, results: [shogun1980, shogun2024] }]);
    const id = await resolveTitle("Shogun", undefined, deps, {
      localShape: [{ seasonNumber: 1, episodeCount: 10, maxEpisode: 10 }],
      seasonShape: async (id) => shapes[id] ?? [],
    });
    expect(id).toBe(126308);
  });

  it("falls back to rank order (popularity tiebreak) when shape deps are absent", async () => {
    const { deps } = fakeDeps([{ match: /shogun/i, results: [shogun1980, shogun2024] }]);
    const id = await resolveTitle("Shogun", undefined, deps, {});
    expect(id).toBe(126308);
  });

  it("does not spend shape calls when only one candidate clears the gate", async () => {
    const seasonShape = vi.fn(async () => [{ seasonNumber: 1, episodeCount: 10 }]);
    const { deps } = fakeDeps([{ match: /shogun/i, results: [shogun2024] }]);
    const id = await resolveTitle("Shogun", undefined, deps, {
      localShape: [{ seasonNumber: 1, episodeCount: 10, maxEpisode: 10 }],
      seasonShape,
    });
    expect(id).toBe(126308);
    expect(seasonShape).not.toHaveBeenCalled();
  });

  it("keeps exact-year dominance when the item has a year (no shape calls)", async () => {
    const seasonShape = vi.fn(async () => []);
    const { deps } = fakeDeps([{ match: /shogun/i, results: [shogun1980, shogun2024] }]);
    const id = await resolveTitle("Shogun", 2024, deps, {
      localShape: [{ seasonNumber: 1, episodeCount: 10, maxEpisode: 10 }],
      seasonShape,
    });
    expect(id).toBe(126308);
    expect(seasonShape).not.toHaveBeenCalled();
  });

  it("survives a failing shape fetch by falling back to rank order", async () => {
    const { deps } = fakeDeps([{ match: /shogun/i, results: [shogun1980, shogun2024] }]);
    const id = await resolveTitle("Shogun", undefined, deps, {
      localShape: [{ seasonNumber: 1, episodeCount: 10, maxEpisode: 10 }],
      seasonShape: async () => {
        throw new Error("boom");
      },
    });
    expect(id).toBe(126308);
  });
});

describe("resolveTitle — deep-check year sanity", () => {
  it("rejects an alt-title STRONG match decades away from the item year", async () => {
    // The Batya trap: "Batya" (2020 file) must not deep-check into a 1974
    // namesake carrying "Batya" among its alternative titles.
    const filipino: ResolveCandidate = { id: 111, title: "Batya't Palu-Palo", year: 1974, voteCount: 12 };
    const { deps } = fakeDeps([{ match: /batya/i, results: [filipino] }], { 111: ["Batya", "Palu-Palo"] });
    const id = await resolveTitle("Batya", 2020, deps);
    expect(id).toBeUndefined();
  });

  it("still deep-checks within a one-year tolerance", async () => {
    const ru: ResolveCandidate = { id: 222, title: "Батя", year: 2021, voteCount: 120 };
    const { deps } = fakeDeps([{ match: /batya/i, results: [ru] }], { 222: ["Батя", "Batya"] });
    const id = await resolveTitle("Batya", 2020, deps);
    expect(id).toBe(222);
  });

  it("lets a well-known film verify via alt-title within a few years (rebrand rips)", async () => {
    // "Live.Die.Repeat.2016.mkv" — Edge of Tomorrow (2014, huge vote count)
    // rebranded for home video; the 2-year gap must not block the deep check.
    const eot: ResolveCandidate = { id: 137113, title: "Edge of Tomorrow", year: 2014, voteCount: 15000 };
    const { deps } = fakeDeps([{ match: /live die repeat/i, results: [eot] }], {
      137113: ["Edge of Tomorrow", "Live Die Repeat", "Live. Die. Repeat."],
    });
    const id = await resolveTitle("Live Die Repeat", 2016, deps);
    expect(id).toBe(137113);
  });

  it("still blocks an OBSCURE alt-title namesake a few years off", async () => {
    const obscure: ResolveCandidate = { id: 444, title: "Something Else Entirely", year: 2017, voteCount: 8 };
    const { deps } = fakeDeps([{ match: /rare film/i, results: [obscure] }], { 444: ["Rare Film"] });
    const id = await resolveTitle("Rare Film", 2020, deps);
    expect(id).toBeUndefined();
  });

  it("keeps year-less items deep-checking as before", async () => {
    const ru: ResolveCandidate = { id: 333, title: "Совсем другое имя", year: 1999, voteCount: 200 };
    const { deps } = fakeDeps([{ match: /other/i, results: [ru] }], { 333: ["The Other Name"] });
    const id = await resolveTitle("The Other Name", undefined, deps);
    expect(id).toBe(333);
  });
});
