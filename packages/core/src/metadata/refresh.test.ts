import { describe, it, expect } from "vitest";
import { selectStaleItems } from "./refresh";

// Fixed reference point for all tests
const NOW = new Date("2026-06-30T00:00:00Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

describe("selectStaleItems", () => {
  it("includes matched items older than cadence", () => {
    const items = [{ id: "a", updatedAt: daysAgo(100), matchState: "matched", tmdbId: 1 }];
    expect(selectStaleItems(items, 90, NOW)).toEqual(["a"]);
  });

  it("includes manual items older than cadence", () => {
    const items = [{ id: "b", updatedAt: daysAgo(95), matchState: "manual", tmdbId: 2 }];
    expect(selectStaleItems(items, 90, NOW)).toEqual(["b"]);
  });

  it("excludes items newer than or equal to cadence", () => {
    const items = [
      { id: "c", updatedAt: daysAgo(89), matchState: "matched", tmdbId: 3 },
      { id: "d", updatedAt: daysAgo(90), matchState: "matched", tmdbId: 4 }, // exactly at cutoff
    ];
    expect(selectStaleItems(items, 90, NOW)).toEqual([]);
  });

  it("excludes unmatched items regardless of age", () => {
    const items = [{ id: "e", updatedAt: daysAgo(200), matchState: "unmatched", tmdbId: 5 }];
    expect(selectStaleItems(items, 90, NOW)).toEqual([]);
  });

  it("excludes items with null tmdbId", () => {
    const items = [{ id: "f", updatedAt: daysAgo(200), matchState: "matched", tmdbId: null }];
    expect(selectStaleItems(items, 90, NOW)).toEqual([]);
  });

  it("handles mixed items correctly", () => {
    const items = [
      { id: "stale-matched", updatedAt: daysAgo(100), matchState: "matched", tmdbId: 10 },
      { id: "stale-manual",  updatedAt: daysAgo(91),  matchState: "manual",  tmdbId: 11 },
      { id: "fresh-matched", updatedAt: daysAgo(50),  matchState: "matched", tmdbId: 12 },
      { id: "unmatched-old", updatedAt: daysAgo(500), matchState: "unmatched", tmdbId: 13 },
      { id: "no-tmdb",       updatedAt: daysAgo(200), matchState: "matched", tmdbId: null },
    ];
    const result = selectStaleItems(items, 90, NOW);
    expect(result).toContain("stale-matched");
    expect(result).toContain("stale-manual");
    expect(result).not.toContain("fresh-matched");
    expect(result).not.toContain("unmatched-old");
    expect(result).not.toContain("no-tmdb");
    expect(result).toHaveLength(2);
  });

  it("returns empty array when no items", () => {
    expect(selectStaleItems([], 90, NOW)).toEqual([]);
  });

  it("respects different cadenceDays values", () => {
    const items = [
      { id: "g", updatedAt: daysAgo(10), matchState: "matched", tmdbId: 20 },
      { id: "h", updatedAt: daysAgo(40), matchState: "matched", tmdbId: 21 },
    ];
    // cadence=7: item 10 days old is stale
    expect(selectStaleItems(items, 7, NOW)).toContain("g");
    // cadence=30: item 10 days old is not stale, 40 days is stale
    const result30 = selectStaleItems(items, 30, NOW);
    expect(result30).not.toContain("g");
    expect(result30).toContain("h");
  });

  it("is deterministic with the same inputs", () => {
    const items = [{ id: "i", updatedAt: daysAgo(100), matchState: "matched", tmdbId: 99 }];
    const r1 = selectStaleItems(items, 90, NOW);
    const r2 = selectStaleItems(items, 90, NOW);
    expect(r1).toEqual(r2);
  });
});
