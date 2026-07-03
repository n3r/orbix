import { describe, it, expect } from "vitest";
import { planTmdbDedup, planSeriesDedup, type DedupeCandidate } from "./dedupe";

const item = (over: Partial<DedupeCandidate> & { id: string }): DedupeCandidate => ({
  libraryId: "lib1",
  kind: "movie",
  tmdbId: 2048,
  addedAt: 0,
  ...over,
});

describe("planTmdbDedup", () => {
  it("keeps an item that has no siblings", () => {
    expect(planTmdbDedup(item({ id: "a" }), [])).toEqual({ action: "keep" });
  });

  it("keeps an item that is not yet matched (tmdbId null)", () => {
    const a = item({ id: "a", tmdbId: null });
    const b = item({ id: "b", tmdbId: null });
    expect(planTmdbDedup(a, [b])).toEqual({ action: "keep" });
  });

  it("merges two items sharing a tmdbId in the same library, keeping the older", () => {
    const older = item({ id: "old", addedAt: 100 });
    const newer = item({ id: "new", addedAt: 200 });
    // The newer one is being enriched; the older already carries the tmdbId.
    expect(planTmdbDedup(newer, [older])).toEqual({
      action: "merge",
      canonicalId: "old",
      obsoleteIds: ["new"],
    });
  });

  it("keeps the current item as canonical when it is the oldest", () => {
    const older = item({ id: "old", addedAt: 100 });
    const newer = item({ id: "new", addedAt: 200 });
    expect(planTmdbDedup(older, [newer])).toEqual({
      action: "merge",
      canonicalId: "old",
      obsoleteIds: ["new"],
    });
  });

  it("does NOT merge items with different tmdbIds even if titles match", () => {
    // Hellboy 2004 (1487) vs Hellboy 2019 (456740): same title, distinct films.
    const hellboy2004 = item({ id: "h04", tmdbId: 1487 });
    const hellboy2019 = item({ id: "h19", tmdbId: 456740 });
    expect(planTmdbDedup(hellboy2004, [hellboy2019])).toEqual({ action: "keep" });
  });

  it("does NOT merge the same tmdbId across different libraries", () => {
    const a = item({ id: "a", libraryId: "lib1" });
    const b = item({ id: "b", libraryId: "lib2" });
    expect(planTmdbDedup(a, [b])).toEqual({ action: "keep" });
  });

  it("does NOT merge the same tmdbId across different kinds", () => {
    const movie = item({ id: "m", kind: "movie" });
    const series = item({ id: "s", kind: "series" });
    expect(planTmdbDedup(movie, [series])).toEqual({ action: "keep" });
  });

  it("collapses a three-way collision into one canonical, listing the rest obsolete", () => {
    const a = item({ id: "a", addedAt: 100 });
    const b = item({ id: "b", addedAt: 200 });
    const c = item({ id: "c", addedAt: 300 });
    expect(planTmdbDedup(b, [a, c])).toEqual({
      action: "merge",
      canonicalId: "a",
      obsoleteIds: ["b", "c"],
    });
  });

  it("ignores unrelated items in the same library", () => {
    const target = item({ id: "a", tmdbId: 2048, addedAt: 100 });
    const other = item({ id: "b", tmdbId: 603, addedAt: 200 });
    expect(planTmdbDedup(target, [other])).toEqual({ action: "keep" });
  });
});

describe("planSeriesDedup", () => {
  const base = { libraryId: "lib", addedAt: 100 };

  it("collides on a shared tvdbId", () => {
    const plan = planSeriesDedup(
      { ...base, id: "b", tvdbId: 275274, tmdbId: null, addedAt: 200 },
      [{ ...base, id: "a", tvdbId: 275274, tmdbId: 60625 }],
    );
    expect(plan).toEqual({ action: "merge", canonicalId: "a", obsoleteIds: ["b"] });
  });

  it("collides on a shared tmdbId when tvdb ids are absent (TMDB-fallback rows)", () => {
    const plan = planSeriesDedup(
      { ...base, id: "b", tvdbId: null, tmdbId: 60625, addedAt: 200 },
      [{ ...base, id: "a", tvdbId: 275274, tmdbId: 60625 }],
    );
    expect(plan).toEqual({ action: "merge", canonicalId: "a", obsoleteIds: ["b"] });
  });

  it("keeps distinct series apart", () => {
    const plan = planSeriesDedup(
      { ...base, id: "b", tvdbId: 79551, tmdbId: 19566 },
      [{ ...base, id: "a", tvdbId: 447184, tmdbId: 90228 }],
    );
    expect(plan).toEqual({ action: "keep" });
  });

  it("never merges across libraries", () => {
    const plan = planSeriesDedup(
      { ...base, id: "b", tvdbId: 275274, tmdbId: null },
      [{ id: "a", libraryId: "other", tvdbId: 275274, tmdbId: null, addedAt: 1 }],
    );
    expect(plan).toEqual({ action: "keep" });
  });

  it("collapses a whole group onto the earliest-added item", () => {
    const plan = planSeriesDedup(
      { ...base, id: "c", tvdbId: 78650, tmdbId: null, addedAt: 300 },
      [
        { ...base, id: "b", tvdbId: 78650, tmdbId: 236, addedAt: 200 },
        { ...base, id: "a", tvdbId: 78650, tmdbId: 236, addedAt: 100 },
      ],
    );
    expect(plan).toEqual({ action: "merge", canonicalId: "a", obsoleteIds: ["b", "c"] });
  });

  it("keeps items with no provider ids", () => {
    const plan = planSeriesDedup({ ...base, id: "b", tvdbId: null, tmdbId: null }, [
      { ...base, id: "a", tvdbId: null, tmdbId: null },
    ]);
    expect(plan).toEqual({ action: "keep" });
  });
});
