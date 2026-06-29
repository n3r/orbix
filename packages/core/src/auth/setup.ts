import { z } from "zod";
import { hashPassword } from "./password";

export class SetupAlreadyCompleteError extends Error {}
export class ValidationError extends Error {}

const InputSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export function isSetupComplete(deps: { countAccounts: () => Promise<number> }): Promise<boolean> {
  return deps.countAccounts().then((n) => n > 0);
}

export async function createAdminAccount(
  input: { email: string; password: string },
  deps: {
    hasAnyAccount: () => Promise<boolean>;
    insert: (a: { email: string; passwordHash: string }) => Promise<{ id: string }>;
  }
): Promise<{ id: string }> {
  const parsed = InputSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.message);
  if (await deps.hasAnyAccount()) throw new SetupAlreadyCompleteError();
  const passwordHash = await hashPassword(parsed.data.password);
  return deps.insert({ email: parsed.data.email, passwordHash });
}
