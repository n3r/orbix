import { describe, it, expect } from "vitest";
import { cleanChannelName } from "./clean-name";

describe("cleanChannelName", () => {
  it("strips a country prefix and resolves quality (resolution beats HD word)", () => {
    expect(cleanChannelName("RU| ПЕРВЫЙ HD 1080p")).toEqual({
      name: "ПЕРВЫЙ",
      quality: "1080p",
      label: null,
    });
  });

  it("extracts a parenthesised resolution", () => {
    expect(cleanChannelName("2x2 (576i)")).toEqual({ name: "2x2", quality: "576i", label: null });
  });

  it("extracts bracketed status labels", () => {
    expect(cleanChannelName("Fashion TV [Not 24/7]")).toEqual({
      name: "Fashion TV",
      quality: null,
      label: "Not 24/7",
    });
    expect(cleanChannelName("MTV 00s [Geo-blocked]")).toEqual({
      name: "MTV 00s",
      quality: null,
      label: "Geo-blocked",
    });
  });

  it("uses a quality word when no resolution token is present", () => {
    expect(cleanChannelName("CNN HD")).toEqual({ name: "CNN", quality: "HD", label: null });
  });

  it("is idempotent on already-clean names", () => {
    for (const name of ["ПЕРВЫЙ", "2x2", "BBC One", "France 24"]) {
      expect(cleanChannelName(name)).toEqual({ name, quality: null, label: null });
    }
  });

  it("falls back to the raw name when cleaning would empty it", () => {
    expect(cleanChannelName("HD").name).toBe("HD");
  });
});
