import { describe, it, expect } from "vitest";
import { getSetting, setSetting } from "./settings";

function fakeStore() {
  const m = new Map<string, unknown>();
  return {
    read: async (k: string) => (m.has(k) ? { value: m.get(k) } : null),
    write: async (k: string, v: unknown) => { m.set(k, v); },
  };
}

describe("settings", () => {
  it("returns the default when unset", async () => {
    expect(await getSetting("tmdbToken", { fallback: "", read: fakeStore().read })).toBe("");
  });
  it("round-trips a value", async () => {
    const s = fakeStore();
    await setSetting("tmdbToken", "abc", { write: s.write });
    expect(await getSetting("tmdbToken", { fallback: "", read: s.read })).toBe("abc");
  });
});
