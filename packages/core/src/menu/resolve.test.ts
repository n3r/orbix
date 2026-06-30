import { describe, it, expect } from "vitest";
import { resolveProfileMenu, type MenuSection } from "./resolve";

const sections: MenuSection[] = [
  { sectionId: "s2", name: "Shows", libraryName: "TV", order: 1 },
  { sectionId: "s1", name: "Movies", libraryName: "Films", order: 0 },
  { sectionId: "s3", name: "Docs", libraryName: "Films", order: 2 },
];

describe("resolveProfileMenu", () => {
  it("returns all sections in default order (order, then library, then name) when no entries", () => {
    const out = resolveProfileMenu(sections, []);
    expect(out.map((s) => s.sectionId)).toEqual(["s1", "s2", "s3"]);
    expect(out[0]).toEqual({ sectionId: "s1", name: "Movies", libraryName: "Films" });
  });

  it("returns entries' sections in position order", () => {
    const out = resolveProfileMenu(sections, [
      { sectionId: "s3", position: 0 },
      { sectionId: "s1", position: 1 },
    ]);
    expect(out.map((s) => s.sectionId)).toEqual(["s3", "s1"]);
  });

  it("drops entries whose section no longer exists", () => {
    const out = resolveProfileMenu(sections, [
      { sectionId: "gone", position: 0 },
      { sectionId: "s2", position: 1 },
    ]);
    expect(out.map((s) => s.sectionId)).toEqual(["s2"]);
  });

  it("breaks order ties by library name then section name", () => {
    const tied: MenuSection[] = [
      { sectionId: "b", name: "B", libraryName: "Zeta", order: 0 },
      { sectionId: "a", name: "A", libraryName: "Alpha", order: 0 },
    ];
    expect(resolveProfileMenu(tied, []).map((s) => s.sectionId)).toEqual(["a", "b"]);
  });
});
