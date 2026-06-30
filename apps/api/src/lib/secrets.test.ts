import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret } from "./secrets";

const KEY = "x".repeat(32);

describe("secrets", () => {
  it("round-trips a value", () => {
    const blob = encryptSecret("hunter2", KEY);
    expect(blob).not.toContain("hunter2");
    expect(decryptSecret(blob, KEY)).toBe("hunter2");
  });
  it("produces different ciphertext each call (random IV)", () => {
    expect(encryptSecret("a", KEY)).not.toBe(encryptSecret("a", KEY));
  });
  it("fails to decrypt with the wrong key", () => {
    const blob = encryptSecret("a", KEY);
    expect(() => decryptSecret(blob, "y".repeat(32))).toThrow();
  });
  it("throws on malformed blob", () => {
    expect(() => decryptSecret("nope", KEY)).toThrow();
  });
});
