import { describe, it, expect } from "vitest";
import { isSessionValid } from "./session";

describe("isSessionValid", () => {
  const now = new Date("2026-06-29T12:00:00Z");
  it("is valid before expiry", () => {
    expect(isSessionValid({ expiresAt: new Date("2026-06-29T13:00:00Z") }, now)).toBe(true);
  });
  it("is invalid after expiry", () => {
    expect(isSessionValid({ expiresAt: new Date("2026-06-29T11:00:00Z") }, now)).toBe(false);
  });
});
