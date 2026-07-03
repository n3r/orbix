import { describe, it, expect } from "vitest";
import { PlaySessionRegistry } from "./registry";

const plan = { mode: "remux", audioAction: "copy" } as const;
const input = {
  fileId: "f1", inputPath: "/m.mkv", durationSec: 100, plan,
  boundaries: null, forceKeyframes: false, media: null,
};

function makeReg(opts: { ttlMs?: number; max?: number } = {}) {
  let nowMs = 1_000_000;
  const reg = new PlaySessionRegistry({ now: () => nowMs, ...opts });
  return { reg, advance: (ms: number) => { nowMs += ms; } };
}

describe("PlaySessionRegistry", () => {
  it("creates entries with unique ids and returns them by id", () => {
    const { reg } = makeReg();
    const a = reg.create(input);
    const b = reg.create(input);
    expect(a.playSessionId).not.toBe(b.playSessionId);
    expect(reg.get(a.playSessionId)?.fileId).toBe("f1");
    expect(reg.get("nope")).toBeNull();
  });

  it("expires idle entries after the TTL and refreshes on access", () => {
    const { reg, advance } = makeReg({ ttlMs: 1000 });
    const a = reg.create(input);
    advance(600);
    expect(reg.get(a.playSessionId)).not.toBeNull(); // touch refreshes
    advance(600);
    expect(reg.get(a.playSessionId)).not.toBeNull();
    advance(1001);
    expect(reg.get(a.playSessionId)).toBeNull();
  });

  it("evicts the least-recently-accessed entry past the cap", () => {
    const { reg, advance } = makeReg({ max: 2 });
    const a = reg.create(input);
    advance(10);
    const b = reg.create(input);
    advance(10);
    reg.get(a.playSessionId); // a is now fresher than b
    advance(10);
    const c = reg.create(input); // evicts b
    expect(reg.get(a.playSessionId)).not.toBeNull();
    expect(reg.get(b.playSessionId)).toBeNull();
    expect(reg.get(c.playSessionId)).not.toBeNull();
    expect(reg.size()).toBe(2);
  });

  it("delete removes the entry", () => {
    const { reg } = makeReg();
    const a = reg.create(input);
    expect(reg.delete(a.playSessionId)).toBe(true);
    expect(reg.get(a.playSessionId)).toBeNull();
    expect(reg.delete(a.playSessionId)).toBe(false);
  });
});
