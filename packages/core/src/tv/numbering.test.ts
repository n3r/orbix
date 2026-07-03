import { describe, it, expect } from "vitest";
import { assignNumbers } from "./numbering";

describe("assignNumbers", () => {
  it("assigns first-import numbers sorted by country then name (null country last)", () => {
    const out = assignNumbers(0, new Map(), [
      { extId: "b.ru", country: "RU", name: "B Channel" },
      { extId: "a.uk", country: "UK", name: "A Channel" },
      { extId: "a.ru", country: "RU", name: "A Channel" },
      { extId: "m3u-1", country: null, name: "My Playlist Channel" },
    ]);
    expect(out.get("a.ru")).toBe(1);
    expect(out.get("b.ru")).toBe(2);
    expect(out.get("a.uk")).toBe(3);
    expect(out.get("m3u-1")).toBe(4);
  });

  it("keeps existing numbers and appends new channels after the global max", () => {
    const existing = new Map([
      ["a.ru", 2],
      ["b.ru", 5],
    ]);
    const out = assignNumbers(41, existing, [
      { extId: "a.ru", country: "RU", name: "A" },
      { extId: "c.ru", country: "RU", name: "C" },
      { extId: "b.ru", country: "RU", name: "B" },
    ]);
    expect(out.get("a.ru")).toBe(2); // stable — never renumbered
    expect(out.get("b.ru")).toBe(5);
    expect(out.get("c.ru")).toBe(42); // appended after the global max
  });
});
