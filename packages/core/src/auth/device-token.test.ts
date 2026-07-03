import { describe, it, expect } from "vitest";
import {
  generateDeviceToken,
  hashDeviceToken,
  generatePairingCode,
  DEVICE_TOKEN_PREFIX,
  PAIRING_CODE_ALPHABET,
  PAIRING_TTL_MS,
} from "./device-token";

describe("generateDeviceToken", () => {
  it("produces an orb_-prefixed token whose stored hash matches hashDeviceToken", () => {
    const { token, tokenHash } = generateDeviceToken();
    expect(token.startsWith(DEVICE_TOKEN_PREFIX)).toBe(true);
    expect(token.length).toBeGreaterThanOrEqual(DEVICE_TOKEN_PREFIX.length + 43);
    expect(tokenHash).toBe(hashDeviceToken(token));
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces unique tokens", () => {
    const a = generateDeviceToken();
    const b = generateDeviceToken();
    expect(a.token).not.toBe(b.token);
  });
});

describe("hashDeviceToken", () => {
  it("is deterministic", () => {
    expect(hashDeviceToken("orb_x")).toBe(hashDeviceToken("orb_x"));
  });
});

describe("generatePairingCode", () => {
  it("emits 6 chars from the unambiguous alphabet", () => {
    for (let i = 0; i < 50; i++) {
      const code = generatePairingCode();
      expect(code).toHaveLength(6);
      for (const ch of code) expect(PAIRING_CODE_ALPHABET).toContain(ch);
    }
  });
});

describe("PAIRING_TTL_MS", () => {
  it("is 10 minutes", () => {
    expect(PAIRING_TTL_MS).toBe(600_000);
  });
});
