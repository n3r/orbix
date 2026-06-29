import { describe, it, expect } from "vitest";
import {
  CERT_TIERS,
  UNRATED_TIER,
  ratingTier,
  allowsRating,
  certsAtOrBelow,
} from "./maturity";

describe("CERT_TIERS", () => {
  it("maps G to 0", () => expect(CERT_TIERS["G"]).toBe(0));
  it("maps PG to 1", () => expect(CERT_TIERS["PG"]).toBe(1));
  it("maps PG-13 to 2", () => expect(CERT_TIERS["PG-13"]).toBe(2));
  it("maps R to 3", () => expect(CERT_TIERS["R"]).toBe(3));
  it("maps NC-17 to 4", () => expect(CERT_TIERS["NC-17"]).toBe(4));
});

describe("UNRATED_TIER", () => {
  it("is 99", () => expect(UNRATED_TIER).toBe(99));
});

describe("ratingTier", () => {
  it("PG === 1", () => expect(ratingTier("PG")).toBe(1));
  it("R === 3", () => expect(ratingTier("R")).toBe(3));
  it("NC-17 === 4", () => expect(ratingTier("NC-17")).toBe(4));
  it("G === 0", () => expect(ratingTier("G")).toBe(0));
  it("null === 99", () => expect(ratingTier(null)).toBe(99));
  it("undefined === 99", () => expect(ratingTier(undefined)).toBe(99));
  it("unknown string === 99", () => expect(ratingTier("Unrated")).toBe(99));
  it("pg-13 (lowercase) === 2", () => expect(ratingTier("pg-13")).toBe(2));
  it("PG13 variant === 2", () => expect(ratingTier("PG13")).toBe(2));
  it("NC17 variant === 4", () => expect(ratingTier("NC17")).toBe(4));
  it("trims whitespace", () => expect(ratingTier("  PG  ")).toBe(1));
});

describe("allowsRating", () => {
  it("null cap (unrestricted) allows R", () => expect(allowsRating(null, "R")).toBe(true));
  it("null cap allows null rating", () => expect(allowsRating(null, null)).toBe(true));
  it("undefined cap (unrestricted) allows R", () => expect(allowsRating(undefined, "R")).toBe(true));
  it("cap 2 allows PG-13", () => expect(allowsRating(2, "PG-13")).toBe(true));
  it("cap 2 blocks R", () => expect(allowsRating(2, "R")).toBe(false));
  it("cap 2 blocks null (unrated)", () => expect(allowsRating(2, null)).toBe(false));
  it("cap 0 allows G", () => expect(allowsRating(0, "G")).toBe(true));
  it("cap 0 blocks PG", () => expect(allowsRating(0, "PG")).toBe(false));
});

describe("certsAtOrBelow", () => {
  it("cap 2 returns G, PG, PG-13", () =>
    expect(certsAtOrBelow(2)).toEqual(["G", "PG", "PG-13"]));
  it("cap 0 returns only G", () =>
    expect(certsAtOrBelow(0)).toEqual(["G"]));
  it("cap 4 returns all five certs", () =>
    expect(certsAtOrBelow(4)).toEqual(["G", "PG", "PG-13", "R", "NC-17"]));
  it("cap 4 does not include an unrated entry", () =>
    expect(certsAtOrBelow(4)).not.toContain("Unrated"));
  it("results are in tier order", () =>
    expect(certsAtOrBelow(3)).toEqual(["G", "PG", "PG-13", "R"]));
});
