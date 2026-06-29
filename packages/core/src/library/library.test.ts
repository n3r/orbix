import { describe, it, expect } from "vitest";
import { validateSourceInput, validateLibraryInput, validateSectionInput, LibraryValidationError } from "./library";

describe("validateSourceInput", () => {
  it("accepts an absolute path", () => {
    expect(validateSourceInput({ sectionId: "s1", path: "/movies" }).path).toBe("/movies");
  });
  it("rejects an empty path", () => {
    expect(() => validateSourceInput({ sectionId: "s1", path: "" })).toThrow(LibraryValidationError);
  });
});

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

describe("validateSectionInput", () => {
  it("accepts a valid section", () => {
    const r = validateSectionInput({ libraryId: "lib1", name: "Films" });
    expect(r.name).toBe("Films");
    expect(r.libraryId).toBe("lib1");
  });
  it("accepts an optional order", () => {
    const r = validateSectionInput({ libraryId: "lib1", name: "Films", order: 2 });
    expect(r.order).toBe(2);
  });
  it("rejects negative order", () => {
    expect(() => validateSectionInput({ libraryId: "lib1", name: "Films", order: -1 })).toThrow(LibraryValidationError);
  });
  it("rejects empty sectionId in source", () => {
    expect(() => validateSourceInput({ sectionId: "", path: "/movies" })).toThrow(LibraryValidationError);
  });
});
