import { createHash, randomBytes, randomInt } from "node:crypto";

/** Raw-token prefix — makes leaked tokens grep-able and self-identifying. */
export const DEVICE_TOKEN_PREFIX = "orb_";

/** Unambiguous pairing-code alphabet: no 0/O or 1/I look-alikes. */
export const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Pairing codes and poll tokens expire after 10 minutes. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;

/** sha256 hex digest of a raw device token (the only form ever persisted). */
export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Generates a long-lived device bearer token. The raw token is shown to the
 * client exactly once (pairing redemption); the caller persists only tokenHash.
 */
export function generateDeviceToken(): { token: string; tokenHash: string } {
  const token = DEVICE_TOKEN_PREFIX + randomBytes(32).toString("base64url");
  return { token, tokenHash: hashDeviceToken(token) };
}

/** 6-char human-typeable pairing code (crypto-random, unambiguous alphabet). */
export function generatePairingCode(): string {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)];
  }
  return code;
}
