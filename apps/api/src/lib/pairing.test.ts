import { describe, it, expect } from "vitest";
import { PairingStore } from "./pairing";

function makeStore(startMs = 1_000_000) {
  let nowMs = startMs;
  const store = new PairingStore({ now: () => nowMs });
  return { store, advance: (ms: number) => { nowMs += ms; } };
}

const input = { name: "Living Room", platform: "tvos", ip: "192.168.1.50" };

describe("PairingStore", () => {
  it("initiate returns a 6-char code and a poll token; redeem is pending until approved", () => {
    const { store } = makeStore();
    const res = store.initiate(input);
    expect(res).not.toBe("rate_limited");
    if (res === "rate_limited") throw new Error("unreachable");
    expect(res.code).toHaveLength(6);
    expect(res.pollToken.length).toBeGreaterThan(20);
    expect(res.expiresInSec).toBe(600);
    expect(store.redeem(res.pollToken)).toEqual({ status: "pending" });
  });

  it("lookup finds pending entries by code; markApproved + redeem hands out the token once", () => {
    const { store } = makeStore();
    const res = store.initiate(input);
    if (res === "rate_limited") throw new Error("unreachable");
    expect(store.lookup(res.code)).toEqual({ name: "Living Room", platform: "tvos" });
    expect(store.markApproved(res.code, { deviceToken: "orb_x", deviceId: "d1" })).toBe(true);
    // approved entries are no longer approvable/visible via lookup
    expect(store.lookup(res.code)).toBeNull();
    expect(store.redeem(res.pollToken)).toEqual({ status: "approved", deviceToken: "orb_x", deviceId: "d1" });
    // single-use: second redeem finds nothing
    expect(store.redeem(res.pollToken)).toBeNull();
  });

  it("expires entries after the TTL", () => {
    const { store, advance } = makeStore();
    const res = store.initiate(input);
    if (res === "rate_limited") throw new Error("unreachable");
    advance(10 * 60 * 1000 + 1);
    expect(store.lookup(res.code)).toBeNull();
    expect(store.redeem(res.pollToken)).toBeNull();
    expect(store.markApproved(res.code, { deviceToken: "t", deviceId: "d" })).toBe(false);
  });

  it("rate-limits initiate to 5 per minute per IP and recovers after the window", () => {
    const { store, advance } = makeStore();
    for (let i = 0; i < 5; i++) expect(store.initiate(input)).not.toBe("rate_limited");
    expect(store.initiate(input)).toBe("rate_limited");
    expect(store.initiate({ ...input, ip: "192.168.1.51" })).not.toBe("rate_limited");
    advance(60_001);
    expect(store.initiate(input)).not.toBe("rate_limited");
  });

  it("rate-limits polling to 60 per minute per IP", () => {
    const { store, advance } = makeStore();
    for (let i = 0; i < 60; i++) expect(store.allowPoll("ip1")).toBe(true);
    expect(store.allowPoll("ip1")).toBe(false);
    expect(store.allowPoll("ip2")).toBe(true);
    advance(60_001);
    expect(store.allowPoll("ip1")).toBe(true);
  });

  it("markApproved on an unknown code returns false", () => {
    const { store } = makeStore();
    expect(store.markApproved("XXXXXX", { deviceToken: "t", deviceId: "d" })).toBe(false);
  });

  it("enforces MAX_PENDING across distinct IPs (dodging the per-IP rate limit)", () => {
    const { store } = makeStore();
    for (let i = 0; i < 50; i++) {
      const res = store.initiate({ ...input, ip: "10.0.0." + i });
      expect(res).not.toBe("rate_limited");
    }
    expect(store.initiate({ ...input, ip: "10.0.0.50" })).toBe("rate_limited");
  });
});
