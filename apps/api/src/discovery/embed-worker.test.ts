/**
 * Tests for the embedding backfill worker.
 *
 * The embedder is injected (deps.embed) so these run offline with no model:
 * - NaN/Inf guard: a non-finite vector must throw and write nothing.
 * - backfill counting: returns processed/skipped totals.
 */

import { describe, it, expect } from "vitest";
import { embedItem, backfillEmbeddings } from "./embed-worker.js";

function fakePrisma(overrides: Record<string, unknown> = {}) {
  return {
    mediaItem: {
      findUnique: async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        title: where.id, // title === id so the injected embedder can branch on it
        overview: null,
        genres: [],
        keywords: [],
      }),
    },
    $executeRawUnsafe: async () => 1,
    ...overrides,
  } as any;
}

describe("embedItem — non-finite vector guard", () => {
  it("throws and writes nothing when the embedder returns a NaN element", async () => {
    let wrote = false;
    const prisma = fakePrisma({
      $executeRawUnsafe: async () => {
        wrote = true;
        return 1;
      },
    });
    const embed = async () => {
      const v = new Array(384).fill(0.1);
      v[5] = NaN;
      return v;
    };
    await expect(embedItem(prisma, "m1", { embed })).rejects.toThrow(/non-finite/i);
    expect(wrote).toBe(false);
  });
});

describe("backfillEmbeddings — counts", () => {
  it("returns processed/skipped totals, skipping items whose embed fails", async () => {
    const prisma = fakePrisma({
      $queryRaw: async () => [{ id: "a" }, { id: "b" }, { id: "c" }],
    });
    const embed = async (text: string) => {
      if (text === "b") throw new Error("boom");
      return new Array(384).fill(0.2);
    };
    const result = await backfillEmbeddings(prisma, { embed });
    expect(result).toEqual({ processed: 2, skipped: 1 });
  });
});
