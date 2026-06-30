import { describe, it, expect } from "vitest";
import { moveItem } from "./menu-order";

describe("moveItem", () => {
  it("moves an item up", () => {
    expect(moveItem(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
  });
  it("moves an item down", () => {
    expect(moveItem(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
  });
  it("is a no-op past the top", () => {
    expect(moveItem(["a", "b"], 0, -1)).toEqual(["a", "b"]);
  });
  it("is a no-op past the bottom", () => {
    expect(moveItem(["a", "b"], 1, 1)).toEqual(["a", "b"]);
  });
  it("does not mutate the input", () => {
    const input = ["a", "b"];
    moveItem(input, 0, 1);
    expect(input).toEqual(["a", "b"]);
  });
});
