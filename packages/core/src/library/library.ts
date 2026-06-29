import { z } from "zod";

export class LibraryValidationError extends Error {}

const LibrarySchema = z.object({
  name: z.string().min(1).max(80),
});

const SectionSchema = z.object({
  libraryId: z.string().min(1),
  name: z.string().min(1).max(80),
  order: z.number().int().min(0).optional(),
});

const SourceSchema = z.object({
  sectionId: z.string().min(1),
  path: z.string().min(1),
});

export function validateLibraryInput(input: unknown) {
  const r = LibrarySchema.safeParse(input);
  if (!r.success) throw new LibraryValidationError(r.error.message);
  return r.data;
}

export function validateSectionInput(input: unknown) {
  const r = SectionSchema.safeParse(input);
  if (!r.success) throw new LibraryValidationError(r.error.message);
  return r.data;
}

export function validateSourceInput(input: unknown) {
  const r = SourceSchema.safeParse(input);
  if (!r.success) throw new LibraryValidationError(r.error.message);
  return r.data;
}
