import { describe, expect, it } from "vitest";
import { cosine, rankByVector } from "./rank";

describe("cosine", () => {
  it("returns 1 for identical unit vectors", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("returns -1 for opposite unit vectors", () => {
    expect(cosine([1, 1], [-1, -1])).toBeCloseTo(-1);
  });

  it("returns 0 for a zero vector (no NaN)", () => {
    const result = cosine([0, 0], [1, 2]);
    expect(result).toBe(0);
    expect(Number.isNaN(result)).toBe(false);
  });

  it("returns 0 for length mismatch", () => {
    expect(cosine([1, 2, 3], [1, 2])).toBe(0);
  });
});

describe("rankByVector", () => {
  it("orders by similarity DESC, tiebreaks by id ASC, respects k", () => {
    const result = rankByVector(
      [1, 0],
      [
        { id: "a", vector: [1, 0] },
        { id: "b", vector: [0, 1] },
        { id: "c", vector: [1, 0] },
      ],
      2
    );

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("a");
    expect(result[0].score).toBeCloseTo(1);
    expect(result[1].id).toBe("c");
    expect(result[1].score).toBeCloseTo(1);
    // "b" is excluded because k=2 and it has the lowest score
  });

  it("is deterministic: two calls produce deepEqual results", () => {
    const query = [1, 0];
    const candidates = [
      { id: "x", vector: [1, 0] },
      { id: "y", vector: [1, 0] },
      { id: "z", vector: [0, 1] },
    ];
    const first = rankByVector(query, candidates, 3);
    const second = rankByVector(query, candidates, 3);
    expect(first).toEqual(second);
  });

  it("sorts tied scores by id ASC", () => {
    const result = rankByVector(
      [1, 0],
      [
        { id: "z", vector: [1, 0] },
        { id: "a", vector: [1, 0] },
        { id: "m", vector: [1, 0] },
      ],
      3
    );
    expect(result.map((r) => r.id)).toEqual(["a", "m", "z"]);
  });

  it("returns top k when k < candidates length", () => {
    const result = rankByVector(
      [1, 0],
      [
        { id: "high", vector: [1, 0] },
        { id: "low", vector: [0, 1] },
      ],
      1
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("high");
  });
});
