import { describe, it, expect } from "vitest";
import { buildSmartRows, type RowCatalogItem, type BuildRowsInput } from "./rows";

// ── Fixture helpers ───────────────────────────────────────────────────────────

/** Build a minimal features object keyed by director so our stub can identify it. */
const feat = (director: string): RowCatalogItem["features"] => ({
  genres: [],
  keywords: [],
  cast: [],
  director,
});

/**
 * Five catalog items:
 *   a1 – played, director D1 → the seed (history[0])
 *   b1 – unplayed, director D3 → sim(D1,D3)=0.9
 *   b2 – unplayed, director D4 → sim(D1,D4)=0.5
 *   b3 – unplayed, director D6 → sim(D1,D6)=0.5  ← same score as b2 (tiebreak test)
 *   c1 – unplayed, director D5 → sim(D1,D5)=0.1
 */
const catalog: RowCatalogItem[] = [
  { id: "a1", title: "Movie A1", features: feat("D1"), playedByProfile: true },
  { id: "b1", title: "Movie B1", features: feat("D3"), playedByProfile: false },
  { id: "b2", title: "Movie B2", features: feat("D4"), playedByProfile: false },
  { id: "b3", title: "Movie B3", features: feat("D6"), playedByProfile: false },
  { id: "c1", title: "Movie C1", features: feat("D5"), playedByProfile: false },
];

/** Stub: returns predetermined scores based on director tags only. */
const simOf = (
  a: RowCatalogItem["features"],
  b: RowCatalogItem["features"],
): number => {
  if (a.director === "D1" && b.director === "D3") return 0.9;
  if (a.director === "D1" && b.director === "D4") return 0.5;
  if (a.director === "D1" && b.director === "D6") return 0.5;
  if (a.director === "D1" && b.director === "D5") return 0.1;
  // symmetric fallback (used when history drives hiddenGems)
  if (a.director === "D3" && b.director === "D1") return 0.9;
  if (a.director === "D4" && b.director === "D1") return 0.5;
  if (a.director === "D6" && b.director === "D1") return 0.5;
  if (a.director === "D5" && b.director === "D1") return 0.1;
  return 0;
};

const history = [{ mediaItemId: "a1", title: "Movie A1" }];
const continueWatching = [{ mediaItemId: "cw1" }, { mediaItemId: "cw2" }];

const baseInput: BuildRowsInput = {
  continueWatching,
  history,
  catalog,
  simOf,
  limit: 20,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function rowByKey(rows: ReturnType<typeof buildSmartRows>, key: string) {
  return rows.find((r) => r.key === key);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("buildSmartRows", () => {
  describe("continue row", () => {
    it("contains continueWatching ids in order", () => {
      const rows = buildSmartRows(baseInput);
      const row = rowByKey(rows, "continue");
      expect(row).toBeDefined();
      expect(row!.title).toBe("Continue Watching");
      expect(row!.itemIds).toEqual(["cw1", "cw2"]);
    });

    it("is omitted when continueWatching is empty", () => {
      const rows = buildSmartRows({ ...baseInput, continueWatching: [] });
      expect(rowByKey(rows, "continue")).toBeUndefined();
    });
  });

  describe("becauseYouWatched row", () => {
    it("title includes history[0] title", () => {
      const rows = buildSmartRows(baseInput);
      const row = rowByKey(rows, "becauseYouWatched");
      expect(row).toBeDefined();
      expect(row!.title).toBe("Because you watched Movie A1");
    });

    it("excludes played items and the seed", () => {
      const rows = buildSmartRows(baseInput);
      const row = rowByKey(rows, "becauseYouWatched");
      expect(row!.itemIds).not.toContain("a1"); // seed (played)
    });

    it("orders by stub score desc, then id asc as tiebreak", () => {
      const rows = buildSmartRows(baseInput);
      const row = rowByKey(rows, "becauseYouWatched");
      // b1=0.9, b2=0.5 ("b2"<"b3"), b3=0.5, c1=0.1
      expect(row!.itemIds).toEqual(["b1", "b2", "b3", "c1"]);
    });

    it("is omitted when history is empty", () => {
      const rows = buildSmartRows({ ...baseInput, history: [] });
      expect(rowByKey(rows, "becauseYouWatched")).toBeUndefined();
    });

    it("is omitted when the seed is not in catalog", () => {
      const rows = buildSmartRows({
        ...baseInput,
        history: [{ mediaItemId: "zzz", title: "Unknown" }],
      });
      expect(rowByKey(rows, "becauseYouWatched")).toBeUndefined();
    });

    it("respects the limit option", () => {
      const rows = buildSmartRows({ ...baseInput, limit: 2 });
      const row = rowByKey(rows, "becauseYouWatched");
      expect(row!.itemIds.length).toBeLessThanOrEqual(2);
      expect(row!.itemIds).toEqual(["b1", "b2"]); // top 2 by score
    });
  });

  describe("hiddenGems row", () => {
    it("contains only unplayed items", () => {
      const rows = buildSmartRows(baseInput);
      const row = rowByKey(rows, "hiddenGems");
      expect(row).toBeDefined();
      expect(row!.title).toBe("Hidden gems");
      expect(row!.itemIds).not.toContain("a1"); // played
    });

    it("orders by max-sim-to-history desc, then id asc tiebreak", () => {
      const rows = buildSmartRows(baseInput);
      const row = rowByKey(rows, "hiddenGems");
      // b1=0.9, b2=0.5 ("b2"<"b3"), b3=0.5, c1=0.1
      expect(row!.itemIds).toEqual(["b1", "b2", "b3", "c1"]);
    });

    it("falls back to id asc when history is empty", () => {
      const rows = buildSmartRows({ ...baseInput, history: [] });
      const row = rowByKey(rows, "hiddenGems");
      expect(row).toBeDefined();
      // all scores = 0, so sort by id ASC
      expect(row!.itemIds).toEqual(["b1", "b2", "b3", "c1"]);
    });

    it("is omitted when there are no unplayed items", () => {
      const allPlayed = catalog.map((c) => ({ ...c, playedByProfile: true }));
      const rows = buildSmartRows({ ...baseInput, catalog: allPlayed });
      expect(rowByKey(rows, "hiddenGems")).toBeUndefined();
    });
  });

  describe("tonight row", () => {
    it("contains only unplayed items", () => {
      const rows = buildSmartRows(baseInput);
      const row = rowByKey(rows, "tonight");
      expect(row).toBeDefined();
      expect(row!.title).toBe("Pick something for tonight");
      expect(row!.itemIds).not.toContain("a1");
    });

    it("orders by score desc, then id DESC as tiebreak (differs from hiddenGems)", () => {
      const rows = buildSmartRows(baseInput);
      const row = rowByKey(rows, "tonight");
      // b1=0.9, then 0.5 tie: "b3" > "b2" DESC, then c1=0.1
      expect(row!.itemIds).toEqual(["b1", "b3", "b2", "c1"]);
    });

    it("caps at min(limit, 10)", () => {
      // With limit=20 and only 4 unplayed items, we get all 4
      const rows = buildSmartRows(baseInput);
      const row = rowByKey(rows, "tonight");
      expect(row!.itemIds.length).toBeLessThanOrEqual(10);
    });

    it("is omitted when there are no unplayed items", () => {
      const allPlayed = catalog.map((c) => ({ ...c, playedByProfile: true }));
      const rows = buildSmartRows({ ...baseInput, catalog: allPlayed });
      expect(rowByKey(rows, "tonight")).toBeUndefined();
    });
  });

  describe("row ordering", () => {
    it("emits rows in the specified order: continue, because, gems, tonight", () => {
      const rows = buildSmartRows(baseInput);
      const keys = rows.map((r) => r.key);
      expect(keys).toEqual(["continue", "becauseYouWatched", "hiddenGems", "tonight"]);
    });

    it("skips only the rows that are empty; keeps others in order", () => {
      const rows = buildSmartRows({ ...baseInput, continueWatching: [], history: [] });
      const keys = rows.map((r) => r.key);
      // no continue, no becauseYouWatched; gems and tonight still present
      expect(keys).toEqual(["hiddenGems", "tonight"]);
    });
  });

  describe("determinism", () => {
    it("calling twice with the same input yields deepEqual results", () => {
      const first = buildSmartRows(baseInput);
      const second = buildSmartRows(baseInput);
      expect(first).toEqual(second);
    });
  });
});
