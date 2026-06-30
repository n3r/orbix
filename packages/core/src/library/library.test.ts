import { describe, it, expect } from "vitest";
import { validateSourceInput, validateLibraryInput, validateLibraryPatch, LibraryValidationError } from "./library";

describe("validateLibraryInput", () => {
  it("accepts a valid name", () => {
    expect(validateLibraryInput({ name: "Movies" }).name).toBe("Movies");
  });
  it("rejects an empty name", () => {
    expect(() => validateLibraryInput({ name: "" })).toThrow(LibraryValidationError);
  });
  it("rejects a name over 80 chars", () => {
    expect(() => validateLibraryInput({ name: "a".repeat(81) })).toThrow(LibraryValidationError);
  });
});

describe("validateLibraryPatch", () => {
  it("accepts partial name", () => {
    expect(validateLibraryPatch({ name: "X" })).toEqual({ name: "X" });
  });
  it("accepts partial order", () => {
    expect(validateLibraryPatch({ order: 3 })).toEqual({ order: 3 });
  });
  it("accepts empty patch", () => {
    expect(validateLibraryPatch({})).toEqual({});
  });
  it("rejects negative order", () => {
    expect(() => validateLibraryPatch({ order: -1 })).toThrow(LibraryValidationError);
  });
});

describe("validateSourceInput", () => {
  it("accepts a local source", () => {
    const r = validateSourceInput({ kind: "local", path: "/movies" });
    expect(r).toEqual({ kind: "local", path: "/movies" });
  });
  it("rejects a local source with empty path", () => {
    expect(() => validateSourceInput({ kind: "local", path: "" })).toThrow(LibraryValidationError);
  });
  it("accepts an smb source", () => {
    const r = validateSourceInput({ kind: "smb", host: "nas", share: "media", username: "u", password: "p" });
    expect(r).toMatchObject({ kind: "smb", host: "nas", share: "media" });
  });
  it("rejects an smb source missing host", () => {
    expect(() => validateSourceInput({ kind: "smb", share: "media" })).toThrow(LibraryValidationError);
  });
  it("rejects an unknown kind", () => {
    expect(() => validateSourceInput({ kind: "nfs", path: "/x" })).toThrow(LibraryValidationError);
  });
});
