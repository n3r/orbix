import { z } from "zod";

export class LibraryValidationError extends Error {}

const LibrarySchema = z.object({
  name: z.string().min(1).max(80),
});

const LibraryPatchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  order: z.number().int().min(0).optional(),
});

const LocalSourceSchema = z.object({
  kind: z.literal("local"),
  path: z.string().min(1),
});

const SmbSourceSchema = z.object({
  kind: z.literal("smb"),
  host: z.string().min(1),
  share: z.string().min(1),
  subpath: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  domain: z.string().optional(),
});

const SourceSchema = z.discriminatedUnion("kind", [LocalSourceSchema, SmbSourceSchema]);

export type SourceInput = z.infer<typeof SourceSchema>;

export function validateLibraryInput(input: unknown) {
  const r = LibrarySchema.safeParse(input);
  if (!r.success) throw new LibraryValidationError(r.error.message);
  return r.data;
}

export function validateLibraryPatch(input: unknown): { name?: string; order?: number } {
  const r = LibraryPatchSchema.safeParse(input);
  if (!r.success) throw new LibraryValidationError(r.error.message);
  return r.data;
}

export function validateSourceInput(input: unknown): SourceInput {
  const r = SourceSchema.safeParse(input);
  if (!r.success) throw new LibraryValidationError(r.error.message);
  return r.data;
}
