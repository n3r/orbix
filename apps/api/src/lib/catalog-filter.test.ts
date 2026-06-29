import { describe, it, expect } from "vitest";
import { kidsRatingWhere, profileAllowsItem } from "./catalog-filter";

// ── kidsRatingWhere ───────────────────────────────────────────────────────────

describe("kidsRatingWhere", () => {
  it("returns null for a null profile", () => {
    expect(kidsRatingWhere(null)).toBeNull();
  });

  it("returns null for a standard profile (regardless of maturityCap)", () => {
    expect(kidsRatingWhere({ kind: "standard", maturityCap: null })).toBeNull();
    expect(kidsRatingWhere({ kind: "standard", maturityCap: 3 })).toBeNull();
  });

  it("returns null for a kids profile with null maturityCap (unrestricted)", () => {
    expect(kidsRatingWhere({ kind: "kids", maturityCap: null })).toBeNull();
  });

  it("kids cap=2 (PG-13) → rating in ['G','PG','PG-13']", () => {
    expect(kidsRatingWhere({ kind: "kids", maturityCap: 2 })).toEqual({
      rating: { in: ["G", "PG", "PG-13"] },
    });
  });

  it("kids cap=0 (G only) → rating in ['G']", () => {
    expect(kidsRatingWhere({ kind: "kids", maturityCap: 0 })).toEqual({
      rating: { in: ["G"] },
    });
  });

  it("kids cap=1 (PG) → rating in ['G','PG']", () => {
    expect(kidsRatingWhere({ kind: "kids", maturityCap: 1 })).toEqual({
      rating: { in: ["G", "PG"] },
    });
  });
});

// ── profileAllowsItem ─────────────────────────────────────────────────────────

describe("profileAllowsItem", () => {
  const kidsCapPG13 = { kind: "kids", maturityCap: 2 };
  const standard = { kind: "standard", maturityCap: null as number | null };

  it("null profile → always allows", () => {
    expect(profileAllowsItem(null, { rating: "R" })).toBe(true);
    expect(profileAllowsItem(null, { rating: null })).toBe(true);
  });

  it("standard profile → always allows", () => {
    expect(profileAllowsItem(standard, { rating: "R" })).toBe(true);
    expect(profileAllowsItem(standard, { rating: "NC-17" })).toBe(true);
    expect(profileAllowsItem(standard, { rating: null })).toBe(true);
  });

  it("kids cap=2 → allows G, PG, PG-13", () => {
    expect(profileAllowsItem(kidsCapPG13, { rating: "G" })).toBe(true);
    expect(profileAllowsItem(kidsCapPG13, { rating: "PG" })).toBe(true);
    expect(profileAllowsItem(kidsCapPG13, { rating: "PG-13" })).toBe(true);
  });

  it("kids cap=2 → blocks R", () => {
    expect(profileAllowsItem(kidsCapPG13, { rating: "R" })).toBe(false);
  });

  it("kids cap=2 → blocks NC-17", () => {
    expect(profileAllowsItem(kidsCapPG13, { rating: "NC-17" })).toBe(false);
  });

  it("kids cap=2 → blocks unrated (null)", () => {
    expect(profileAllowsItem(kidsCapPG13, { rating: null })).toBe(false);
  });
});
