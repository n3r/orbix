import { describe, it, expect } from "vitest";
import { decideRedirect } from "./decideRedirect";

describe("decideRedirect", () => {
  it("sends to /setup when setup incomplete", () => {
    expect(decideRedirect({ setupComplete: false })).toBe("/setup");
  });
  it("sends to /login on a 401", () => {
    expect(decideRedirect({ setupComplete: true, authError401: true })).toBe("/login");
  });
  it("sends to /profiles when authed but no profile selected", () => {
    expect(decideRedirect({ setupComplete: true, profileSelected: false })).toBe("/profiles");
  });
  it("returns null when setup complete, authed, and a profile is selected", () => {
    expect(decideRedirect({ setupComplete: true, profileSelected: true })).toBeNull();
  });
});
