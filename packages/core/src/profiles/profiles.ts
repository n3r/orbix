import { z } from "zod";

export class ProfileValidationError extends Error {}

const Schema = z.object({
  name: z.string().min(1).max(40),
  kind: z.enum(["standard", "kids"]),
  maturityCap: z.number().int().min(0).max(21).optional(),
  pin: z.string().regex(/^\d{4}$/).optional(),
}).refine((v) => v.kind !== "kids" || v.maturityCap !== undefined, { message: "kids profiles need a maturityCap" });

export function validateProfileInput(input: unknown) {
  const r = Schema.safeParse(input);
  if (!r.success) throw new ProfileValidationError(r.error.message);
  return r.data;
}
