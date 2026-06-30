import { z } from "zod";
import { hashPassword, verifyPassword } from "../auth/password";

export const hashPin = hashPassword;
export const verifyPin = verifyPassword;

export class ProfileValidationError extends Error {}

/** Supported UI + metadata languages (ISO 639-1). */
export const PROFILE_LANGUAGES = ["en", "es", "de", "pt", "ru", "fr"] as const;

const Schema = z.object({
  name: z.string().min(1).max(40),
  kind: z.enum(["standard", "kids"]),
  maturityCap: z.number().int().min(0).max(21).optional(),
  pin: z.string().regex(/^\d{4}$/).optional(),
  language: z.enum(PROFILE_LANGUAGES).default("en"),
}).refine((v) => v.kind !== "kids" || v.maturityCap !== undefined, { message: "kids profiles need a maturityCap" });

export function validateProfileInput(input: unknown) {
  const r = Schema.safeParse(input);
  if (!r.success) throw new ProfileValidationError(r.error.message);
  return r.data;
}
