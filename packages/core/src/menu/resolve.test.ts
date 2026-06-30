import { describe, it, expect } from "vitest";
import { resolveProfileMenu, type MenuLibrary } from "./resolve";

const libraries: MenuLibrary[] = [
  { libraryId: "l2", name: "Shows", order: 1 },
  { libraryId: "l1", name: "Movies", order: 0 },
  { libraryId: "l3", name: "Docs", order: 2 },
];

describe("resolveProfileMenu", () => {
  it("returns all libraries in default order (order, then name) when no entries", () => {
    const out = resolveProfileMenu(libraries, []);
    expect(out.map((l) => l.libraryId)).toEqual(["l1", "l2", "l3"]);
    expect(out[0]).toEqual({ libraryId: "l1", name: "Movies" });
  });

  it("returns entries' libraries in position order", () => {
    const out = resolveProfileMenu(libraries, [
      { libraryId: "l3", position: 0 },
      { libraryId: "l1", position: 1 },
    ]);
    expect(out.map((l) => l.libraryId)).toEqual(["l3", "l1"]);
  });

  it("drops entries whose library no longer exists", () => {
    const out = resolveProfileMenu(libraries, [
      { libraryId: "gone", position: 0 },
      { libraryId: "l2", position: 1 },
    ]);
    expect(out.map((l) => l.libraryId)).toEqual(["l2"]);
  });

  it("breaks order ties by name", () => {
    const tied: MenuLibrary[] = [
      { libraryId: "b", name: "Zeta", order: 0 },
      { libraryId: "a", name: "Alpha", order: 0 },
    ];
    expect(resolveProfileMenu(tied, []).map((l) => l.libraryId)).toEqual(["a", "b"]);
  });
});
